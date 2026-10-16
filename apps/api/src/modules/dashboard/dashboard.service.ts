import {
  type Dashboard,
  type DashboardAmount,
  type DashboardBreakdown,
  type DashboardFigures,
  type DashboardQuery,
  fromFils,
  toFils,
} from '@nexera/shared';
import { asName, findCompany } from '../../lib/company-scope';
import { addDays, addMonths, formatDate, parseDate } from '../../lib/dates';
import { errors } from '../../lib/http-errors';
import type { PrismaClient } from '../../lib/prisma';
import type { Actor } from '../../middleware/authenticate';

// Posted movements of one account and branch in one month, as exact decimal text.
interface MonthRow {
  month: string;
  accountId: string;
  branchId: string | null;
  debit: string;
  credit: string;
}

interface Totals {
  revenue: bigint;
  costOfSales: bigint;
  expenses: bigint;
}

const monthStart = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
const monthKey = (date: Date) => formatDate(date).slice(0, 7);
const monthEnd = (date: Date) => addDays(addMonths(monthStart(date), 1), -1);

const decimalText = (value: { toFixed(digits: number): string } | null) => value?.toFixed(3) ?? '0';

// One aggregate per month from the first month up to asOf. A financial year has twelve months,
// so the twelve months of the trend also cover the year to date.
async function monthRows(
  prisma: PrismaClient,
  companyId: string,
  from: Date,
  asOf: Date,
  lineScope: { branchId?: string },
): Promise<MonthRow[]> {
  const months: Date[] = [];
  for (let month = from; month <= asOf; month = addMonths(month, 1)) months.push(month);
  const groups = await Promise.all(
    months.map((month) =>
      prisma.journalLine.groupBy({
        by: ['accountId', 'branchId'],
        where: {
          entry: {
            companyId,
            status: 'POSTED',
            date: { gte: month, lte: monthEnd(month) < asOf ? monthEnd(month) : asOf },
          },
          ...lineScope,
        },
        _sum: { debit: true, credit: true },
      }),
    ),
  );
  return groups.flatMap((rows, index) =>
    rows.map((row) => ({
      month: monthKey(months[index] as Date),
      accountId: row.accountId,
      branchId: row.branchId,
      debit: decimalText(row._sum.debit),
      credit: decimalText(row._sum.credit),
    })),
  );
}

// The first day of the financial year that contains the date.
function yearStart(date: Date, yearEndMonth: number): Date {
  const startMonth = yearEndMonth % 12;
  const year = date.getUTCMonth() >= startMonth ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  return new Date(Date.UTC(year, startMonth, 1));
}

function figures(totals: Totals): DashboardFigures {
  const gross = totals.revenue - totals.costOfSales;
  return {
    revenue: fromFils(totals.revenue),
    costOfSales: fromFils(totals.costOfSales),
    grossProfit: fromFils(gross),
    expenses: fromFils(totals.expenses),
    netProfit: fromFils(gross - totals.expenses),
  };
}

function add<K>(map: Map<K, bigint>, key: K, value: bigint) {
  map.set(key, (map.get(key) ?? 0n) + value);
}

// Largest first, without zero rows.
function ranked(rows: { row: Omit<DashboardAmount, 'amount'>; fils: bigint }[], limit?: number) {
  return rows
    .filter((entry) => entry.fils !== 0n)
    .sort((a, b) => (a.fils === b.fils ? 0 : a.fils > b.fils ? -1 : 1))
    .slice(0, limit)
    .map((entry) => ({ ...entry.row, amount: fromFils(entry.fils) }));
}

export function createDashboardService(deps: { prisma: PrismaClient }) {
  const { prisma } = deps;

  return {
    async get(actor: Actor, companyId: string, query: DashboardQuery): Promise<Dashboard> {
      const company = await findCompany(prisma, actor.tenantId, companyId);
      const branchId = query.branchId ?? null;
      if (branchId) {
        const branch = await prisma.branch.findFirst({ where: { id: branchId, companyId } });
        if (!branch) throw errors.notFound('Branch');
      }

      const asOf = parseDate(query.asOf);
      const thisMonth = monthStart(asOf);
      const lastMonth = addMonths(thisMonth, -1);
      const fiscalStart = yearStart(asOf, company.fiscalYearEndMonth);
      const trendStart = addMonths(thisMonth, -11);
      const lineScope = branchId ? { branchId } : {};

      const [accounts, branches, brands, rows, balances, draftJournals, unclosed, period] =
        await Promise.all([
          prisma.account.findMany({ where: { companyId } }),
          prisma.branch.findMany({ where: { companyId } }),
          prisma.brand.findMany({ where: { companyId } }),
          monthRows(prisma, companyId, trendStart, asOf, lineScope),
          prisma.journalLine.groupBy({
            by: ['accountId'],
            where: {
              entry: { companyId, status: 'POSTED', date: { lte: asOf } },
              account: { subtype: { in: ['cash', 'bank', 'receivable', 'payable'] } },
              ...lineScope,
            },
            _sum: { debit: true, credit: true },
          }),
          prisma.journalEntry.count({ where: { companyId, status: 'DRAFT' } }),
          prisma.period.count({ where: { companyId, status: 'OPEN', endDate: { lt: thisMonth } } }),
          prisma.period.findFirst({
            where: { companyId, startDate: { lte: asOf }, endDate: { gte: asOf } },
            select: { status: true },
          }),
        ]);

      const accountOf = new Map(accounts.map((account) => [account.id, account]));
      const branchOf = new Map(branches.map((branch) => [branch.id, branch]));
      const moves = rows.flatMap((row) => {
        const account = accountOf.get(row.accountId);
        if (!account) return [];
        return [{ ...row, account, net: toFils(row.debit) - toFils(row.credit) }];
      });

      const totals = (include: (month: string) => boolean): Totals => {
        const sums = { revenue: 0n, costOfSales: 0n, expenses: 0n };
        for (const move of moves) {
          if (!include(move.month)) continue;
          if (move.account.type === 'REVENUE') sums.revenue -= move.net;
          else if (move.account.type !== 'EXPENSE') continue;
          else if (move.account.subtype === 'cost_of_sales') sums.costOfSales += move.net;
          else sums.expenses += move.net;
        }
        return sums;
      };

      const breakdown = (include: (month: string) => boolean): DashboardBreakdown => {
        const byBranch = new Map<string | null, bigint>();
        const byAccount = new Map<string, bigint>();
        for (const move of moves) {
          if (!include(move.month)) continue;
          if (move.account.type === 'REVENUE') {
            add(byBranch, move.branchId, -move.net);
            if (move.account.subtype === 'sales') add(byAccount, move.accountId, -move.net);
          } else if (move.account.type === 'EXPENSE') {
            add(byAccount, move.accountId, move.net);
          }
        }
        const byBrand = new Map<string | null, bigint>();
        for (const [id, fils] of byBranch) {
          add(byBrand, id ? (branchOf.get(id)?.brandId ?? null) : null, fils);
        }
        const accountRows = (type: 'REVENUE' | 'EXPENSE') =>
          [...byAccount].flatMap(([id, fils]) => {
            const account = accountOf.get(id);
            if (account?.type !== type) return [];
            return [{ row: { id, code: account.code, name: asName(account.name) }, fils }];
          });
        return {
          revenueByBranch: ranked(
            [...byBranch].map(([id, fils]) => {
              const branch = id ? branchOf.get(id) : undefined;
              return {
                row: { id, code: branch?.code ?? null, name: branch ? asName(branch.name) : null },
                fils,
              };
            }),
          ),
          revenueByBrand: ranked(
            [...byBrand].map(([id, fils]) => {
              const brand = brands.find((candidate) => candidate.id === id);
              return { row: { id, code: null, name: brand ? asName(brand.name) : null }, fils };
            }),
          ),
          revenueByChannel: ranked(accountRows('REVENUE')),
          topExpenses: ranked(accountRows('EXPENSE'), 6),
        };
      };

      const current = monthKey(thisMonth);
      const previous = monthKey(lastMonth);
      const fiscalKey = monthKey(fiscalStart);
      const inYear = (month: string) => month >= fiscalKey;
      const inMonth = (month: string) => month === current;

      let cashTotal = 0n;
      let receivables = 0n;
      let payables = 0n;
      const cashRows: { row: Omit<DashboardAmount, 'amount'>; fils: bigint }[] = [];
      for (const balance of balances) {
        const account = accountOf.get(balance.accountId);
        if (!account) continue;
        const net =
          toFils(decimalText(balance._sum.debit)) - toFils(decimalText(balance._sum.credit));
        if (account.subtype === 'receivable') receivables += net;
        else if (account.subtype === 'payable') payables -= net;
        else {
          cashTotal += net;
          cashRows.push({
            row: { id: account.id, code: account.code, name: asName(account.name) },
            fils: net,
          });
        }
      }

      return {
        asOf: query.asOf,
        spans: {
          month: { from: formatDate(thisMonth), to: query.asOf },
          previousMonth: { from: formatDate(lastMonth), to: formatDate(monthEnd(lastMonth)) },
          yearToDate: { from: formatDate(fiscalStart), to: query.asOf },
        },
        figures: {
          month: figures(totals(inMonth)),
          previousMonth: figures(totals((month) => month === previous)),
          yearToDate: figures(totals(inYear)),
        },
        breakdown: { month: breakdown(inMonth), yearToDate: breakdown(inYear) },
        cash: { total: fromFils(cashTotal), accounts: ranked(cashRows) },
        receivables: fromFils(receivables),
        payables: fromFils(payables),
        trend: Array.from({ length: 12 }, (_, index) => {
          const key = monthKey(addMonths(trendStart, index));
          const sums = totals((month) => month === key);
          const expenses = sums.costOfSales + sums.expenses;
          return {
            month: key,
            revenue: fromFils(sums.revenue),
            expenses: fromFils(expenses),
            netProfit: fromFils(sums.revenue - expenses),
          };
        }),
        alerts: {
          draftJournals,
          unclosedPastPeriods: unclosed,
          periodOpen: period?.status === 'OPEN',
        },
      };
    },
  };
}

export type DashboardService = ReturnType<typeof createDashboardService>;
