import {
  fromFils,
  isSubtypeOf,
  type Journal,
  type JournalInput,
  type JournalLineInput,
  type JournalSummary,
  type LedgerCompany,
  type LedgerSetup,
  type Page,
  type TrialBalance,
  type TrialBalanceRow,
  localizedNameSchema,
  toFils,
  type listJournalsQuerySchema,
} from '@nexera/shared';
import type { z } from 'zod';
import { Prisma } from '../../generated/prisma/client';
import { writeAudit } from '../../lib/audit';
import { formatDate, parseDate } from '../../lib/dates';
import { errors } from '../../lib/http-errors';
import { decimalToAmount, decimalToFils } from '../../lib/money';
import type { PrismaClient } from '../../lib/prisma';
import type { Actor } from '../../middleware/authenticate';

type Db = Prisma.TransactionClient;
type JournalQuery = z.infer<typeof listJournalsQuerySchema>;
const detail = {
  reversedBy: { select: { id: true } },
  lines: {
    orderBy: { lineNo: 'asc' },
    include: { account: { select: { code: true, name: true } } },
  },
} as const satisfies Prisma.JournalEntryInclude;
const summary = { reversedBy: { select: { id: true } } } as const;
type SummaryRow = Prisma.JournalEntryGetPayload<{ include: typeof summary }>;
type DetailRow = Prisma.JournalEntryGetPayload<{ include: typeof detail }>;
const maxFils = 999_999_999_999_999_999n;

function toSummary(row: SummaryRow): JournalSummary {
  return {
    id: row.id,
    number: row.number,
    date: formatDate(row.date),
    description: row.description,
    reference: row.reference,
    source: row.source,
    status: row.status,
    totalDebit: decimalToAmount(row.totalDebit),
    reversedById: row.reversedBy?.id ?? null,
  };
}

function toJournal(row: DetailRow): Journal {
  return {
    ...toSummary(row),
    companyId: row.companyId,
    sourceSystem: row.sourceSystem,
    externalId: row.externalId,
    totalCredit: decimalToAmount(row.totalCredit),
    reversesId: row.reversesId,
    createdAt: row.createdAt.toISOString(),
    postedAt: row.postedAt?.toISOString() ?? null,
    lines: row.lines.map((line) => ({
      id: line.id,
      lineNo: line.lineNo,
      accountId: line.accountId,
      branchId: line.branchId,
      accountCode: line.account.code,
      accountName: localizedNameSchema.parse(line.account.name),
      description: line.description,
      debit: decimalToAmount(line.debit),
      credit: decimalToAmount(line.credit),
    })),
  };
}

function scope(actor: Actor, companyId: string) {
  return { tenantId: actor.tenantId, companyId };
}

async function verifyCompany(db: Db, actor: Actor, id: string) {
  const company = await db.company.findFirst({
    where: { id, tenantId: actor.tenantId, isActive: true },
    select: { id: true },
  });
  if (!company) throw errors.notFound('Company');
}

async function findJournal(db: Db, actor: Actor, companyId: string, id: string) {
  const journal = await db.journalEntry.findFirst({
    where: { ...scope(actor, companyId), id },
    include: detail,
  });
  if (!journal) throw errors.notFound('Journal');
  return journal;
}

async function periodFor(db: Db, actor: Actor, companyId: string, date: Date) {
  const periods = await db.period.findMany({
    where: { ...scope(actor, companyId), startDate: { lte: date }, endDate: { gte: date } },
    select: { id: true, status: true, fiscalYear: { select: { status: true } } },
    take: 2,
  });
  const period = periods[0];
  if (!period) throw errors.conflict('NO_PERIOD', 'The journal date has no fiscal period');
  if (periods.length > 1)
    throw errors.conflict(
      'OVERLAPPING_PERIODS',
      'The journal date matches multiple fiscal periods',
    );
  return period;
}

function requireOpen(period: Awaited<ReturnType<typeof periodFor>>) {
  if (period.status !== 'OPEN' || period.fiscalYear.status !== 'OPEN') {
    throw errors.conflict('PERIOD_CLOSED', 'Choose a date in an open fiscal period');
  }
}

function requireDraft(journal: DetailRow) {
  if (journal.status !== 'DRAFT')
    throw errors.conflict('JOURNAL_POSTED', 'Posted journals can only be corrected by reversal');
}

async function validateLines(db: Db, actor: Actor, companyId: string, lines: JournalLineInput[]) {
  const accountIds = [...new Set(lines.map((line) => line.accountId))];
  const branchIds = [...new Set(lines.flatMap((line) => (line.branchId ? [line.branchId] : [])))];
  const [accounts, branches] = await Promise.all([
    db.account.count({
      where: {
        ...scope(actor, companyId),
        id: { in: accountIds },
        isActive: true,
        isPostable: true,
      },
    }),
    db.branch.count({
      where: {
        ...scope(actor, companyId),
        id: { in: branchIds },
        isActive: true,
        brand: { isActive: true },
      },
    }),
  ]);
  if (accounts !== accountIds.length || branches !== branchIds.length) {
    throw errors.conflict(
      'INVALID_JOURNAL_SCOPE',
      'Each line must use an active posting account and, if provided, an active branch in this company',
    );
  }
  const debit = lines.reduce((total, line) => total + toFils(line.debit), 0n);
  const credit = lines.reduce((total, line) => total + toFils(line.credit), 0n);
  if (lines.length < 2 || debit !== credit || debit === 0n) {
    throw errors.conflict(
      'UNBALANCED_JOURNAL',
      'Use at least two lines and match total debits to total credits',
    );
  }
  if (debit > maxFils)
    throw errors.conflict('JOURNAL_AMOUNT_LIMIT', 'Journal totals exceed the supported amount');
  return { totalDebit: fromFils(debit), totalCredit: fromFils(credit) };
}

async function allocateNumber(db: Db, actor: Actor, companyId: string) {
  const company = await db.company.update({
    where: { id: companyId, tenantId: actor.tenantId, isActive: true },
    data: { nextJournalNumber: { increment: 1 } },
    select: { nextJournalNumber: true },
  });
  return company.nextJournalNumber - 1;
}

function audit(
  db: Db,
  actor: Actor,
  action: string,
  entityId: string,
  data?: Prisma.InputJsonObject,
) {
  return writeAudit(db, {
    ...actor,
    action,
    entityType: 'journal',
    entityId,
    ...(data ? { data } : {}),
  });
}

function draftLines(lines: JournalLineInput[]) {
  return lines.map((line, index) => ({ ...line, lineNo: index + 1 }));
}

export function createLedgerService(prisma: PrismaClient) {
  async function mutate<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await prisma.$transaction(work, { isolationLevel: 'Serializable' });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2034')
          throw error;
        if (attempt === 3)
          throw errors.conflict('CONCURRENT_UPDATE', 'The ledger changed. Reload and try again');
      }
    }
  }

  return {
    async listCompanies(actor: Actor): Promise<LedgerCompany[]> {
      const rows = await prisma.company.findMany({
        where: { tenantId: actor.tenantId, isActive: true },
        orderBy: { legalName: 'asc' },
        select: { id: true, name: true, baseCurrency: true },
      });
      return rows.map((row) => ({
        id: row.id,
        name: localizedNameSchema.parse(row.name),
        currency: row.baseCurrency,
      }));
    },

    async setup(actor: Actor, companyId: string): Promise<LedgerSetup> {
      await verifyCompany(prisma, actor, companyId);
      const where = scope(actor, companyId);
      const [accounts, periods] = await Promise.all([
        prisma.account.findMany({
          where,
          orderBy: { code: 'asc' },
          select: {
            id: true,
            code: true,
            name: true,
            type: true,
            subtype: true,
            isActive: true,
            isPostable: true,
          },
        }),
        prisma.period.findMany({
          where,
          orderBy: { startDate: 'desc' },
          select: { id: true, number: true, startDate: true, endDate: true, status: true },
        }),
      ]);
      return {
        accounts: accounts.map((row) => {
          if (!isSubtypeOf(row.type, row.subtype))
            throw new Error(`Invalid account subtype for ${row.id}`);
          return { ...row, subtype: row.subtype, name: localizedNameSchema.parse(row.name) };
        }),
        periods: periods.map((row) => ({
          ...row,
          startDate: formatDate(row.startDate),
          endDate: formatDate(row.endDate),
        })),
      };
    },

    async list(
      actor: Actor,
      companyId: string,
      query: JournalQuery,
    ): Promise<Page<JournalSummary>> {
      await verifyCompany(prisma, actor, companyId);
      const { status, from, to, search, page, pageSize } = query;
      const literal = search?.replace(/[\\%_]/g, '\\$&');
      const numberMatch = search?.match(/^(?:JE-)?(\d{1,10})$/i)?.[1];
      const number = numberMatch ? Number(numberMatch) : 0;
      if (from && to && from > to)
        throw errors.validation({ date: 'The start date must precede the end date' });
      const where: Prisma.JournalEntryWhereInput = {
        ...scope(actor, companyId),
        ...(status ? { status } : {}),
        date: { ...(from ? { gte: parseDate(from) } : {}), ...(to ? { lte: parseDate(to) } : {}) },
        ...(literal
          ? {
              OR: [
                { description: { contains: literal, mode: 'insensitive' } },
                { reference: { contains: literal, mode: 'insensitive' } },
                ...(number > 0 && number <= 2_147_483_647 ? [{ number }] : []),
              ],
            }
          : {}),
      };
      const [items, total] = await prisma.$transaction(
        [
          prisma.journalEntry.findMany({
            where,
            include: summary,
            orderBy: [{ date: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          prisma.journalEntry.count({ where }),
        ],
        { isolationLevel: 'RepeatableRead' },
      );
      return { items: items.map(toSummary), total, page, pageSize };
    },

    async get(actor: Actor, companyId: string, id: string): Promise<Journal> {
      await verifyCompany(prisma, actor, companyId);
      return toJournal(await findJournal(prisma, actor, companyId, id));
    },

    saveDraft(actor: Actor, companyId: string, input: JournalInput, id?: string): Promise<Journal> {
      return mutate(async (tx) => {
        await verifyCompany(tx, actor, companyId);
        if (id) requireDraft(await findJournal(tx, actor, companyId, id));
        const { lines, date: inputDate, ...fields } = input;
        const date = parseDate(inputDate);
        const period = await periodFor(tx, actor, companyId, date);
        const totals = await validateLines(tx, actor, companyId, lines);
        const data = { ...fields, ...totals, date, periodId: period.id };
        const create = draftLines(lines);
        if (id) await tx.journalLine.deleteMany({ where: { entryId: id, companyId } });
        const saved = id
          ? await tx.journalEntry.update({
              where: { id, status: 'DRAFT' },
              data: { ...data, lines: { create } },
              include: detail,
            })
          : await tx.journalEntry.create({
              data: {
                ...data,
                ...scope(actor, companyId),
                createdById: actor.userId,
                lines: { create },
              },
              include: detail,
            });
        await audit(tx, actor, id ? 'journal.update' : 'journal.create', saved.id);
        return toJournal(saved);
      });
    },

    deleteDraft(actor: Actor, companyId: string, id: string) {
      return mutate(async (tx) => {
        await verifyCompany(tx, actor, companyId);
        requireDraft(await findJournal(tx, actor, companyId, id));
        await tx.journalEntry.delete({ where: { id, status: 'DRAFT' } });
        await audit(tx, actor, 'journal.delete', id);
      });
    },

    post(actor: Actor, companyId: string, id: string): Promise<Journal> {
      return mutate(async (tx) => {
        await verifyCompany(tx, actor, companyId);
        const journal = await findJournal(tx, actor, companyId, id);
        if (journal.status === 'POSTED') return toJournal(journal);
        const period = await periodFor(tx, actor, companyId, journal.date);
        requireOpen(period);
        const totals = await validateLines(tx, actor, companyId, toJournal(journal).lines);
        const number = await allocateNumber(tx, actor, companyId);
        const posted = await tx.journalEntry.update({
          where: { id, status: 'DRAFT' },
          data: {
            ...totals,
            periodId: period.id,
            number,
            status: 'POSTED',
            postedAt: new Date(),
            postedById: actor.userId,
          },
          include: detail,
        });
        await audit(tx, actor, 'journal.post', id, { number });
        return toJournal(posted);
      });
    },

    reverse(
      actor: Actor,
      companyId: string,
      id: string,
      input: { date: string; description?: string | undefined },
    ): Promise<Journal> {
      return mutate(async (tx) => {
        await verifyCompany(tx, actor, companyId);
        const original = await findJournal(tx, actor, companyId, id);
        if (original.status !== 'POSTED' || original.reversedBy) {
          throw errors.conflict(
            'REVERSAL_UNAVAILABLE',
            'Only posted journals without a reversal can be reversed',
          );
        }
        const date = parseDate(input.date);
        if (date < original.date)
          throw errors.conflict(
            'REVERSAL_DATE',
            'The reversal date must be on or after the original journal date',
          );
        const period = await periodFor(tx, actor, companyId, date);
        requireOpen(period);
        const number = await allocateNumber(tx, actor, companyId);
        const reversal = await tx.journalEntry.create({
          data: {
            ...scope(actor, companyId),
            periodId: period.id,
            date,
            number,
            description: input.description || `Reversal of journal ${original.number}`,
            source: 'REVERSAL',
            status: 'POSTED',
            reversesId: id,
            totalDebit: original.totalCredit,
            totalCredit: original.totalDebit,
            createdById: actor.userId,
            postedById: actor.userId,
            postedAt: new Date(),
            lines: {
              create: original.lines.map(
                ({ accountId, branchId, description, lineNo, debit, credit }) => ({
                  accountId,
                  branchId,
                  description,
                  lineNo,
                  debit: credit,
                  credit: debit,
                }),
              ),
            },
          },
          include: detail,
        });
        await audit(tx, actor, 'journal.reverse', reversal.id, { reversesId: id, number });
        return toJournal(reversal);
      });
    },

    async trialBalance(actor: Actor, companyId: string, id: string): Promise<TrialBalance> {
      await verifyCompany(prisma, actor, companyId);
      const company = scope(actor, companyId);
      const period = await prisma.period.findFirst({ where: { ...company, id } });
      if (!period) throw errors.notFound('Fiscal period');
      const base = { ...company, status: 'POSTED' } as const;
      const [accounts, opening, movement] = await prisma.$transaction(
        [
          prisma.account.findMany({ where: company, orderBy: { code: 'asc' } }),
          prisma.journalLine.groupBy({
            by: ['accountId'],
            where: { companyId, entry: { ...base, date: { lt: period.startDate } } },
            _sum: { debit: true, credit: true },
          }),
          prisma.journalLine.groupBy({
            by: ['accountId'],
            where: {
              companyId,
              entry: { ...base, date: { gte: period.startDate, lte: period.endDate } },
            },
            _sum: { debit: true, credit: true },
          }),
        ],
        { isolationLevel: 'RepeatableRead' },
      );
      const before = new Map(opening.map((row) => [row.accountId, row._sum]));
      const during = new Map(movement.map((row) => [row.accountId, row._sum]));
      const net = (amount: bigint) => (amount > 0n ? amount : 0n);
      const asFils = (amount: Prisma.Decimal | null | undefined) =>
        amount ? decimalToFils(amount) : 0n;
      const rows: TrialBalanceRow[] = accounts.map((account) => {
        if (!isSubtypeOf(account.type, account.subtype))
          throw new Error(`Invalid account subtype for ${account.id}`);
        const openingNet =
          asFils(before.get(account.id)?.debit) - asFils(before.get(account.id)?.credit);
        const debit = asFils(during.get(account.id)?.debit);
        const credit = asFils(during.get(account.id)?.credit);
        const closingNet = openingNet + debit - credit;
        return {
          accountId: account.id,
          code: account.code,
          name: localizedNameSchema.parse(account.name),
          type: account.type,
          subtype: account.subtype,
          openingDebit: fromFils(net(openingNet)),
          openingCredit: fromFils(net(-openingNet)),
          periodDebit: fromFils(debit),
          periodCredit: fromFils(credit),
          closingDebit: fromFils(net(closingNet)),
          closingCredit: fromFils(net(-closingNet)),
        };
      });
      const sum = (key: keyof TrialBalance['totals']) =>
        fromFils(rows.reduce((total, row) => total + toFils(row[key]), 0n));
      return {
        from: formatDate(period.startDate),
        to: formatDate(period.endDate),
        rows,
        totals: {
          openingDebit: sum('openingDebit'),
          openingCredit: sum('openingCredit'),
          periodDebit: sum('periodDebit'),
          periodCredit: sum('periodCredit'),
          closingDebit: sum('closingDebit'),
          closingCredit: sum('closingCredit'),
        },
      };
    },
  };
}
