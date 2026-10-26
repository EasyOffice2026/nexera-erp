import supertest from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import {
  createTestApp,
  createTestPrisma,
  createWorld,
  resetDatabase,
  testConfig,
  testHasher,
} from './helpers';

const prisma = createTestPrisma();
const api = supertest(
  createApp({
    prisma,
    config: testConfig({ CRM_INTEGRATION_POSTING_ENABLED: 'true' }),
    hasher: testHasher,
  }),
);
const base = '/api/v1/integrations/crm';
beforeEach(() => resetDatabase(prisma));
afterAll(() => prisma.$disconnect());
type World = Awaited<ReturnType<typeof createWorld>>;

async function credential(world: World) {
  const response = await api
    .post(`/api/v1/companies/${world.company.id}/crm-integration`)
    .set(world.auth);
  expect(response.status).toBe(201);
  return { authorization: `Bearer ${(response.body as { token: string }).token}` };
}

function input(world: World, externalId = 'invoice:1') {
  return {
    currency: 'KWD',
    externalId,
    date: '2026-01-15',
    description: 'CRM invoice',
    reference: 'INV-1',
    lines: [
      { accountId: world.account('1260'), debit: '100.000', credit: '0' },
      { accountId: world.account('4110'), debit: '0', credit: '100.000' },
    ],
  };
}

describe('one-company CRM integration', () => {
  it('binds a service credential to the authorized tenant and company, not request parameters', async () => {
    const world = await createWorld(prisma, api);
    const other = await createWorld(prisma, api, 'other');
    const denied = await api
      .post(`/api/v1/companies/${world.company.id}/crm-integration`)
      .set(other.auth);
    expect(denied.status).toBe(404);
    const auth = await credential(world);
    const response = await api.get(`${base}/connection?companyId=${other.company.id}`).set(auth);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ tenantId: world.tenant.id, companyId: world.company.id });
    const accounts = await api.get(`${base}/accounts`).set(auth);
    expect(
      (accounts.body as { companyId: string }[]).every((row) => row.companyId === world.company.id),
    ).toBe(true);
    expect((await api.get('/api/v1/users').set(auth)).status).toBe(401);
    expect((await api.get(`${base}/connection`).set(world.auth)).status).toBe(401);
    expect((await api.get(`${base}/connection`)).status).toBe(401);
  });

  it('stores only a token hash and revokes the previous credential on rotation', async () => {
    const world = await createWorld(prisma, api);
    const auth = await credential(world);
    const row = await prisma.crmIntegration.findUniqueOrThrow({
      where: { companyId: world.company.id },
    });
    expect(row.tokenHash).toHaveLength(64);
    expect(auth.authorization).not.toContain(row.tokenHash);
    const next = await credential(world);
    expect((await api.get(`${base}/connection`).set(auth)).status).toBe(401);
    expect((await api.get(`${base}/connection`).set(next)).status).toBe(200);
    await prisma.tenant.update({ where: { id: world.tenant.id }, data: { isActive: false } });
    expect((await api.get(`${base}/connection`).set(next)).status).toBe(401);
  });

  it('posts exactly once on retries and rejects reuse with different content', async () => {
    const world = await createWorld(prisma, api);
    const auth = await credential(world);
    const first = await api.post(`${base}/journals`).set(auth).send(input(world));
    expect(first.status).toBe(201);
    const retry = await api.post(`${base}/journals`).set(auth).send(input(world));
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ ...(first.body as object), duplicate: true });
    const changed = await api
      .post(`${base}/journals`)
      .set(auth)
      .send({ ...input(world), description: 'Changed' });
    expect(changed.status).toBe(409);
    expect(await prisma.journalEntry.count({ where: { companyId: world.company.id } })).toBe(1);
    const trial = await api.get(`${base}/trial-balance?from=2026-01-01&to=2026-12-31`).set(auth);
    expect(trial.status).toBe(200);
    expect(trial.body).toMatchObject({
      totals: { closingDebit: '100.000', closingCredit: '100.000' },
    });
  });

  it('serializes concurrent retries without duplicate journal numbers', async () => {
    const world = await createWorld(prisma, api);
    const auth = await credential(world);
    const results = await Promise.all(
      [1, 2].map(() => api.post(`${base}/journals`).set(auth).send(input(world))),
    );
    expect(results.map((res) => res.status).sort()).toEqual([200, 201]);
    expect(await prisma.journalEntry.count({ where: { companyId: world.company.id } })).toBe(1);
  });

  it('rejects foreign accounts, unbalanced journals, closed periods and disabled posting', async () => {
    const world = await createWorld(prisma, api);
    const other = await createWorld(prisma, api, 'other');
    const auth = await credential(world);
    const foreign = input(world);
    foreign.lines[0]!.accountId = other.account('1260');
    expect((await api.post(`${base}/journals`).set(auth).send(foreign)).status).toBe(422);
    const unbalanced = input(world);
    unbalanced.lines[0]!.debit = '101.000';
    expect((await api.post(`${base}/journals`).set(auth).send(unbalanced)).status).toBe(422);
    await prisma.period.updateMany({
      where: { companyId: world.company.id },
      data: { status: 'CLOSED' },
    });
    expect((await api.post(`${base}/journals`).set(auth).send(input(world))).status).toBe(422);
    const disabled = supertest(createTestApp(prisma));
    expect((await disabled.post(`${base}/journals`).set(auth).send(input(world))).status).toBe(403);
    expect(await prisma.journalEntry.count({ where: { companyId: world.company.id } })).toBe(0);
  });
});
