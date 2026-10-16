import {
  type AccountLedger,
  type AccountSubtype,
  type BalanceSheet,
  type BalanceSheetQuery,
  fromFils,
  type IncomeStatement,
  type ReportQuery,
  type StatementLine,
  toFils,
  type TrialBalance,
  type TrialBalanceRow,
} from '@nexera/shared';
import { asName, findCompany } from '../../lib/company-scope';
import { formatDate, parseDate } from '../../lib/dates';
import { errors } from '../../lib/http-errors';
import type { PrismaClient } from '../../lib/prisma';
import type { Actor } from '../../middleware/authenticate';
import type { Prisma } from '../../generated/prisma/client';

type AccountRow = Prisma.AccountGetPayload<object>;
type Scope = { branchId?: string | undefined; brandId?: string | undefined };
type DateRange = { gte?: Date; lt?: Date; lte?: Date };

const filsOf = (value: Prisma.Decimal | null | undefined) =>
  value ? toFils(value.toFixed(3)) : 0n;

// Debit minus credit, per account. Only posted journals count.
interface Movement {
  debit: bigint;
  credit: bigint;
}

function scopeFilter(scope: Scope): Prisma.JournalLineWhereInput {
  return {
    ...(scope.branchId ? { branchId: scope.branchId } : {}),
    ...(scope.brandId ? { branch: { brandId: scope.brandId } } : {}),
  };
}

const incomeKeys: AccountSubtype[] = ['sales', 'sales_deduction', 'other_income'];
const expenseKeys: AccountSubtype[] = [
  'operating_expense',
  'depreciation',
  'finance_cost',
  'other_expense',
];

export function createReportsService(deps: { prisma: PrismaClient }) {
  const { prisma } = deps;

  async function movements(
    companyId: string,
    date: DateRange,
    scope: Scope,
  ): Promise<Map<string, Movement>> {
    const groups = await prisma.journalLine.groupBy({
      by: ['accountId'],
      where: {
        entry: { companyId, status: 'POSTED', date },
        ...scopeFilter(scope),
      },
      _sum: { debit: true, credit: true },
    });
    return new Map(
      groups.map((group) => [
        group.accountId,
        { debit: filsOf(group._sum.debit), credit: filsOf(group._sum.credit) },
      ]),
    );
  }

  async function accountsOf(companyId: string): Promise<AccountRow[]> {
    return prisma.account.findMany({ where: { companyId }, orderBy: { code: 'asc' } });
  }

  async function checkScope(companyId: string, scope: Scope) {
    if (scope.branchId) {
      const branch = await prisma.branch.findFirst({ where: { id: scope.branchId, companyId } });
      if (!branch) throw errors.notFound('Branch');
    }
    if (scope.brandId) {
      const brand = await prisma.brand.findFirst({ where: { id: scope.brandId, companyId } });
      if (!brand) throw errors.notFound('Brand');
    }
  }

  function checkRange(from: string, to: string) {
    if (from > to) throw errors.rule('INVALID_RANGE', 'The start date is after the end date');
  }

  // Groups accounts by subtype, each amount on the side the group normally sits on.
  function statementLines(
    accounts: AccountRow[],
    totals: Map<string, Movement>,
    keys: readonly AccountSubtype[],
    debitNormal: boolean,
  ): { lines: StatementLine[]; total: bigint } {
    const lines: StatementLine[] = [];
    let total = 0n;
    for (const key of keys) {
      let amount = 0n;
      const rows: StatementLine['accounts'] = [];
      for (const account of accounts) {
        if (account.subtype !== key) continue;
        const movement = totals.get(account.id);
        if (!movement) continue;
        const value = debitNormal
          ? movement.debit - movement.credit
          : movement.credit - movement.debit;
        if (value === 0n) continue;
        amount += value;
        rows.push({
          accountId: account.id,
          code: account.code,
          name: asName(account.name),
          amount: fromFils(value),
        });
      }
      if (rows.length === 0) continue;
      total += amount;
      lines.push({ key, amount: fromFils(amount), accounts: rows });
    }
    return { lines, total };
  }

  return {
    async trialBalance(actor: Actor, companyId: string, query: ReportQuery): Promise<TrialBalance> {
      await findCompany(prisma, actor.tenantId, companyId);
      checkRange(query.from, query.to);
      await checkScope(companyId, query);
      const from = parseDate(query.from);
      const to = parseDate(query.to);
      const [accounts, opening, period] = await Promise.all([
        accountsOf(companyId),
        movements(companyId, { lt: from }, query),
        movements(companyId, { gte: from, lte: to }, query),
      ]);

      const sums = {
        openingDebit: 0n,
        openingCredit: 0n,
        periodDebit: 0n,
        periodCredit: 0n,
        closingDebit: 0n,
        closingCredit: 0n,
      };
      const rows: TrialBalanceRow[] = [];
      for (const account of accounts) {
        const before = opening.get(account.id) ?? { debit: 0n, credit: 0n };
        const during = period.get(account.id) ?? { debit: 0n, credit: 0n };
        const openingNet = before.debit - before.credit;
        const closingNet = openingNet + during.debit - during.credit;
        if (openingNet === 0n && during.debit === 0n && during.credit === 0n) continue;
        const row = {
          openingDebit: openingNet > 0n ? openingNet : 0n,
          openingCredit: openingNet < 0n ? -openingNet : 0n,
          periodDebit: during.debit,
          periodCredit: during.credit,
          closingDebit: closingNet > 0n ? closingNet : 0n,
          closingCredit: closingNet < 0n ? -closingNet : 0n,
        };
        for (const key of Object.keys(sums) as (keyof typeof sums)[]) sums[key] += row[key];
        rows.push({
          accountId: account.id,
          code: account.code,
          name: asName(account.name),
          type: account.type,
          subtype: account.subtype as AccountSubtype,
          openingDebit: fromFils(row.openingDebit),
          openingCredit: fromFils(row.openingCredit),
          periodDebit: fromFils(row.periodDebit),
          periodCredit: fromFils(row.periodCredit),
          closingDebit: fromFils(row.closingDebit),
          closingCredit: fromFils(row.closingCredit),
        });
      }
      return {
        from: query.from,
        to: query.to,
        rows,
        totals: {
          openingDebit: fromFils(sums.openingDebit),
          openingCredit: fromFils(sums.openingCredit),
          periodDebit: fromFils(sums.periodDebit),
          periodCredit: fromFils(sums.periodCredit),
          closingDebit: fromFils(sums.closingDebit),
          closingCredit: fromFils(sums.closingCredit),
        },
      };
    },

    // Balances are debit minus credit: positive is a debit balance, negative a credit balance.
    async ledger(
      actor: Actor,
      companyId: string,
      accountId: string,
      query: ReportQuery,
    ): Promise<AccountLedger> {
      await findCompany(prisma, actor.tenantId, companyId);
      checkRange(query.from, query.to);
      await checkScope(companyId, query);
      const account = await prisma.account.findFirst({ where: { id: accountId, companyId } });
      if (!account) throw errors.notFound('Account');
      const from = parseDate(query.from);
      const to = parseDate(query.to);
      const base = { accountId, ...scopeFilter(query) };

      const [before, lines] = await Promise.all([
        prisma.journalLine.aggregate({
          where: { ...base, entry: { companyId, status: 'POSTED', date: { lt: from } } },
          _sum: { debit: true, credit: true },
        }),
        prisma.journalLine.findMany({
          where: { ...base, entry: { companyId, status: 'POSTED', date: { gte: from, lte: to } } },
          include: {
            entry: {
              select: { id: true, number: true, date: true, description: true, reference: true },
            },
          },
          orderBy: [{ entry: { date: 'asc' } }, { entry: { number: 'asc' } }, { lineNo: 'asc' }],
        }),
      ]);

      const opening = filsOf(before._sum.debit) - filsOf(before._sum.credit);
      let balance = opening;
      const rows = lines.map((line) => {
        const debit = filsOf(line.debit);
        const credit = filsOf(line.credit);
        balance += debit - credit;
        return {
          journalId: line.entry.id,
          number: line.entry.number,
          date: formatDate(line.entry.date),
          description: line.description || line.entry.description,
          reference: line.entry.reference,
          branchId: line.branchId,
          debit: fromFils(debit),
          credit: fromFils(credit),
          balance: fromFils(balance),
        };
      });
      return {
        accountId,
        code: account.code,
        name: asName(account.name),
        from: query.from,
        to: query.to,
        opening: fromFils(opening),
        rows,
        closing: fromFils(balance),
      };
    },

    async incomeStatement(
      actor: Actor,
      companyId: string,
      query: ReportQuery,
    ): Promise<IncomeStatement> {
      await findCompany(prisma, actor.tenantId, companyId);
      checkRange(query.from, query.to);
      await checkScope(companyId, query);
      const [accounts, totals] = await Promise.all([
        accountsOf(companyId),
        movements(companyId, { gte: parseDate(query.from), lte: parseDate(query.to) }, query),
      ]);
      const revenue = statementLines(accounts, totals, incomeKeys, false);
      const cost = statementLines(accounts, totals, ['cost_of_sales'], true);
      const expenses = statementLines(accounts, totals, expenseKeys, true);
      const grossProfit = revenue.total - cost.total;
      return {
        from: query.from,
        to: query.to,
        revenue: revenue.lines,
        totalRevenue: fromFils(revenue.total),
        costOfSales: fromFils(cost.total),
        grossProfit: fromFils(grossProfit),
        expenses: expenses.lines,
        totalExpenses: fromFils(expenses.total),
        netProfit: fromFils(grossProfit - expenses.total),
      };
    },

    // Until year-end closing entries exist, all profit to date shows as current-year profit.
    async balanceSheet(
      actor: Actor,
      companyId: string,
      query: BalanceSheetQuery,
    ): Promise<BalanceSheet> {
      await findCompany(prisma, actor.tenantId, companyId);
      await checkScope(companyId, query);
      const [accounts, totals] = await Promise.all([
        accountsOf(companyId),
        movements(companyId, { lte: parseDate(query.asOf) }, query),
      ]);
      const subtypesOf = (type: AccountRow['type']) => [
        ...new Set(accounts.filter((a) => a.type === type).map((a) => a.subtype as AccountSubtype)),
      ];
      const assets = statementLines(accounts, totals, subtypesOf('ASSET'), true);
      const liabilities = statementLines(accounts, totals, subtypesOf('LIABILITY'), false);
      const equity = statementLines(accounts, totals, subtypesOf('EQUITY'), false);

      let profit = 0n;
      for (const account of accounts) {
        if (account.type !== 'REVENUE' && account.type !== 'EXPENSE') continue;
        const movement = totals.get(account.id);
        if (!movement) continue;
        profit += movement.credit - movement.debit;
      }
      const totalEquity = equity.total + profit;
      return {
        asOf: query.asOf,
        assets: assets.lines,
        totalAssets: fromFils(assets.total),
        liabilities: liabilities.lines,
        totalLiabilities: fromFils(liabilities.total),
        equity: equity.lines,
        currentYearProfit: fromFils(profit),
        totalEquity: fromFils(totalEquity),
        balanced: assets.total === liabilities.total + totalEquity,
      };
    },
  };
}

export type ReportsService = ReturnType<typeof createReportsService>;
