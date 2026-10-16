import {
  fromFils,
  toFils,
  type XbrlCheck,
  type XbrlCheckCode,
  type XbrlFact,
  type XbrlPreview,
  type XbrlQuery,
} from '@nexera/shared';
import { findCompany } from '../../lib/company-scope';
import { parseDate } from '../../lib/dates';
import { errors } from '../../lib/http-errors';
import type { PrismaClient } from '../../lib/prisma';
import type { Actor } from '../../middleware/authenticate';
import { comparisonRange } from '../reports/advanced-reports.service';

// Until Qayd publishes its own taxonomy, files are prepared against the full IFRS taxonomy.
export const IFRS_TAXONOMY = {
  name: 'IFRS Accounting Taxonomy',
  version: '2025-03-27',
  namespace: 'https://xbrl.ifrs.org/taxonomy/2025-03-27/ifrs-full',
  entryPoint: 'https://xbrl.ifrs.org/taxonomy/2025-03-27/full_ifrs_entry_point_2025-03-27.xsd',
} as const;

// Identifies the company by its commercial registration number. Replace with the scheme Qayd
// requires once it is published.
export const DEFAULT_ENTITY_SCHEME = 'urn:nexera:kw:commercial-registration';

const PREFIX = 'ifrs-full:';

const CURRENT_ASSET_SUBTYPES = new Set([
  'cash',
  'bank',
  'receivable',
  'inventory',
  'prepayment',
  'other_current_asset',
]);

// Property, plant and equipment is reported at its carrying amount. Depreciation is not kept per
// class, so the classes are added into the one element instead of being reported gross.
const PPE_CLASSES = new Set(['Machinery', 'FixturesAndFittings', 'Vehicles', 'OfficeEquipment']);

// Elements worked out from the statements here; tagging an account with one would count twice.
const TOTALS = [
  'CashAndCashEquivalents',
  'TradeAndOtherCurrentReceivables',
  'Inventories',
  'CurrentAssets',
  'NoncurrentAssets',
  'Assets',
  'CurrentLiabilities',
  'NoncurrentLiabilities',
  'Liabilities',
  'Equity',
  'EquityAndLiabilities',
  'Revenue',
  'GrossProfit',
  'ProfitLoss',
  'ComprehensiveIncome',
] as const;
const TOTAL_SET = new Set<string>(TOTALS);

// The order facts are listed in: balance sheet, then income statement.
const ORDER = [
  'PropertyPlantAndEquipment',
  'RightofuseAssets',
  'NoncurrentAssets',
  'CurrentRawMaterialsAndCurrentProductionSupplies',
  'Inventories',
  'CurrentTradeReceivables',
  'OtherCurrentReceivables',
  'TradeAndOtherCurrentReceivables',
  'CurrentPrepayments',
  'OtherCurrentNonfinancialAssets',
  'CashOnHand',
  'BalancesWithBanks',
  'CashAndCashEquivalents',
  'CurrentAssets',
  'Assets',
  'IssuedCapital',
  'StatutoryReserve',
  'OtherReserves',
  'RetainedEarnings',
  'Equity',
  'NoncurrentLeaseLiabilities',
  'NoncurrentProvisionsForEmployeeBenefits',
  'NoncurrentLiabilities',
  'TradeAndOtherCurrentPayablesToTradeSuppliers',
  'CurrentAccruedExpensesAndOtherCurrentLiabilities',
  'ShorttermEmployeeBenefitsAccruals',
  'CurrentAdvances',
  'OtherCurrentPayables',
  'CurrentLeaseLiabilities',
  'CurrentLiabilities',
  'Liabilities',
  'EquityAndLiabilities',
  'RevenueFromSaleOfGoods',
  'RevenueFromRenderingOfServices',
  'Revenue',
  'CostOfSales',
  'GrossProfit',
  'OtherIncome',
];

interface AccountRow {
  id: string;
  code: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  subtype: string;
  taxonomyConcept: string | null;
}

interface Movement {
  debit: bigint;
  credit: bigint;
}

interface Amount {
  value: bigint;
  accounts: string[];
}

interface Figures {
  instant: Map<string, Amount>;
  duration: Map<string, Amount>;
  untagged: string[];
  totalTagged: string[];
  foreign: string[];
  trialBalanced: boolean;
  balanced: boolean;
}

const filsOf = (value: { toFixed(digits: number): string } | null): bigint =>
  value ? toFils(value.toFixed(3)) : 0n;

function add(map: Map<string, Amount>, concept: string, value: bigint, account?: string) {
  const amount = map.get(concept) ?? { value: 0n, accounts: [] };
  amount.value += value;
  if (account) amount.accounts.push(account);
  map.set(concept, amount);
}

function isNoncurrentLiability(account: AccountRow, local: string | null) {
  return (
    account.subtype === 'employee_benefits' ||
    account.subtype.includes('non_current') ||
    (local?.startsWith('Noncurrent') ?? false)
  );
}

// Works out the XBRL elements of one period from the posted balances of each account.
export function computeFigures(
  accounts: AccountRow[],
  upTo: Map<string, Movement>,
  inPeriod: Map<string, Movement>,
): Figures {
  const instant = new Map<string, Amount>();
  const duration = new Map<string, Amount>();
  const untagged: string[] = [];
  const totalTagged: string[] = [];
  const foreign: string[] = [];
  const sums = {
    cash: 0n,
    receivables: 0n,
    inventories: 0n,
    currentAssets: 0n,
    noncurrentAssets: 0n,
    currentLiabilities: 0n,
    noncurrentLiabilities: 0n,
    equity: 0n,
    unclosedProfit: 0n,
    revenue: 0n,
    costOfSales: 0n,
    profit: 0n,
  };
  let debits = 0n;
  let credits = 0n;

  for (const account of accounts) {
    const balance = upTo.get(account.id) ?? { debit: 0n, credit: 0n };
    debits += balance.debit;
    credits += balance.credit;
    const statement = account.type === 'REVENUE' || account.type === 'EXPENSE';
    const movement = statement ? (inPeriod.get(account.id) ?? { debit: 0n, credit: 0n }) : balance;
    const debitNormal = account.type === 'ASSET' || account.type === 'EXPENSE';
    const value = debitNormal ? movement.debit - movement.credit : movement.credit - movement.debit;
    if (statement) sums.unclosedProfit += balance.credit - balance.debit;
    if (value === 0n) continue;

    const concept = account.taxonomyConcept;
    const local = concept?.startsWith(PREFIX) ? concept.slice(PREFIX.length) : null;
    switch (account.type) {
      case 'ASSET':
        if (CURRENT_ASSET_SUBTYPES.has(account.subtype) || local?.startsWith('Current'))
          sums.currentAssets += value;
        else sums.noncurrentAssets += value;
        if (account.subtype === 'cash' || account.subtype === 'bank') sums.cash += value;
        if (account.subtype === 'receivable') sums.receivables += value;
        if (account.subtype === 'inventory') sums.inventories += value;
        break;
      case 'LIABILITY':
        if (isNoncurrentLiability(account, local)) sums.noncurrentLiabilities += value;
        else sums.currentLiabilities += value;
        break;
      case 'EQUITY':
        sums.equity += value;
        break;
      case 'REVENUE':
        sums.profit += value;
        if (account.subtype === 'sales' || account.subtype === 'sales_deduction')
          sums.revenue += value;
        break;
      case 'EXPENSE':
        sums.profit -= value;
        if (account.subtype === 'cost_of_sales') sums.costOfSales += value;
        break;
    }

    if (!concept) untagged.push(account.code);
    else if (!local) foreign.push(account.code);
    else if (TOTAL_SET.has(local)) totalTagged.push(account.code);
    else {
      const element = PPE_CLASSES.has(local) ? 'PropertyPlantAndEquipment' : local;
      add(statement ? duration : instant, element, value, account.code);
    }
  }

  add(instant, 'RetainedEarnings', sums.unclosedProfit);
  if (sums.cash !== 0n) add(instant, 'CashAndCashEquivalents', sums.cash);
  if (sums.receivables !== 0n) add(instant, 'TradeAndOtherCurrentReceivables', sums.receivables);
  if (sums.inventories !== 0n) add(instant, 'Inventories', sums.inventories);
  const liabilities = sums.currentLiabilities + sums.noncurrentLiabilities;
  const equity = sums.equity + sums.unclosedProfit;
  const assets = sums.currentAssets + sums.noncurrentAssets;
  add(instant, 'CurrentAssets', sums.currentAssets);
  add(instant, 'NoncurrentAssets', sums.noncurrentAssets);
  add(instant, 'Assets', assets);
  add(instant, 'CurrentLiabilities', sums.currentLiabilities);
  add(instant, 'NoncurrentLiabilities', sums.noncurrentLiabilities);
  add(instant, 'Liabilities', liabilities);
  add(instant, 'Equity', equity);
  add(instant, 'EquityAndLiabilities', liabilities + equity);
  add(duration, 'Revenue', sums.revenue);
  // Cost of sales is both tagged on accounts and needed for gross profit: keep one figure.
  const costOfSales = duration.get('CostOfSales');
  duration.set('CostOfSales', { value: sums.costOfSales, accounts: costOfSales?.accounts ?? [] });
  add(duration, 'GrossProfit', sums.revenue - sums.costOfSales);
  add(duration, 'ProfitLoss', sums.profit);
  add(duration, 'ComprehensiveIncome', sums.profit);

  return {
    instant,
    duration,
    untagged,
    totalTagged,
    foreign,
    trialBalanced: debits === credits,
    balanced: assets === liabilities + equity,
  };
}

function rank(concept: string, amount: Amount) {
  const position = ORDER.indexOf(concept);
  if (position >= 0) return position;
  return ORDER.length + Number(amount.accounts[0] ?? 0) / 1e6;
}

function factsOf(figures: Figures, period: XbrlFact['period']): XbrlFact[] {
  const list = (map: Map<string, Amount>, instant: boolean) =>
    [...map.entries()]
      .sort(([a, x], [b, y]) => rank(a, x) - rank(b, y))
      .map(([concept, amount]) => ({
        concept: `${PREFIX}${concept}`,
        period,
        instant,
        value: fromFils(amount.value),
        accounts: amount.accounts,
      }));
  return [...list(figures.instant, true), ...list(figures.duration, false)];
}

const escapeXml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Writes the XBRL instance document of a prepared set of facts.
export function instanceXml(preview: XbrlPreview, entityScheme = DEFAULT_ENTITY_SCHEME): string {
  const entity = `<xbrli:entity><xbrli:identifier scheme="${escapeXml(entityScheme)}">${escapeXml(
    preview.crNumber,
  )}</xbrli:identifier></xbrli:entity>`;
  const context = (id: string, period: string) =>
    `  <xbrli:context id="${id}">${entity}<xbrli:period>${period}</xbrli:period></xbrli:context>`;
  const duration = (range: { from: string; to: string }) =>
    `<xbrli:startDate>${range.from}</xbrli:startDate><xbrli:endDate>${range.to}</xbrli:endDate>`;
  const instant = (date: string) => `<xbrli:instant>${date}</xbrli:instant>`;
  const contextOf = (fact: XbrlFact) =>
    `${fact.period === 'current' ? 'CY' : 'PY'}${fact.instant ? '_I' : ''}`;

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance"' +
      ' xmlns:link="http://www.xbrl.org/2003/linkbase"' +
      ' xmlns:xlink="http://www.w3.org/1999/xlink"' +
      ' xmlns:iso4217="http://www.xbrl.org/2003/iso4217"' +
      ` xmlns:ifrs-full="${IFRS_TAXONOMY.namespace}">`,
    `  <link:schemaRef xlink:type="simple" xlink:href="${IFRS_TAXONOMY.entryPoint}"/>`,
    context('CY', duration(preview)),
    context('CY_I', instant(preview.to)),
  ];
  if (preview.prior) {
    lines.push(context('PY', duration(preview.prior)), context('PY_I', instant(preview.prior.to)));
  }
  lines.push(
    `  <xbrli:unit id="${preview.currency}"><xbrli:measure>iso4217:${preview.currency}</xbrli:measure></xbrli:unit>`,
    `  <ifrs-full:NameOfReportingEntityOrOtherMeansOfIdentification contextRef="CY">${escapeXml(
      preview.legalName,
    )}</ifrs-full:NameOfReportingEntityOrOtherMeansOfIdentification>`,
    `  <ifrs-full:DescriptionOfPresentationCurrency contextRef="CY">${preview.currency}</ifrs-full:DescriptionOfPresentationCurrency>`,
  );
  for (const fact of preview.facts) {
    lines.push(
      `  <${fact.concept} contextRef="${contextOf(fact)}" unitRef="${preview.currency}" decimals="3">${fact.value}</${fact.concept}>`,
    );
  }
  lines.push('</xbrli:xbrl>', '');
  return lines.join('\n');
}

export function createXbrlService(deps: { prisma: PrismaClient; entityScheme?: string }) {
  const { prisma } = deps;

  async function movements(companyId: string, date: { gte?: Date; lte: Date }) {
    const groups = await prisma.journalLine.groupBy({
      by: ['accountId'],
      where: { entry: { companyId, status: 'POSTED', date } },
      _sum: { debit: true, credit: true },
    });
    return new Map<string, Movement>(
      groups.map((group) => [
        group.accountId,
        { debit: filsOf(group._sum.debit), credit: filsOf(group._sum.credit) },
      ]),
    );
  }

  async function figuresFor(companyId: string, accounts: AccountRow[], from: string, to: string) {
    const [upTo, inPeriod] = await Promise.all([
      movements(companyId, { lte: parseDate(to) }),
      movements(companyId, { gte: parseDate(from), lte: parseDate(to) }),
    ]);
    return computeFigures(accounts, upTo, inPeriod);
  }

  async function preview(actor: Actor, companyId: string, query: XbrlQuery): Promise<XbrlPreview> {
    const company = await findCompany(prisma, actor.tenantId, companyId);
    if (query.from > query.to) {
      throw errors.rule('INVALID_RANGE', 'The start date is after the end date');
    }
    const from = parseDate(query.from);
    const to = parseDate(query.to);
    const priorRange = comparisonRange(query.from, query.to, 'previousYear');
    const [accounts, earlier, fiscalYear, openPeriods, drafts] = await Promise.all([
      prisma.account.findMany({ where: { companyId }, orderBy: { code: 'asc' } }),
      prisma.journalEntry.count({
        where: { companyId, status: 'POSTED', date: { lt: from } },
      }),
      prisma.fiscalYear.findFirst({ where: { companyId, startDate: from, endDate: to } }),
      prisma.period.count({
        where: { companyId, status: 'OPEN', startDate: { lte: to }, endDate: { gte: from } },
      }),
      prisma.journalEntry.count({
        where: { companyId, status: 'DRAFT', date: { gte: from, lte: to } },
      }),
    ]);
    const current = await figuresFor(companyId, accounts, query.from, query.to);
    const prior =
      earlier > 0 ? await figuresFor(companyId, accounts, priorRange.from, priorRange.to) : null;
    const both = prior ? [current, prior] : [current];
    const codes = (pick: (figures: Figures) => string[]) => [...new Set(both.flatMap(pick))].sort();

    const check = (
      code: XbrlCheckCode,
      severity: XbrlCheck['severity'],
      ok: boolean,
      accounts: string[] = [],
    ): XbrlCheck => ({ code, severity, ok, accounts });
    const untagged = codes((figures) => figures.untagged);
    const totalTagged = codes((figures) => figures.totalTagged);
    const foreign = codes((figures) => figures.foreign);
    const checks = [
      check(
        'TRIAL_BALANCE_BALANCED',
        'error',
        both.every((figures) => figures.trialBalanced),
      ),
      check(
        'BALANCE_SHEET_BALANCED',
        'error',
        both.every((figures) => figures.balanced),
      ),
      check('ALL_BALANCES_TAGGED', 'error', untagged.length === 0, untagged),
      check('NO_TOTALS_TAGGED', 'error', totalTagged.length === 0, totalTagged),
      check('IFRS_ELEMENTS_ONLY', 'error', foreign.length === 0, foreign),
      check('FULL_FINANCIAL_YEAR', 'warning', fiscalYear !== null),
      check('PERIODS_CLOSED', 'warning', openPeriods === 0),
      check('NO_DRAFTS', 'warning', drafts === 0),
    ];

    return {
      companyId: company.id,
      legalName: company.legalName,
      crNumber: company.crNumber,
      currency: company.baseCurrency,
      from: query.from,
      to: query.to,
      prior: prior ? priorRange : null,
      taxonomy: {
        name: IFRS_TAXONOMY.name,
        version: IFRS_TAXONOMY.version,
        entryPoint: IFRS_TAXONOMY.entryPoint,
      },
      ready: checks.every((item) => item.ok || item.severity === 'warning'),
      checks,
      facts: [...factsOf(current, 'current'), ...(prior ? factsOf(prior, 'prior') : [])],
    };
  }

  return {
    preview,

    async instance(
      actor: Actor,
      companyId: string,
      query: XbrlQuery,
    ): Promise<{ xml: string; fileName: string }> {
      const prepared = await preview(actor, companyId, query);
      if (!prepared.ready) {
        throw errors.rule('XBRL_NOT_READY', 'The statements do not pass the XBRL checks yet');
      }
      const safeCr = prepared.crNumber.replace(/[^A-Za-z0-9-]/g, '_');
      return {
        xml: instanceXml(prepared, deps.entityScheme),
        fileName: `${safeCr}_${prepared.to}.xbrl`,
      };
    },
  };
}

export type XbrlService = ReturnType<typeof createXbrlService>;
