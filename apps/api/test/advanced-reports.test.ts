import type { CashFlowStatement, ColumnIncomeStatement, JournalRegister } from '@nexera/shared';
import supertest from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { comparisonRange, periodSpans } from '../src/modules/reports/advanced-reports.service';
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

interface Entry {
  date: string;
  debit: string;
  credit: string;
  amount: string;
  branchId?: string | null;
  post?: boolean;
  companyId?: string;
}

// Debits the first account and credits the second, by account code.
async function journal(world: World, entry: Entry, account = world.account) {
  const companyId = entry.companyId ?? world.company.id;
  const base = `/api/v1/companies/${companyId}/journals`;
  const branchId = entry.branchId === undefined ? world.branch.id : entry.branchId;
  const line = (code: string, side: 'debit' | 'credit') => ({
    accountId: account(code),
    ...(branchId ? { branchId } : {}),
    debit: side === 'debit' ? entry.amount : '0',
    credit: side === 'credit' ? entry.amount : '0',
  });
  const draft = await api
    .post(base)
    .set(world.auth)
    .send({
      date: entry.date,
      description: `${entry.debit}/${entry.credit}`,
      lines: [line(entry.debit, 'debit'), line(entry.credit, 'credit')],
    });
  expect(draft.status).toBe(201);
  if (entry.post === false) return;
  const id = (draft.body as { id: string }).id;
  const posted = await api.post(`${base}/${id}/post`).set(world.auth);
  expect(posted.status).toBe(200);
}

function reports(world: World, path: string, auth = world.auth) {
  return api.get(`/api/v1/companies/${world.company.id}/reports/${path}`).set(auth);
}

describe('date ranges', () => {
  it('compares whole months with the months before and other ranges day for day', () => {
    expect(comparisonRange('2026-02-01', '2026-02-28', 'previousPeriod')).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
    });
    expect(comparisonRange('2026-03-01', '2026-05-31', 'previousPeriod')).toEqual({
      from: '2025-12-01',
      to: '2026-02-28',
    });
    expect(comparisonRange('2026-03-10', '2026-03-19', 'previousPeriod')).toEqual({
      from: '2026-02-28',
      to: '2026-03-09',
    });
    expect(comparisonRange('2028-01-01', '2028-02-29', 'previousYear')).toEqual({
      from: '2027-01-01',
      to: '2027-02-28',
    });
  });

  it('splits a range into calendar quarters cut to the range', () => {
    expect(periodSpans('2026-02-15', '2026-07-10', 'quarter')).toEqual([
      { key: '2026-Q1', from: '2026-02-15', to: '2026-03-31' },
      { key: '2026-Q2', from: '2026-04-01', to: '2026-06-30' },
      { key: '2026-Q3', from: '2026-07-01', to: '2026-07-10' },
    ]);
    expect(periodSpans('2026-01-01', '2026-12-31', 'month')).toHaveLength(12);
    expect(() => periodSpans('2020-01-01', '2026-12-31', 'month')).toThrow();
  });
});

describe('income statement with columns', () => {
  async function seed(world: World) {
    await journal(world, { date: '2026-01-15', debit: '1110', credit: '4110', amount: '100.000' });
    await journal(world, { date: '2026-02-10', debit: '1110', credit: '4110', amount: '50.250' });
    await journal(world, { date: '2026-02-20', debit: '5110', credit: '1110', amount: '20.000' });
    await journal(world, { date: '2026-02-21', debit: '6110', credit: '1110', amount: '5.125' });
    await journal(world, {
      date: '2026-02-22',
      debit: '1110',
      credit: '4110',
      amount: '999.000',
      post: false,
    });
  }

  it('shows a column per month and the total, from posted journals only', async () => {
    const world = await createWorld(prisma, api);
    await seed(world);
    const res = await reports(
      world,
      'income-statement/columns?from=2026-01-01&to=2026-02-28&columns=month',
    );
    expect(res.status).toBe(200);
    const body = res.body as ColumnIncomeStatement;
    expect(body.columns.map((c) => [c.key, c.kind, c.from, c.to])).toEqual([
      ['2026-01', 'period', '2026-01-01', '2026-01-31'],
      ['2026-02', 'period', '2026-02-01', '2026-02-28'],
      ['total', 'total', '2026-01-01', '2026-02-28'],
    ]);
    expect(body.totalRevenue).toEqual(['100.000', '50.250', '150.250']);
    expect(body.totalCostOfSales).toEqual(['0.000', '20.000', '20.000']);
    expect(body.grossProfit).toEqual(['100.000', '30.250', '130.250']);
    expect(body.totalExpenses).toEqual(['0.000', '5.125', '5.125']);
    expect(body.netProfit).toEqual(['100.000', '25.125', '125.125']);
    expect(body.revenue[0]!.accounts[0]).toMatchObject({
      code: '4110',
      amounts: ['100.000', '50.250', '150.250'],
    });
  });

  it('compares with the previous period and the previous year', async () => {
    const world = await createWorld(prisma, api);
    await seed(world);
    const month = await reports(
      world,
      'income-statement/columns?from=2026-02-01&to=2026-02-28&compare=previousPeriod',
    );
    expect(month.status).toBe(200);
    const body = month.body as ColumnIncomeStatement;
    expect(body.columns.map((c) => [c.kind, c.from, c.to])).toEqual([
      ['total', '2026-02-01', '2026-02-28'],
      ['comparison', '2026-01-01', '2026-01-31'],
      ['variance', '2026-02-01', '2026-02-28'],
    ]);
    expect(body.totalRevenue).toEqual(['50.250', '100.000', '-49.750']);
    expect(body.netProfit).toEqual(['25.125', '100.000', '-74.875']);

    const year = await reports(
      world,
      'income-statement/columns?from=2026-01-01&to=2026-02-28&compare=previousYear',
    );
    const yearBody = year.body as ColumnIncomeStatement;
    expect(yearBody.columns[1]).toMatchObject({ from: '2025-01-01', to: '2025-02-28' });
    expect(yearBody.netProfit).toEqual(['125.125', '0.000', '125.125']);
  });

  it('shows a column per branch and per brand, with lines without a branch apart', async () => {
    const world = await createWorld(prisma, api);
    const second = (
      await api
        .post(`/api/v1/companies/${world.company.id}/branches`)
        .set(world.auth)
        .send({ brandId: world.brand.id, code: 'B2', name: { en: 'Branch 2', ar: 'فرع 2' } })
    ).body as { id: string };
    await journal(world, { date: '2026-03-01', debit: '1110', credit: '4110', amount: '70.000' });
    await journal(world, {
      date: '2026-03-02',
      debit: '1110',
      credit: '4110',
      amount: '30.000',
      branchId: second.id,
    });
    await journal(world, {
      date: '2026-03-03',
      debit: '6270',
      credit: '1130',
      amount: '4.000',
      branchId: null,
    });

    const res = await reports(
      world,
      'income-statement/columns?from=2026-03-01&to=2026-03-31&columns=branch',
    );
    expect(res.status).toBe(200);
    const body = res.body as ColumnIncomeStatement;
    expect(body.columns.map((c) => [c.kind, c.branchId])).toEqual([
      ['branch', world.branch.id],
      ['branch', second.id],
      ['unassigned', null],
      ['total', null],
    ]);
    expect(body.totalRevenue).toEqual(['70.000', '30.000', '0.000', '100.000']);
    expect(body.netProfit).toEqual(['70.000', '30.000', '-4.000', '96.000']);

    const brands = await reports(
      world,
      'income-statement/columns?from=2026-03-01&to=2026-03-31&columns=brand',
    );
    const brandBody = brands.body as ColumnIncomeStatement;
    expect(brandBody.columns.map((c) => c.kind)).toEqual(['brand', 'unassigned', 'total']);
    expect(brandBody.totalRevenue).toEqual(['100.000', '0.000', '100.000']);

    const oneBranch = await reports(
      world,
      `income-statement/columns?from=2026-03-01&to=2026-03-31&columns=branch&branchId=${second.id}`,
    );
    const oneBody = oneBranch.body as ColumnIncomeStatement;
    expect(oneBody.columns.map((c) => c.kind)).toEqual(['branch', 'total']);
    expect(oneBody.totalRevenue).toEqual(['30.000', '30.000']);
  });

  it('rejects too many columns and a reversed range', async () => {
    const world = await createWorld(prisma, api);
    expect(
      (await reports(world, 'income-statement/columns?from=2020-01-01&to=2026-12-31&columns=month'))
        .status,
    ).toBe(422);
    expect(
      (await reports(world, 'income-statement/columns?from=2026-02-01&to=2026-01-01')).status,
    ).toBe(422);
  });
});

describe('cash flow statement', () => {
  it('ties profit and balance changes to the change in cash', async () => {
    const world = await createWorld(prisma, api);
    const entries: [string, string, string][] = [
      ['1130', '3100', '1000.000'], // capital paid in
      ['1510', '1130', '300.000'], // kitchen equipment
      ['1210', '4110', '200.000'], // KNET sales not yet settled
      ['1110', '4110', '100.000'], // cash sales
      ['5110', '2110', '80.000'], // food bought on credit
      ['6310', '1590', '10.000'], // depreciation
    ];
    for (const [debit, credit, amount] of entries) {
      await journal(world, { date: '2026-01-20', debit, credit, amount });
    }

    const res = await reports(world, 'cash-flow?from=2026-01-01&to=2026-01-31');
    expect(res.status).toBe(200);
    const body = res.body as CashFlowStatement;
    expect(body.netProfit).toBe('210.000');
    expect(body.operating.lines.map((line) => [line.key, line.amount])).toEqual([
      ['accumulated_depreciation', '10.000'],
      ['receivable', '-200.000'],
      ['payable', '80.000'],
    ]);
    expect(body.operating.total).toBe('100.000');
    expect(body.investing.total).toBe('-300.000');
    expect(body.financing.total).toBe('1000.000');
    expect(body.netChange).toBe('800.000');
    expect(body).toMatchObject({ openingCash: '0.000', closingCash: '800.000', balanced: true });

    const next = (await reports(world, 'cash-flow?from=2026-02-01&to=2026-02-28'))
      .body as CashFlowStatement;
    expect(next).toMatchObject({
      openingCash: '800.000',
      netChange: '0.000',
      closingCash: '800.000',
      balanced: true,
    });
  });
});

describe('journal register', () => {
  it('lists posted journals with their lines, filtered and paged', async () => {
    const world = await createWorld(prisma, api);
    await journal(world, { date: '2026-01-05', debit: '1130', credit: '3100', amount: '500.000' });
    await journal(world, { date: '2026-01-06', debit: '1510', credit: '1130', amount: '120.500' });
    await journal(world, { date: '2026-01-07', debit: '1110', credit: '4110', amount: '40.000' });
    await journal(world, {
      date: '2026-01-08',
      debit: '1110',
      credit: '4110',
      amount: '1.000',
      post: false,
    });

    const all = (await reports(world, 'journal-register?from=2026-01-01&to=2026-01-31'))
      .body as JournalRegister;
    expect(all.total).toBe(3);
    expect(all.entries.map((entry) => entry.number)).toEqual([1, 2, 3]);
    expect(all).toMatchObject({ totalDebit: '660.500', totalCredit: '660.500' });
    expect(all.entries[1]!.lines.map((line) => [line.code, line.debit, line.credit])).toEqual([
      ['1510', '120.500', '0.000'],
      ['1130', '0.000', '120.500'],
    ]);
    expect(all.entries[1]!.lines[0]!.branchName).toEqual({ en: 'Branch 1', ar: 'فرع 1' });

    const bank = (
      await reports(
        world,
        `journal-register?from=2026-01-01&to=2026-01-31&accountId=${world.account('1130')}`,
      )
    ).body as JournalRegister;
    expect(bank.entries.map((entry) => entry.number)).toEqual([1, 2]);
    expect(bank.totalDebit).toBe('620.500');

    const page = (
      await reports(world, 'journal-register?from=2026-01-01&to=2026-01-31&pageSize=2&page=2')
    ).body as JournalRegister;
    expect(page).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(page.entries.map((entry) => entry.number)).toEqual([3]);
  });
});

describe('access', () => {
  it('lets an auditor read and keeps other tenants out', async () => {
    const world = await createWorld(prisma, api);
    const auditor = await createUser(prisma, world.tenant.id, 'auditor', 'auditor@acme.com');
    const auditorAuth = await signIn(api, 'acme', auditor.email);
    const other = await createWorld(prisma, api, 'other');

    for (const path of [
      'income-statement/columns?from=2026-01-01&to=2026-01-31',
      'cash-flow?from=2026-01-01&to=2026-01-31',
      'journal-register?from=2026-01-01&to=2026-01-31',
    ]) {
      expect((await reports(world, path, auditorAuth)).status).toBe(200);
      expect((await reports(world, path, other.auth)).status).toBe(404);
    }
    const foreignBranch = await reports(
      world,
      `journal-register?from=2026-01-01&to=2026-01-31&branchId=${other.branch.id}`,
    );
    expect(foreignBranch.status).toBe(404);
  });
});

describe('group income statement', () => {
  it('adds up the companies of the tenant only', async () => {
    const world = await createWorld(prisma, api);
    const second = (
      await api
        .post('/api/v1/companies')
        .set(world.auth)
        .send({
          name: { en: 'Second Co', ar: 'شركة ثانية' },
          legalName: 'Second WLL',
          crNumber: 'CR-2',
        })
    ).body as { id: string };
    await api
      .post(`/api/v1/companies/${second.id}/fiscal-years`)
      .set(world.auth)
      .send({ startDate: '2026-01-01' });
    const secondAccounts = await prisma.account.findMany({ where: { companyId: second.id } });
    const secondAccount = (code: string) => secondAccounts.find((a) => a.code === code)!.id;

    await journal(world, { date: '2026-01-10', debit: '1110', credit: '4110', amount: '100.000' });
    await journal(
      world,
      {
        date: '2026-01-10',
        debit: '1110',
        credit: '4110',
        amount: '40.000',
        branchId: null,
        companyId: second.id,
      },
      secondAccount,
    );
    const other = await createWorld(prisma, api, 'other');
    await journal(other, { date: '2026-01-10', debit: '1110', credit: '4110', amount: '9.000' });

    const res = await api
      .get('/api/v1/reports/group/income-statement?from=2026-01-01&to=2026-01-31')
      .set(world.auth);
    expect(res.status).toBe(200);
    const body = res.body as ColumnIncomeStatement;
    expect(body.columns.map((c) => [c.kind, c.companyId])).toEqual([
      ['company', world.company.id],
      ['company', second.id],
      ['total', null],
    ]);
    expect(body.totalRevenue).toEqual(['100.000', '40.000', '140.000']);
    expect(body.revenue[0]!.accounts[0]).toMatchObject({ accountId: null, code: '4110' });
  });
});
