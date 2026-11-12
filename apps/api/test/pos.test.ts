import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from 'jose';
import supertest from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { createTestPrisma, createWorld, resetDatabase, testConfig, testHasher } from './helpers';

// The link with the POS (docs/unified-platform.md): connection, branch links, posting of the
// business days and goods receipts, and single sign-on.
const prisma = createTestPrisma();
const POS_BRAND = '01990000-0000-7000-8000-0000000000b1';
const POS_BRANCH = '01990000-0000-7000-8000-0000000000c1';
const SUPPLIER = '01990000-0000-7000-8000-0000000000d1';
const KEY = 'posk_test-key-0123456789';

let day: Record<string, unknown>;
let receipts: Record<string, unknown>[];
let calls: string[];

const posFetch = ((input: string | URL, init?: RequestInit) => {
  const url = new URL(input);
  calls.push(url.pathname);
  const auth = new Headers(init?.headers).get('authorization');
  if (auth !== `Bearer ${KEY}`) return Promise.resolve(new Response('{}', { status: 401 }));
  const body =
    url.pathname === '/api/v1/accounting/structure'
      ? {
          brands: [
            {
              id: POS_BRAND,
              name: { en: 'Pizza', ar: 'بيتزا' },
              paymentMethods: [{ key: 'cash', name: { en: 'Cash', ar: 'نقدي' } }],
              branches: [{ id: POS_BRANCH, name: { en: 'Mall', ar: 'مول' }, isActive: true }],
            },
          ],
        }
      : url.pathname === '/api/v1/accounting/days'
        ? { days: [day] }
        : { receipts };
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}) as typeof fetch;

const app = createApp({
  prisma,
  config: testConfig({ PUBLIC_URL: 'https://erp.test' }),
  hasher: testHasher,
  log: () => {},
  posFetch,
});
const api = supertest(app);

beforeEach(async () => {
  await resetDatabase(prisma);
  calls = [];
  day = {
    id: `day:${POS_BRANCH}:2026-03-10`,
    brandId: POS_BRAND,
    branchId: POS_BRANCH,
    businessDate: '2026-03-10',
    orders: 3,
    gross: '27.000',
    discounts: '2.000',
    net: '25.000',
    payments: [
      { method: 'cash', amount: '5.000', commission: '0.000' },
      { method: 'talabat', amount: '20.000', commission: '3.600' },
    ],
    refunds: [],
    cashDifference: '-0.500',
    costOfSales: '8.250',
    waste: '0.000',
    countDifference: '0.000',
  };
  receipts = [
    {
      id: 'grn:01990000-0000-7000-8000-0000000000e1',
      number: 7,
      branchId: POS_BRANCH,
      businessDate: '2026-03-10',
      invoiceNumber: 'INV-9',
      total: '40.000',
      supplier: { id: SUPPLIER, name: 'Fresh Foods', paymentDays: 30 },
    },
  ];
});
afterAll(() => prisma.$disconnect());

type World = Awaited<ReturnType<typeof createWorld>>;

async function connect(world: World) {
  const res = await api
    .put('/api/v1/pos/connection')
    .set(world.auth)
    .send({ apiUrl: 'https://pos-api.test/', webUrl: 'https://pos.test', key: KEY });
  expect(res.status).toBe(200);
  const links = await api
    .put('/api/v1/pos/branch-links')
    .set(world.auth)
    .send({
      links: [{ posBranchId: POS_BRANCH, posBrandId: POS_BRAND, branchId: world.branch.id }],
    });
  expect(links.status).toBe(200);
}

const sync = (world: World) =>
  api.post('/api/v1/pos/sync').set(world.auth).send({ from: '2026-03-10', to: '2026-03-10' });

async function balances(world: World) {
  const lines = await prisma.journalLine.findMany({
    where: { entry: { companyId: world.company.id, status: 'POSTED' } },
    include: { account: { select: { code: true } } },
  });
  const by = new Map<string, number>();
  for (const line of lines) {
    const value = Number(line.debit) - Number(line.credit);
    by.set(line.account.code, Math.round(((by.get(line.account.code) ?? 0) + value) * 1000) / 1000);
  }
  return Object.fromEntries([...by].filter(([, value]) => value !== 0));
}

describe('POS connection', () => {
  it('checks the key before keeping it, and never shows it', async () => {
    const world = await createWorld(prisma, api);
    const bad = await api
      .put('/api/v1/pos/connection')
      .set(world.auth)
      .send({ apiUrl: 'https://pos-api.test', webUrl: 'https://pos.test', key: 'posk_wrong-key' });
    expect(bad.status).toBe(422);
    await connect(world);
    const res = await api.get('/api/v1/pos/connection').set(world.auth);
    expect(res.body).toMatchObject({ connection: { apiUrl: 'https://pos-api.test' } });
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    const stored = await prisma.posConnection.findFirstOrThrow();
    expect(stored.keyCiphertext).not.toContain(KEY);

    const structure = await api.get('/api/v1/pos/structure').set(world.auth);
    expect(
      (structure.body as { brands: { branches: unknown[] }[] }).brands[0]?.branches[0],
    ).toMatchObject({ erpBranchId: world.branch.id });
  });
});

describe('POS sync', () => {
  it('posts each business day and goods receipt once', async () => {
    const world = await createWorld(prisma, api);
    await connect(world);
    const first = await sync(world);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ posted: 2, unchanged: 0, unmapped: 0, failed: 0, unlinked: 0 });
    expect(await balances(world)).toEqual({
      '1110': 4.5,
      '1230': 16.4,
      '5150': 3.6,
      '4810': 2,
      '4120': -27,
      '6270': 0.5,
      '5110': 8.25,
      '1310': 31.75,
      '2110': -40,
    });
    const party = await prisma.subledgerParty.findFirstOrThrow();
    expect(party).toMatchObject({ sourceSystem: 'pos', name: 'Fresh Foods' });

    expect((await sync(world)).body).toMatchObject({ posted: 0, unchanged: 2 });
  });

  it('reverses and posts again when a day changes', async () => {
    const world = await createWorld(prisma, api);
    await connect(world);
    await sync(world);
    day = { ...day, refunds: [{ method: 'cash', amount: '1.000', commission: '0.000' }] };
    expect((await sync(world)).body).toMatchObject({ posted: 1, unchanged: 1 });
    const reversals = await prisma.journalEntry.count({ where: { source: 'REVERSAL' } });
    expect(reversals).toBe(1);
    const totals = await balances(world);
    expect(totals['4820']).toBe(1);
    expect(totals['1110']).toBe(3.5);
  });

  it('waits for accounts that are not there, and skips branches not linked', async () => {
    const world = await createWorld(prisma, api);
    await connect(world);
    await prisma.account.updateMany({
      where: { companyId: world.company.id, code: '5150' },
      data: { isActive: false },
    });
    const res = await sync(world);
    expect(res.body).toMatchObject({ posted: 1, unmapped: 1 });
    const docs = await api.get('/api/v1/pos/documents?status=unmapped').set(world.auth);
    expect((docs.body as { error: string }[])[0]?.error).toContain('commission');

    await api
      .put('/api/v1/pos/branch-links')
      .set(world.auth)
      .send({ links: [{ posBranchId: POS_BRANCH, posBrandId: POS_BRAND, branchId: null }] });
    expect((await sync(world)).body).toMatchObject({ unlinked: 2 });
  });
});

describe('single sign-on into the POS', () => {
  it('gives a one-minute ticket for the person, signed with the published key', async () => {
    const world = await createWorld(prisma, api);
    await connect(world);
    const res = await api.post('/api/v1/pos/sso').set(world.auth);
    expect(res.status).toBe(200);
    const url = (res.body as { url: string }).url;
    expect(url.startsWith('https://pos.test/sso#ticket=')).toBe(true);
    const jwks = (await api.get('/api/v1/sso/jwks.json')).body as JSONWebKeySet;
    const { payload } = await jwtVerify(url.split('#ticket=')[1] ?? '', createLocalJWKSet(jwks), {
      issuer: 'https://erp.test',
      audience: 'pos',
    });
    expect(payload.email).toBe(world.owner.email);
  });
});
