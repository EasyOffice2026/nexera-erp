import supertest from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTenant,
  createTestApp,
  createTestPrisma,
  createUser,
  createWorld,
  resetDatabase,
  signIn,
} from './helpers';

const prisma = createTestPrisma();
const api = supertest(createTestApp(prisma));

beforeEach(() => resetDatabase(prisma));
afterAll(() => prisma.$disconnect());

type World = Awaited<ReturnType<typeof createWorld>>;

// The fields these tests read from response bodies.
interface Body {
  id: string;
  number: number;
  reversesId: string | null;
  error: { code: string };
  totals: { debit: string; credit: string };
  rows: unknown;
  netProfit: string;
  totalAssets: string;
  totalEquity: string;
  balanced: boolean;
  closing: string;
}

function sale(world: World, date = '2026-01-15', amount = '100.000') {
  return {
    date,
    description: 'Cash sale',
    reference: 'S-1',
    lines: [
      { accountId: world.account('1110'), branchId: world.branch.id, debit: amount, credit: '0' },
      { accountId: world.account('4110'), branchId: world.branch.id, debit: '0', credit: amount },
    ],
  };
}

async function postedSale(world: World, date?: string, amount?: string) {
  const base = `/api/v1/companies/${world.company.id}/journals`;
  const draft = await api
    .post(base)
    .set(world.auth)
    .send(sale(world, date, amount));
  expect(draft.status).toBe(201);
  const posted = await api.post(`${base}/${(draft.body as Body).id}/post`).set(world.auth);
  expect(posted.status).toBe(200);
  return posted.body as { id: string; number: number; status: string };
}

describe('companies', () => {
  it('seeds the restaurant chart of accounts as a tree', async () => {
    const world = await createWorld(prisma, api);
    const res = await api.get(`/api/v1/companies/${world.company.id}/accounts`).set(world.auth);
    expect(res.status).toBe(200);
    const accounts = res.body as { code: string; parentId: string | null; isPostable: boolean }[];
    expect(accounts.length).toBeGreaterThan(50);
    const cash = accounts.find((account) => account.code === '1110')!;
    expect(cash.isPostable).toBe(true);
    expect(cash.parentId).not.toBeNull();
  });

  it('keeps tenants apart', async () => {
    const acme = await createWorld(prisma, api, 'acme');
    const other = await createWorld(prisma, api, 'other');
    const res = await api.get(`/api/v1/companies/${acme.company.id}`).set(other.auth);
    expect(res.status).toBe(404);
    const list = await api.get('/api/v1/companies').set(other.auth);
    expect((list.body as { id: string }[]).map((c) => c.id)).toEqual([other.company.id]);
  });

  it('refuses duplicate CR numbers in a tenant', async () => {
    const world = await createWorld(prisma, api);
    const res = await api
      .post('/api/v1/companies')
      .set(world.auth)
      .send({ name: { en: 'Again', ar: 'مرة' }, legalName: 'Again', crNumber: 'CR-acme' });
    expect(res.status).toBe(409);
  });

  it('lets only managers create companies', async () => {
    const tenant = await createTenant(prisma);
    const accountant = await createUser(prisma, tenant.id, 'accountant');
    const auth = await signIn(api, 'acme', accountant.email);
    const res = await api
      .post('/api/v1/companies')
      .set(auth)
      .send({ name: { en: 'X', ar: 'س' }, legalName: 'X', crNumber: 'CR-X' });
    expect(res.status).toBe(403);
  });
});

describe('accounts', () => {
  it('protects accounts that are in use', async () => {
    const world = await createWorld(prisma, api);
    await postedSale(world);
    const base = `/api/v1/companies/${world.company.id}/accounts`;
    expect((await api.delete(`${base}/${world.account('1110')}`).set(world.auth)).status).toBe(409);
    const header = await api.delete(`${base}/${world.account('1100')}`).set(world.auth);
    expect(header.status).toBe(409);
  });

  it('creates an account under a header of the same type', async () => {
    const world = await createWorld(prisma, api);
    const base = `/api/v1/companies/${world.company.id}/accounts`;
    const res = await api
      .post(base)
      .set(world.auth)
      .send({
        code: '1119',
        name: { en: 'Petty cash 2', ar: 'عهدة 2' },
        type: 'ASSET',
        subtype: 'cash',
        parentId: world.account('1100'),
      });
    expect(res.status).toBe(201);
    const wrongType = await api
      .post(base)
      .set(world.auth)
      .send({
        code: '4199',
        name: { en: 'Odd', ar: 'غريب' },
        type: 'REVENUE',
        subtype: 'sales',
        parentId: world.account('1100'),
      });
    expect(wrongType.status).toBe(422);
  });
});

describe('journals', () => {
  it('numbers posted journals one after another', async () => {
    const world = await createWorld(prisma, api);
    const first = await postedSale(world);
    const second = await postedSale(world);
    expect(first.status).toBe('POSTED');
    expect([first.number, second.number]).toEqual([1, 2]);
  });

  it('keeps unbalanced journals as drafts', async () => {
    const world = await createWorld(prisma, api);
    const base = `/api/v1/companies/${world.company.id}/journals`;
    const input = sale(world);
    input.lines[1]!.credit = '99.999';
    const draft = await api.post(base).set(world.auth).send(input);
    expect(draft.status).toBe(201);
    const res = await api.post(`${base}/${(draft.body as Body).id}/post`).set(world.auth);
    expect(res.status).toBe(422);
    expect((res.body as Body).error.code).toBe('JOURNAL_UNBALANCED');
  });

  it('refuses a branch of another company', async () => {
    const world = await createWorld(prisma, api);
    const otherCompany = (
      await api
        .post('/api/v1/companies')
        .set(world.auth)
        .send({ name: { en: 'B', ar: 'ب' }, legalName: 'B', crNumber: 'CR-B', useTemplate: false })
    ).body as { id: string };
    const otherBrand = (
      await api
        .post(`/api/v1/companies/${otherCompany.id}/brands`)
        .set(world.auth)
        .send({ name: { en: 'B', ar: 'ب' } })
    ).body as { id: string };
    const otherBranch = (
      await api
        .post(`/api/v1/companies/${otherCompany.id}/branches`)
        .set(world.auth)
        .send({ brandId: otherBrand.id, code: 'X1', name: { en: 'X', ar: 'س' } })
    ).body as { id: string };
    const input = sale(world);
    input.lines[0]!.branchId = otherBranch.id;
    const res = await api
      .post(`/api/v1/companies/${world.company.id}/journals`)
      .set(world.auth)
      .send(input);
    expect(res.status).toBe(422);
  });

  it('never changes a posted journal and reverses it instead', async () => {
    const world = await createWorld(prisma, api);
    const base = `/api/v1/companies/${world.company.id}/journals`;
    const posted = await postedSale(world);
    expect((await api.put(`${base}/${posted.id}`).set(world.auth).send(sale(world))).status).toBe(
      409,
    );
    expect((await api.delete(`${base}/${posted.id}`).set(world.auth)).status).toBe(409);

    const reversal = await api
      .post(`${base}/${posted.id}/reverse`)
      .set(world.auth)
      .send({ date: '2026-01-20' });
    expect(reversal.status).toBe(201);
    expect((reversal.body as Body).number).toBe(2);
    expect((reversal.body as Body).reversesId).toBe(posted.id);
    const again = await api
      .post(`${base}/${posted.id}/reverse`)
      .set(world.auth)
      .send({ date: '2026-01-21' });
    expect(again.status).toBe(409);

    const tb = await api
      .get(`/api/v1/companies/${world.company.id}/reports/trial-balance`)
      .set(world.auth)
      .query({ from: '2026-01-01', to: '2026-12-31' });
    expect((tb.body as Body).totals.debit).toBe((tb.body as Body).totals.credit);
    const cash = (
      (tb.body as Body).rows as { code: string; closingDebit: string; closingCredit: string }[]
    ).find((row) => row.code === '1110');
    expect(
      cash === undefined || (cash.closingDebit === '0.000' && cash.closingCredit === '0.000'),
    ).toBe(true);
  });

  it('refuses posting into a closed period', async () => {
    const world = await createWorld(prisma, api);
    const base = `/api/v1/companies/${world.company.id}`;
    const january = world.year.periods.find((period) => period.number === 1)!;
    const draft = await api.post(`${base}/journals`).set(world.auth).send(sale(world));
    // A period with drafts in it cannot close.
    const blocked = await api
      .patch(`${base}/periods/${january.id}`)
      .set(world.auth)
      .send({ status: 'CLOSED' });
    expect(blocked.status).toBe(422);
    await api
      .delete(`${base}/journals/${(draft.body as Body).id}`)
      .set(world.auth)
      .expect(204);

    await api
      .patch(`${base}/periods/${january.id}`)
      .set(world.auth)
      .send({ status: 'CLOSED' })
      .expect(200);
    const late = await api.post(`${base}/journals`).set(world.auth).send(sale(world));
    expect(late.status).toBe(422);
  });

  it('lets auditors read but not write', async () => {
    const world = await createWorld(prisma, api);
    const auditor = await createUser(prisma, world.tenant.id, 'auditor', 'auditor@acme.com');
    const auth = await signIn(api, 'acme', auditor.email);
    const base = `/api/v1/companies/${world.company.id}/journals`;
    expect((await api.get(base).set(auth)).status).toBe(200);
    expect((await api.post(base).set(auth).send(sale(world))).status).toBe(403);
  });
});

describe('reports', () => {
  it('produces statements that agree with each other', async () => {
    const world = await createWorld(prisma, api);
    await postedSale(world, '2026-01-15', '250.500');
    const base = `/api/v1/companies/${world.company.id}/reports`;

    const income = await api
      .get(`${base}/income-statement`)
      .set(world.auth)
      .query({ from: '2026-01-01', to: '2026-12-31' });
    expect(income.status).toBe(200);
    expect((income.body as Body).netProfit).toBe('250.500');

    const balance = await api
      .get(`${base}/balance-sheet`)
      .set(world.auth)
      .query({ asOf: '2026-12-31' });
    expect(balance.status).toBe(200);
    expect((balance.body as Body).totalAssets).toBe('250.500');
    expect((balance.body as Body).totalEquity).toBe('250.500');
    expect((balance.body as Body).balanced).toBe(true);

    const ledger = await api
      .get(`${base}/ledger/${world.account('1110')}`)
      .set(world.auth)
      .query({ from: '2026-01-01', to: '2026-12-31' });
    expect(ledger.status).toBe(200);
    expect((ledger.body as Body).closing).toBe('250.500');
  });

  it('filters by branch', async () => {
    const world = await createWorld(prisma, api);
    await postedSale(world);
    const other = (
      await api
        .post(`/api/v1/companies/${world.company.id}/branches`)
        .set(world.auth)
        .send({ brandId: world.brand.id, code: 'B2', name: { en: 'Branch 2', ar: 'فرع 2' } })
    ).body as { id: string };
    const res = await api
      .get(`/api/v1/companies/${world.company.id}/reports/income-statement`)
      .set(world.auth)
      .query({ from: '2026-01-01', to: '2026-12-31', branchId: other.id });
    expect((res.body as Body).netProfit).toBe('0.000');
  });
});
