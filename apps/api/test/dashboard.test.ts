import type { Dashboard } from '@nexera/shared';
import supertest from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
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

// Debits the first account and credits the second.
async function journal(
  world: World,
  date: string,
  debit: string,
  credit: string,
  amount: string,
  post = true,
) {
  const base = `/api/v1/companies/${world.company.id}/journals`;
  const line = (accountId: string, side: 'debit' | 'credit') => ({
    accountId,
    branchId: world.branch.id,
    debit: side === 'debit' ? amount : '0',
    credit: side === 'credit' ? amount : '0',
  });
  const draft = await api
    .post(base)
    .set(world.auth)
    .send({ date, description: 'Test', lines: [line(debit, 'debit'), line(credit, 'credit')] });
  expect(draft.status).toBe(201);
  if (!post) return;
  const posted = await api
    .post(`${base}/${(draft.body as { id: string }).id}/post`)
    .set(world.auth);
  expect(posted.status).toBe(200);
}

async function dashboard(world: World, asOf: string, auth = world.auth) {
  return api.get(`/api/v1/companies/${world.company.id}/dashboard?asOf=${asOf}`).set(auth);
}

async function seedActivity(world: World) {
  const opex = await prisma.account.findFirstOrThrow({
    where: { companyId: world.company.id, subtype: 'operating_expense', isPostable: true },
  });
  const cash = world.account('1110');
  const sales = world.account('4110');
  await journal(world, '2026-01-15', cash, sales, '100.000');
  await journal(world, '2026-02-10', cash, sales, '50.250');
  await journal(world, '2026-02-20', world.account('5110'), cash, '20.000');
  await journal(world, '2026-02-21', opex.id, cash, '5.125');
  return { opex };
}

describe('dashboard', () => {
  it('sums the month, the previous month and the year to date from posted journals', async () => {
    const world = await createWorld(prisma, api);
    await seedActivity(world);
    await journal(
      world,
      '2026-02-22',
      world.account('1110'),
      world.account('4110'),
      '999.000',
      false,
    );

    const res = await dashboard(world, '2026-02-28');
    expect(res.status).toBe(200);
    const body = res.body as Dashboard;

    expect(body.spans.yearToDate).toEqual({ from: '2026-01-01', to: '2026-02-28' });
    expect(body.spans.previousMonth).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    expect(body.figures.month).toEqual({
      revenue: '50.250',
      costOfSales: '20.000',
      grossProfit: '30.250',
      expenses: '5.125',
      netProfit: '25.125',
    });
    expect(body.figures.previousMonth.revenue).toBe('100.000');
    expect(body.figures.yearToDate.netProfit).toBe('125.125');
    expect(body.cash.total).toBe('125.125');
    expect(body.cash.accounts[0]?.code).toBe('1110');

    expect(body.trend).toHaveLength(12);
    expect(body.trend.at(-1)).toEqual({
      month: '2026-02',
      revenue: '50.250',
      expenses: '25.125',
      netProfit: '25.125',
    });
    expect(body.trend.at(-2)?.revenue).toBe('100.000');
    expect(body.trend[0]?.month).toBe('2025-03');

    const month = body.breakdown.month;
    expect(month.revenueByBranch).toEqual([
      { id: world.branch.id, code: 'B1', name: { en: 'Branch 1', ar: 'فرع 1' }, amount: '50.250' },
    ]);
    expect(month.revenueByBrand[0]).toMatchObject({ id: world.brand.id, amount: '50.250' });
    expect(month.revenueByChannel.map((row) => [row.code, row.amount])).toEqual([
      ['4110', '50.250'],
    ]);
    expect(month.topExpenses.map((row) => row.amount)).toEqual(['20.000', '5.125']);
    expect(body.breakdown.yearToDate.revenueByChannel[0]?.amount).toBe('150.250');

    expect(body.alerts).toEqual({ draftJournals: 1, unclosedPastPeriods: 1, periodOpen: true });
  });

  it('filters by branch and flags dates without an open period', async () => {
    const world = await createWorld(prisma, api);
    await seedActivity(world);
    const other = await prisma.branch.create({
      data: {
        tenantId: world.tenant.id,
        companyId: world.company.id,
        brandId: world.brand.id,
        code: 'B2',
        name: { en: 'Branch 2', ar: 'فرع 2' },
      },
    });

    const res = await api
      .get(`/api/v1/companies/${world.company.id}/dashboard?asOf=2026-02-28&branchId=${other.id}`)
      .set(world.auth);
    expect(res.status).toBe(200);
    expect((res.body as Dashboard).figures.yearToDate.revenue).toBe('0.000');

    const later = (await dashboard(world, '2027-03-01')).body as Dashboard;
    expect(later.alerts.periodOpen).toBe(false);
    expect(later.spans.yearToDate.from).toBe('2027-01-01');
    expect(later.figures.yearToDate.revenue).toBe('0.000');
    expect(later.cash.total).toBe('125.125');
  });

  it('is read-only for auditors and private to the tenant', async () => {
    const world = await createWorld(prisma, api);
    const auditor = await createUser(prisma, world.tenant.id, 'auditor', 'auditor@acme.com');
    expect(
      (await dashboard(world, '2026-02-28', await signIn(api, 'acme', auditor.email))).status,
    ).toBe(200);

    const stranger = await createWorld(prisma, api, 'other');
    expect((await dashboard(world, '2026-02-28', stranger.auth)).status).toBe(404);
  });
});
