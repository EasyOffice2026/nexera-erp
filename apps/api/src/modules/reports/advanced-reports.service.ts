import {
  type AccountSubtype,
  type CashFlowLine,
  type CashFlowQuery,
  type CashFlowSection,
  type CashFlowStatement,
  type ColumnAccount,
  type ColumnIncomeStatement,
  type ColumnLine,
  type ComparativeQuery,
  type CompareMode,
  fromFils,
  type GroupReportQuery,
  type JournalRegister,
  type JournalRegisterQuery,
  type LocalizedName,
  type ReportColumn,
  toFils,
} from '@nexera/shared';
import { asName, findCompany } from '../../lib/company-scope';
import { formatDate, parseDate } from '../../lib/dates';
import { errors } from '../../lib/http-errors';
import type { PrismaClient } from '../../lib/prisma';
import type { Actor } from '../../middleware/authenticate';
import type { Prisma } from '../../generated/prisma/client';

type Scope = { branchId?: string | undefined; brandId?: string | undefined };
// Debit minus credit per account key. Only posted journals count.
type Nets = Map<string, bigint>;

interface AccountInfo {
  key: string;
  accountId: string | null;
  code: string;
  name: LocalizedName;
  subtype: string;
}

const DAY = 86_400_000;
export const MAX_COLUMNS = 36;

const filsOf = (value: Prisma.Decimal | null | undefined) =>
  value ? toFils(value.toFixed(3)) : 0n;

const incomeKeys: AccountSubtype[] = ['sales', 'sales_deduction', 'other_income'];
const costKeys: AccountSubtype[] = ['cost_of_sales'];
const expenseKeys: AccountSubtype[] = [
  'operating_expense',
  'depreciation',
  'finance_cost',
  'other_expense',
];

// Where the change in each balance-sheet subtype appears in the cash flow, in display order.
const cashFlowOrder: Record<CashFlowSection, AccountSubtype[]> = {
  operating: [
    'accumulated_depreciation',
    'receivable',
    'inventory',
    'prepayment',
    'other_current_asset',
    'payable',
    'accrued_liability',
    'other_current_liability',
    'employee_benefits',
  ],
  investing: ['fixed_asset', 'right_of_use_asset', 'other_non_current_asset'],
  financing: [
    'lease_liability',
    'other_non_current_liability',
    'share_capital',
    'reserve',
    'retained_earnings',
    'owner_current_account',
  ],
};
const cashSubtypes = new Set<string>(['cash', 'bank']);

function scopeFilter(scope: Scope): Prisma.JournalLineWhereInput {
  return {
    ...(scope.branchId ? { branchId: scope.branchId } : {}),
    ...(scope.brandId ? { branch: { brandId: scope.brandId } } : {}),
  };
}

function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function isMonthEnd(date: Date): boolean {
  return date.getUTCDate() === lastDay(date.getUTCFullYear(), date.getUTCMonth());
}

// The same day some months away; a month-end stays a month-end.
function shiftMonths(date: Date, months: number): Date {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const last = lastDay(target.getUTCFullYear(), target.getUTCMonth());
  const day = isMonthEnd(date) ? last : Math.min(date.getUTCDate(), last);
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day));
}

// Whole months compare with the same number of months before; other ranges with as many days.
export function comparisonRange(
  from: string,
  to: string,
  mode: Exclude<CompareMode, 'none'>,
): { from: string; to: string } {
  const start = parseDate(from);
  const end = parseDate(to);
  if (mode === 'previousYear') {
    return { from: formatDate(shiftMonths(start, -12)), to: formatDate(shiftMonths(end, -12)) };
  }
  if (start.getUTCDate() === 1 && isMonthEnd(end)) {
    const months =
      (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
      end.getUTCMonth() -
      start.getUTCMonth() +
      1;
    return {
      from: formatDate(shiftMonths(start, -months)),
      to: formatDate(shiftMonths(end, -months)),
    };
  }
  const days = Math.round((end.getTime() - start.getTime()) / DAY) + 1;
  return {
    from: formatDate(new Date(start.getTime() - days * DAY)),
    to: formatDate(new Date(start.getTime() - DAY)),
  };
}

// Calendar months or quarters inside the range; the first and last are cut to the range.
export function periodSpans(
  from: string,
  to: string,
  mode: 'month' | 'quarter',
): { key: string; from: string; to: string }[] {
  const start = parseDate(from);
  const end = parseDate(to);
  const step = mode === 'month' ? 1 : 3;
  const firstMonth =
    mode === 'month' ? start.getUTCMonth() : Math.floor(start.getUTCMonth() / 3) * 3;
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), firstMonth, 1));
  const spans: { key: string; from: string; to: string }[] = [];
  while (cursor <= end) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + step, 1));
    const spanEnd = new Date(next.getTime() - DAY);
    const key =
      mode === 'month'
        ? formatDate(cursor).slice(0, 7)
        : `${cursor.getUTCFullYear()}-Q${Math.floor(cursor.getUTCMonth() / 3) + 1}`;
    spans.push({
      key,
      from: formatDate(cursor < start ? start : cursor),
      to: formatDate(spanEnd > end ? end : spanEnd),
    });
    if (spans.length > MAX_COLUMNS) {
      throw errors.rule('TOO_MANY_COLUMNS', `Choose a range of at most ${MAX_COLUMNS} columns`);
    }
    cursor = next;
  }
  return spans;
}

function column(
  value: Pick<ReportColumn, 'key' | 'kind' | 'from' | 'to'> & Partial<ReportColumn>,
): ReportColumn {
  return { name: null, branchId: null, brandId: null, companyId: null, ...value };
}

function difference(a: Nets, b: Nets): Nets {
  const result = new Map(a);
  for (const [key, value] of b) result.set(key, (result.get(key) ?? 0n) - value);
  return result;
}

function addInto(target: Nets, key: string, value: bigint) {
  target.set(key, (target.get(key) ?? 0n) + value);
}

// Groups accounts by subtype; each amount on the side the section normally sits on.
function section(
  infos: AccountInfo[],
  nets: Nets[],
  keys: AccountSubtype[],
  creditNormal: boolean,
): { lines: ColumnLine[]; totals: bigint[] } {
  const lines: ColumnLine[] = [];
  const totals = nets.map(() => 0n);
  for (const key of keys) {
    const sums = nets.map(() => 0n);
    const accounts: ColumnAccount[] = [];
    for (const info of infos) {
      if (info.subtype !== key) continue;
      const values = nets.map((net) => {
        const value = net.get(info.key) ?? 0n;
        return creditNormal ? -value : value;
      });
      if (values.every((value) => value === 0n)) continue;
      values.forEach((value, i) => (sums[i]! += value));
      accounts.push({
        accountId: info.accountId,
        code: info.code,
        name: info.name,
        amounts: values.map(fromFils),
      });
    }
    if (accounts.length === 0) continue;
    sums.forEach((value, i) => (totals[i]! += value));
    lines.push({ key, amounts: sums.map(fromFils), accounts });
  }
  return { lines, totals };
}

function incomeStatement(
  range: { from: string; to: string },
  columns: ReportColumn[],
  infos: AccountInfo[],
  nets: Nets[],
): ColumnIncomeStatement {
  const revenue = section(infos, nets, incomeKeys, true);
  const cost = section(infos, nets, costKeys, false);
  const expenses = section(infos, nets, expenseKeys, false);
  const gross = revenue.totals.map((value, i) => value - cost.totals[i]!);
  const net = gross.map((value, i) => value - expenses.totals[i]!);
  const text = (values: bigint[]) => values.map(fromFils);
  return {
    from: range.from,
    to: range.to,
    columns,
    revenue: revenue.lines,
    totalRevenue: text(revenue.totals),
    costOfSales: cost.lines,
    totalCostOfSales: text(cost.totals),
    grossProfit: text(gross),
    expenses: expenses.lines,
    totalExpenses: text(expenses.totals),
    netProfit: text(net),
  };
}

function checkRange(from: string, to: string) {
  if (from > to) throw errors.rule('INVALID_RANGE', 'The start date is after the end date');
}

export function createAdvancedReportsService(deps: { prisma: PrismaClient }) {
  const { prisma } = deps;

  async function lineGroups(
    companyId: string,
    date: { gte?: Date; lt?: Date; lte?: Date },
    scope: Scope,
  ) {
    const groups = await prisma.journalLine.groupBy({
      by: ['accountId', 'branchId'],
      where: { entry: { companyId, status: 'POSTED', date }, ...scopeFilter(scope) },
      _sum: { debit: true, credit: true },
    });
    return groups.map((group) => ({
      accountId: group.accountId,
      branchId: group.branchId,
      net: filsOf(group._sum.debit) - filsOf(group._sum.credit),
    }));
  }

  async function netsBetween(
    companyId: string,
    from: string,
    to: string,
    scope: Scope = {},
  ): Promise<Nets> {
    const nets: Nets = new Map();
    const groups = await lineGroups(companyId, { gte: parseDate(from), lte: parseDate(to) }, scope);
    for (const group of groups) addInto(nets, group.accountId, group.net);
    return nets;
  }

  async function checkScope(companyId: string, scope: Scope & { accountId?: string | undefined }) {
    if (scope.branchId) {
      const branch = await prisma.branch.findFirst({ where: { id: scope.branchId, companyId } });
      if (!branch) throw errors.notFound('Branch');
    }
    if (scope.brandId) {
      const brand = await prisma.brand.findFirst({ where: { id: scope.brandId, companyId } });
      if (!brand) throw errors.notFound('Brand');
    }
    if (scope.accountId) {
      const account = await prisma.account.findFirst({ where: { id: scope.accountId, companyId } });
      if (!account) throw errors.notFound('Account');
    }
  }

  async function profitAndLossAccounts(companyId: string): Promise<AccountInfo[]> {
    const accounts = await prisma.account.findMany({
      where: { companyId, type: { in: ['REVENUE', 'EXPENSE'] } },
      orderBy: { code: 'asc' },
    });
    return accounts.map((account) => ({
      key: account.id,
      accountId: account.id,
      code: account.code,
      name: asName(account.name),
      subtype: account.subtype,
    }));
  }

  // A column per branch or brand, plus "unassigned" for lines without a branch.
  async function dimensionColumns(
    companyId: string,
    query: ComparativeQuery,
    mode: 'branch' | 'brand',
  ): Promise<{ columns: ReportColumn[]; nets: Nets[] }> {
    const [groups, branches, brands] = await Promise.all([
      lineGroups(companyId, { gte: parseDate(query.from), lte: parseDate(query.to) }, query),
      prisma.branch.findMany({
        where: {
          companyId,
          ...(query.branchId ? { id: query.branchId } : {}),
          ...(query.brandId ? { brandId: query.brandId } : {}),
        },
        orderBy: { code: 'asc' },
      }),
      prisma.brand.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } }),
    ]);
    const brandOf = new Map(branches.map((branch) => [branch.id, branch.brandId]));
    const buckets = new Map<string, Nets>();
    for (const group of groups) {
      const key =
        mode === 'branch'
          ? (group.branchId ?? '')
          : group.branchId
            ? (brandOf.get(group.branchId) ?? '')
            : '';
      const nets = buckets.get(key) ?? new Map<string, bigint>();
      addInto(nets, group.accountId, group.net);
      buckets.set(key, nets);
    }
    const range = { from: query.from, to: query.to };
    const columns: ReportColumn[] =
      mode === 'branch'
        ? branches.map((branch) =>
            column({
              ...range,
              key: branch.id,
              kind: 'branch',
              name: asName(branch.name),
              branchId: branch.id,
              brandId: branch.brandId,
            }),
          )
        : brands
            .filter((brand) => !query.brandId || brand.id === query.brandId)
            .filter((brand) => !query.branchId || brandOf.get(query.branchId) === brand.id)
            .map((brand) =>
              column({
                ...range,
                key: brand.id,
                kind: 'brand',
                name: asName(brand.name),
                brandId: brand.id,
              }),
            );
    if (buckets.has('')) columns.push(column({ ...range, key: 'unassigned', kind: 'unassigned' }));
    const nets = columns.map(
      (col) => buckets.get(col.kind === 'unassigned' ? '' : col.key) ?? new Map<string, bigint>(),
    );
    return { columns, nets };
  }

  return {
    async comparativeIncomeStatement(
      actor: Actor,
      companyId: string,
      query: ComparativeQuery,
    ): Promise<ColumnIncomeStatement> {
      await findCompany(prisma, actor.tenantId, companyId);
      checkRange(query.from, query.to);
      await checkScope(companyId, query);
      const range = { from: query.from, to: query.to };

      const columns: ReportColumn[] = [];
      const nets: Nets[] = [];
      if (query.columns === 'month' || query.columns === 'quarter') {
        const spans = periodSpans(query.from, query.to, query.columns);
        const values = await Promise.all(
          spans.map((span) => netsBetween(companyId, span.from, span.to, query)),
        );
        spans.forEach((span, i) => {
          columns.push(column({ ...span, kind: 'period' }));
          nets.push(values[i]!);
        });
      } else if (query.columns === 'branch' || query.columns === 'brand') {
        const split = await dimensionColumns(companyId, query, query.columns);
        columns.push(...split.columns);
        nets.push(...split.nets);
      }

      const total = await netsBetween(companyId, query.from, query.to, query);
      columns.push(column({ ...range, key: 'total', kind: 'total' }));
      nets.push(total);
      if (query.compare !== 'none') {
        const previous = comparisonRange(query.from, query.to, query.compare);
        const before = await netsBetween(companyId, previous.from, previous.to, query);
        columns.push(column({ ...previous, key: 'comparison', kind: 'comparison' }));
        nets.push(before);
        columns.push(column({ ...range, key: 'variance', kind: 'variance' }));
        nets.push(difference(total, before));
      }
      return incomeStatement(range, columns, await profitAndLossAccounts(companyId), nets);
    },

    // Every company of the tenant side by side, for management. There are no intercompany
    // eliminations: each company still reports and files on its own.
    async groupIncomeStatement(
      actor: Actor,
      query: GroupReportQuery,
    ): Promise<ColumnIncomeStatement> {
      checkRange(query.from, query.to);
      const companies = await prisma.company.findMany({
        where: { tenantId: actor.tenantId },
        orderBy: { createdAt: 'asc' },
      });
      const range = { from: query.from, to: query.to };
      const previous =
        query.compare === 'none' ? null : comparisonRange(query.from, query.to, query.compare);

      // Accounts of every company add up by subtype and code.
      const infos = new Map<string, AccountInfo>();
      const perCompany = await Promise.all(
        companies.map(async (company) => {
          const [accounts, current, before] = await Promise.all([
            profitAndLossAccounts(company.id),
            netsBetween(company.id, query.from, query.to),
            previous ? netsBetween(company.id, previous.from, previous.to) : null,
          ]);
          const byCode = (nets: Nets) => {
            const result: Nets = new Map();
            for (const account of accounts) {
              const value = nets.get(account.key);
              if (value) addInto(result, `${account.subtype}|${account.code}`, value);
            }
            return result;
          };
          for (const account of accounts) {
            const key = `${account.subtype}|${account.code}`;
            if (!infos.has(key)) infos.set(key, { ...account, key, accountId: null });
          }
          return { company, current: byCode(current), before: before ? byCode(before) : null };
        }),
      );

      const columns: ReportColumn[] = perCompany.map(({ company }) =>
        column({
          ...range,
          key: company.id,
          kind: 'company',
          name: asName(company.name),
          companyId: company.id,
        }),
      );
      const nets: Nets[] = perCompany.map((entry) => entry.current);
      const total: Nets = new Map();
      for (const entry of perCompany)
        for (const [key, value] of entry.current) addInto(total, key, value);
      columns.push(column({ ...range, key: 'total', kind: 'total' }));
      nets.push(total);
      if (previous) {
        const before: Nets = new Map();
        for (const entry of perCompany) {
          for (const [key, value] of entry.before ?? []) addInto(before, key, value);
        }
        columns.push(column({ ...previous, key: 'comparison', kind: 'comparison' }));
        nets.push(before);
        columns.push(column({ ...range, key: 'variance', kind: 'variance' }));
        nets.push(difference(total, before));
      }
      const sorted = [...infos.values()].sort((a, b) => a.code.localeCompare(b.code));
      return incomeStatement(range, columns, sorted, nets);
    },

    async cashFlow(
      actor: Actor,
      companyId: string,
      query: CashFlowQuery,
    ): Promise<CashFlowStatement> {
      await findCompany(prisma, actor.tenantId, companyId);
      checkRange(query.from, query.to);
      const [accounts, before, during] = await Promise.all([
        prisma.account.findMany({ where: { companyId }, orderBy: { code: 'asc' } }),
        lineGroups(companyId, { lt: parseDate(query.from) }, {}),
        netsBetween(companyId, query.from, query.to),
      ]);
      const opening: Nets = new Map();
      for (const group of before) addInto(opening, group.accountId, group.net);

      const sectionOf = new Map<string, CashFlowSection>();
      for (const [name, subtypes] of Object.entries(cashFlowOrder)) {
        for (const subtype of subtypes) sectionOf.set(subtype, name as CashFlowSection);
      }
      let profit = 0n;
      let openingCash = 0n;
      let cashChange = 0n;
      const lines = new Map<string, { amount: bigint; accounts: CashFlowLine['accounts'] }>();
      for (const account of accounts) {
        const net = during.get(account.id) ?? 0n;
        if (cashSubtypes.has(account.subtype)) {
          openingCash += opening.get(account.id) ?? 0n;
          cashChange += net;
          continue;
        }
        if (account.type === 'REVENUE' || account.type === 'EXPENSE') {
          profit -= net;
          continue;
        }
        if (net === 0n) continue;
        // More of an asset uses cash; more of a liability or equity brings it in.
        const effect = -net;
        const line = lines.get(account.subtype) ?? { amount: 0n, accounts: [] };
        line.amount += effect;
        line.accounts.push({
          accountId: account.id,
          code: account.code,
          name: asName(account.name),
          amount: fromFils(effect),
        });
        lines.set(account.subtype, line);
      }

      const build = (name: CashFlowSection, start: bigint) => {
        let total = start;
        const result: CashFlowLine[] = [];
        for (const key of cashFlowOrder[name]) {
          const line = lines.get(key);
          if (!line) continue;
          total += line.amount;
          result.push({ key, amount: fromFils(line.amount), accounts: line.accounts });
        }
        return { lines: result, total };
      };
      const operating = build('operating', profit);
      const investing = build('investing', 0n);
      const financing = build('financing', 0n);
      // Subtypes outside the three sections (none today) would still have to reach the total.
      let unclassified = 0n;
      for (const [key, line] of lines) if (!sectionOf.has(key)) unclassified += line.amount;
      const netChange = operating.total + investing.total + financing.total + unclassified;
      return {
        from: query.from,
        to: query.to,
        netProfit: fromFils(profit),
        operating: { lines: operating.lines, total: fromFils(operating.total) },
        investing: { lines: investing.lines, total: fromFils(investing.total) },
        financing: { lines: financing.lines, total: fromFils(financing.total) },
        netChange: fromFils(netChange),
        openingCash: fromFils(openingCash),
        closingCash: fromFils(openingCash + cashChange),
        balanced: netChange === cashChange,
      };
    },

    async journalRegister(
      actor: Actor,
      companyId: string,
      query: JournalRegisterQuery,
    ): Promise<JournalRegister> {
      await findCompany(prisma, actor.tenantId, companyId);
      checkRange(query.from, query.to);
      await checkScope(companyId, query);
      const lineFilter = {
        ...(query.branchId ? { branchId: query.branchId } : {}),
        ...(query.accountId ? { accountId: query.accountId } : {}),
      };
      const where: Prisma.JournalEntryWhereInput = {
        companyId,
        status: 'POSTED',
        date: { gte: parseDate(query.from), lte: parseDate(query.to) },
        ...(query.source ? { source: query.source } : {}),
        ...(Object.keys(lineFilter).length ? { lines: { some: lineFilter } } : {}),
      };
      const [total, sums, entries] = await Promise.all([
        prisma.journalEntry.count({ where }),
        prisma.journalEntry.aggregate({ where, _sum: { totalDebit: true, totalCredit: true } }),
        prisma.journalEntry.findMany({
          where,
          orderBy: [{ date: 'asc' }, { number: 'asc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          include: {
            lines: {
              orderBy: { lineNo: 'asc' },
              include: {
                account: { select: { code: true, name: true } },
                branch: { select: { name: true } },
              },
            },
          },
        }),
      ]);
      return {
        from: query.from,
        to: query.to,
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalDebit: fromFils(filsOf(sums._sum.totalDebit)),
        totalCredit: fromFils(filsOf(sums._sum.totalCredit)),
        entries: entries.map((entry) => ({
          id: entry.id,
          number: entry.number,
          date: formatDate(entry.date),
          description: entry.description,
          reference: entry.reference,
          source: entry.source,
          totalDebit: fromFils(filsOf(entry.totalDebit)),
          totalCredit: fromFils(filsOf(entry.totalCredit)),
          lines: entry.lines.map((line) => ({
            accountId: line.accountId,
            code: line.account.code,
            name: asName(line.account.name),
            branchId: line.branchId,
            branchName: line.branch ? asName(line.branch.name) : null,
            description: line.description,
            debit: fromFils(filsOf(line.debit)),
            credit: fromFils(filsOf(line.credit)),
          })),
        })),
      };
    },
  };
}

export type AdvancedReportsService = ReturnType<typeof createAdvancedReportsService>;
