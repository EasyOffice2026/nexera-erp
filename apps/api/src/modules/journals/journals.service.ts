import {
  type Journal,
  type JournalInput,
  type JournalLineInput,
  type JournalSummary,
  type LocalizedName,
  type Page,
  toFils,
} from '@nexera/shared';
import type { z } from 'zod';
import type { listJournalsQuerySchema, reverseJournalSchema } from '@nexera/shared';
import { writeAudit } from '../../lib/audit';
import { asName, findCompany } from '../../lib/company-scope';
import { formatDate, parseDate } from '../../lib/dates';
import { errors } from '../../lib/http-errors';
import { decimalToAmount, filsToDecimal } from '../../lib/money';
import type { PrismaClient } from '../../lib/prisma';
import type { Actor } from '../../middleware/authenticate';
import type { Prisma } from '../../generated/prisma/client';

type ListQuery = z.output<typeof listJournalsQuerySchema>;
type ReverseInput = z.output<typeof reverseJournalSchema>;
type Tx = Prisma.TransactionClient;

const journalInclude = {
  lines: {
    orderBy: { lineNo: 'asc' },
    include: { account: { select: { code: true, name: true } } },
  },
  reversedBy: { select: { id: true } },
} as const satisfies Prisma.JournalEntryInclude;

type JournalRow = Prisma.JournalEntryGetPayload<{ include: typeof journalInclude }>;

function toJournal(row: JournalRow): Journal {
  return {
    id: row.id,
    companyId: row.companyId,
    number: row.number,
    date: formatDate(row.date),
    description: row.description,
    reference: row.reference,
    source: row.source,
    sourceSystem: row.sourceSystem,
    externalId: row.externalId,
    status: row.status,
    totalDebit: decimalToAmount(row.totalDebit),
    totalCredit: decimalToAmount(row.totalCredit),
    reversesId: row.reversesId,
    reversedById: row.reversedBy?.id ?? null,
    createdAt: row.createdAt.toISOString(),
    postedAt: row.postedAt?.toISOString() ?? null,
    lines: row.lines.map((line) => ({
      id: line.id,
      lineNo: line.lineNo,
      accountId: line.accountId,
      accountCode: line.account.code,
      accountName: asName(line.account.name) satisfies LocalizedName,
      branchId: line.branchId,
      description: line.description,
      debit: decimalToAmount(line.debit),
      credit: decimalToAmount(line.credit),
    })),
  };
}

function totalsOf(lines: readonly { debit: string; credit: string }[]) {
  let debit = 0n;
  let credit = 0n;
  for (const line of lines) {
    debit += toFils(line.debit);
    credit += toFils(line.credit);
  }
  return { debit, credit };
}

async function periodFor(tx: Tx, companyId: string, date: Date) {
  const period = await tx.period.findFirst({
    where: { companyId, startDate: { lte: date }, endDate: { gte: date } },
  });
  if (!period) {
    throw errors.rule(
      'NO_PERIOD',
      'No financial period covers this date. Open the financial year first',
    );
  }
  return period;
}

function requireOpen(period: { status: string }) {
  if (period.status !== 'OPEN') {
    throw errors.rule('PERIOD_CLOSED', 'The period of this date is closed');
  }
}

// Every line must use an active postable account and an active branch of the same company.
async function checkLines(tx: Tx, companyId: string, lines: readonly JournalLineInput[]) {
  const accountIds = [...new Set(lines.map((line) => line.accountId))];
  const accounts = await tx.account.findMany({
    where: { companyId, id: { in: accountIds } },
    select: { id: true, isPostable: true, isActive: true },
  });
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const branchIds = [...new Set(lines.flatMap((line) => (line.branchId ? [line.branchId] : [])))];
  const branches = await tx.branch.findMany({
    where: { companyId, id: { in: branchIds }, isActive: true },
    select: { id: true },
  });
  const activeBranches = new Set(branches.map((branch) => branch.id));

  lines.forEach((line, index) => {
    const account = byId.get(line.accountId);
    if (!account || !account.isPostable || !account.isActive) {
      throw errors.rule('INVALID_ACCOUNT', 'Use an active postable account of this company', {
        line: index + 1,
      });
    }
    if (line.branchId && !activeBranches.has(line.branchId)) {
      throw errors.rule('INVALID_BRANCH', 'Use an active branch of this company', {
        line: index + 1,
      });
    }
  });
}

function lineData(lines: readonly JournalLineInput[]) {
  return lines.map((line, index) => ({
    lineNo: index + 1,
    accountId: line.accountId,
    branchId: line.branchId,
    description: line.description,
    debit: filsToDecimal(toFils(line.debit)),
    credit: filsToDecimal(toFils(line.credit)),
  }));
}

// Takes the company's row lock and answers the next journal number. Everything that posts or
// closes a period goes through this lock, so numbers have no gaps and no duplicates.
async function nextNumber(tx: Tx, companyId: string): Promise<number> {
  const { journalSeq } = await tx.company.update({
    where: { id: companyId },
    data: { journalSeq: { increment: 1 } },
    select: { journalSeq: true },
  });
  return journalSeq;
}

export function createJournalsService(deps: { prisma: PrismaClient; now?: () => Date }) {
  const { prisma } = deps;
  const now = deps.now ?? (() => new Date());

  async function load(db: Tx | PrismaClient, companyId: string, id: string) {
    const row = await db.journalEntry.findFirst({
      where: { id, companyId },
      include: journalInclude,
    });
    if (!row) throw errors.notFound('Journal');
    return row;
  }

  function requireDraft(row: { status: string }) {
    if (row.status !== 'DRAFT') {
      throw errors.conflict('JOURNAL_POSTED', 'A posted journal cannot be changed. Reverse it');
    }
  }

  return {
    async list(actor: Actor, companyId: string, query: ListQuery): Promise<Page<JournalSummary>> {
      await findCompany(prisma, actor.tenantId, companyId);
      const search = query.search?.trim();
      const number = search && /^\d{1,9}$/.test(search) ? Number(search) : undefined;
      const where: Prisma.JournalEntryWhereInput = {
        companyId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.from || query.to
          ? {
              date: {
                ...(query.from ? { gte: parseDate(query.from) } : {}),
                ...(query.to ? { lte: parseDate(query.to) } : {}),
              },
            }
          : {}),
        ...(search
          ? {
              OR: [
                { description: { contains: search, mode: 'insensitive' } },
                { reference: { contains: search, mode: 'insensitive' } },
                ...(number !== undefined ? [{ number }] : []),
              ],
            }
          : {}),
      };
      const [total, rows] = await Promise.all([
        prisma.journalEntry.count({ where }),
        prisma.journalEntry.findMany({
          where,
          orderBy: [
            { date: 'desc' },
            { number: { sort: 'desc', nulls: 'first' } },
            { createdAt: 'desc' },
          ],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          include: { reversedBy: { select: { id: true } } },
        }),
      ]);
      return {
        items: rows.map((row) => ({
          id: row.id,
          number: row.number,
          date: formatDate(row.date),
          description: row.description,
          reference: row.reference,
          source: row.source,
          status: row.status,
          totalDebit: decimalToAmount(row.totalDebit),
          reversedById: row.reversedBy?.id ?? null,
        })),
        total,
        page: query.page,
        pageSize: query.pageSize,
      };
    },

    async get(actor: Actor, companyId: string, id: string): Promise<Journal> {
      await findCompany(prisma, actor.tenantId, companyId);
      return toJournal(await load(prisma, companyId, id));
    },

    // A draft may be unbalanced and may fall in a closed period; posting checks both.
    async createDraft(actor: Actor, companyId: string, input: JournalInput): Promise<Journal> {
      await findCompany(prisma, actor.tenantId, companyId);
      const row = await prisma.$transaction(async (tx) => {
        const date = parseDate(input.date);
        const period = await periodFor(tx, companyId, date);
        requireOpen(period);
        await checkLines(tx, companyId, input.lines);
        const totals = totalsOf(input.lines);
        const entry = await tx.journalEntry.create({
          data: {
            tenantId: actor.tenantId,
            companyId,
            periodId: period.id,
            date,
            description: input.description,
            reference: input.reference,
            source: input.source,
            totalDebit: filsToDecimal(totals.debit),
            totalCredit: filsToDecimal(totals.credit),
            createdById: actor.userId,
            lines: { create: lineData(input.lines) },
          },
          select: { id: true },
        });
        await writeAudit(tx, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          action: 'journal.create',
          entityType: 'journal',
          entityId: entry.id,
          ip: actor.ip,
        });
        return load(tx, companyId, entry.id);
      });
      return toJournal(row);
    },

    async updateDraft(
      actor: Actor,
      companyId: string,
      id: string,
      input: JournalInput,
    ): Promise<Journal> {
      await findCompany(prisma, actor.tenantId, companyId);
      const row = await prisma.$transaction(async (tx) => {
        requireDraft(await load(tx, companyId, id));
        const date = parseDate(input.date);
        const period = await periodFor(tx, companyId, date);
        requireOpen(period);
        await checkLines(tx, companyId, input.lines);
        const totals = totalsOf(input.lines);
        await tx.journalLine.deleteMany({ where: { entryId: id } });
        await tx.journalEntry.update({
          where: { id },
          data: {
            periodId: period.id,
            date,
            description: input.description,
            reference: input.reference,
            source: input.source,
            totalDebit: filsToDecimal(totals.debit),
            totalCredit: filsToDecimal(totals.credit),
            lines: { create: lineData(input.lines) },
          },
        });
        await writeAudit(tx, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          action: 'journal.update',
          entityType: 'journal',
          entityId: id,
          ip: actor.ip,
        });
        return load(tx, companyId, id);
      });
      return toJournal(row);
    },

    async deleteDraft(actor: Actor, companyId: string, id: string): Promise<void> {
      await findCompany(prisma, actor.tenantId, companyId);
      await prisma.$transaction(async (tx) => {
        requireDraft(await load(tx, companyId, id));
        await tx.journalEntry.delete({ where: { id } });
        await writeAudit(tx, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          action: 'journal.delete',
          entityType: 'journal',
          entityId: id,
          ip: actor.ip,
        });
      });
    },

    async post(actor: Actor, companyId: string, id: string): Promise<Journal> {
      await findCompany(prisma, actor.tenantId, companyId);
      const row = await prisma.$transaction(async (tx) => {
        const number = await nextNumber(tx, companyId);
        // Read after taking the lock, so a second request to post the same draft sees it posted.
        const entry = await load(tx, companyId, id);
        requireDraft(entry);
        const debit = entry.lines.reduce((sum, line) => sum + toFils(line.debit.toFixed(3)), 0n);
        const credit = entry.lines.reduce((sum, line) => sum + toFils(line.credit.toFixed(3)), 0n);
        if (entry.lines.length < 2) {
          throw errors.rule('JOURNAL_TOO_FEW_LINES', 'A journal needs at least two lines');
        }
        if (debit !== credit || debit === 0n) {
          throw errors.rule('JOURNAL_UNBALANCED', 'Debits and credits must be equal', {
            totalDebit: decimalToAmount(entry.totalDebit),
            totalCredit: decimalToAmount(entry.totalCredit),
          });
        }
        requireOpen(await periodFor(tx, companyId, entry.date));
        await checkLines(
          tx,
          companyId,
          entry.lines.map((line) => ({
            accountId: line.accountId,
            branchId: line.branchId,
            description: line.description,
            debit: line.debit.toFixed(3),
            credit: line.credit.toFixed(3),
          })),
        );
        await tx.journalEntry.update({
          where: { id },
          data: { status: 'POSTED', number, postedAt: now(), postedById: actor.userId },
        });
        await writeAudit(tx, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          action: 'journal.post',
          entityType: 'journal',
          entityId: id,
          data: { number },
          ip: actor.ip,
        });
        return load(tx, companyId, id);
      });
      return toJournal(row);
    },

    // Posts a new entry with debits and credits swapped and links the two.
    async reverse(
      actor: Actor,
      companyId: string,
      id: string,
      input: ReverseInput,
    ): Promise<Journal> {
      await findCompany(prisma, actor.tenantId, companyId);
      const row = await prisma.$transaction(async (tx) => {
        const number = await nextNumber(tx, companyId);
        const original = await load(tx, companyId, id);
        if (original.status !== 'POSTED') {
          throw errors.conflict('JOURNAL_NOT_POSTED', 'Only a posted journal can be reversed');
        }
        if (original.reversedBy) {
          throw errors.conflict('JOURNAL_ALREADY_REVERSED', 'This journal is already reversed');
        }
        const date = parseDate(input.date);
        if (date < original.date) {
          throw errors.rule(
            'REVERSAL_BEFORE_ORIGINAL',
            'A reversal cannot be dated before the journal',
          );
        }
        const period = await periodFor(tx, companyId, date);
        requireOpen(period);
        const reversal = await tx.journalEntry.create({
          data: {
            tenantId: actor.tenantId,
            companyId,
            periodId: period.id,
            number,
            date,
            description: input.description ?? `Reversal of journal #${original.number ?? ''}`,
            reference: original.reference,
            source: 'REVERSAL',
            status: 'POSTED',
            totalDebit: original.totalCredit,
            totalCredit: original.totalDebit,
            reversesId: original.id,
            createdById: actor.userId,
            postedById: actor.userId,
            postedAt: now(),
            lines: {
              create: original.lines.map((line) => ({
                lineNo: line.lineNo,
                accountId: line.accountId,
                branchId: line.branchId,
                description: line.description,
                debit: line.credit,
                credit: line.debit,
              })),
            },
          },
          select: { id: true },
        });
        await writeAudit(tx, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          action: 'journal.reverse',
          entityType: 'journal',
          entityId: original.id,
          data: { reversalId: reversal.id, number },
          ip: actor.ip,
        });
        return load(tx, companyId, reversal.id);
      });
      return toJournal(row);
    },
  };
}

export type JournalsService = ReturnType<typeof createJournalsService>;
