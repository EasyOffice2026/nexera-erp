import { createHash } from 'node:crypto';
import {
  applyMapping,
  type BankAccountInput,
  type BankAccountSummary,
  type BankCandidate,
  type BankImportResult,
  type BankLine,
  type BankLineJournalInput,
  type BankMapping,
  type BankReconciliation,
  type BankRule,
  type BankRuleInput,
  type BookItem,
  fromFils,
  type ImportStatementInput,
  type Page,
  type ParsedBankLine,
  toFils,
} from '@nexera/shared';
import type { z } from 'zod';
import type { listBankLinesQuerySchema } from '@nexera/shared';
import { writeAudit } from '../../lib/audit';
import { asName, findCompany } from '../../lib/company-scope';
import { addDays, formatDate, parseDate } from '../../lib/dates';
import { AppError, errors } from '../../lib/http-errors';
import { decimalToAmount, decimalToFils, filsToDecimal } from '../../lib/money';
import type { PrismaClient } from '../../lib/prisma';
import type { Actor } from '../../middleware/authenticate';
import type { Prisma } from '../../generated/prisma/client';
import { postJournalInTx } from '../journals/journals.service';

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;
type LinesQuery = z.output<typeof listBankLinesQuerySchema>;

// Suggestions look this many days either side of the statement date; automatic matching fewer.
const MATCH_WINDOW_DAYS = 60;
const AUTO_MATCH_DAYS = 5;
const DAY = 86_400_000;

const lineInclude = {
  journalLine: { select: { entry: { select: { id: true, number: true, date: true } } } },
  rule: { select: { name: true } },
} as const satisfies Prisma.BankStatementLineInclude;
type LineRow = Prisma.BankStatementLineGetPayload<{ include: typeof lineInclude }>;

const bookInclude = {
  entry: { select: { id: true, number: true, date: true, description: true, reference: true } },
} as const satisfies Prisma.JournalLineInclude;
type BookRow = Prisma.JournalLineGetPayload<{ include: typeof bookInclude }>;

type BankRow = Prisma.BankAccountGetPayload<{ include: { account: true } }>;

const lineOrder = [
  { date: 'asc' },
  { statement: { createdAt: 'asc' } },
  { lineNo: 'asc' },
] as const satisfies Prisma.BankStatementLineOrderByWithRelationInput[];

const signed = (row: { debit: Prisma.Decimal; credit: Prisma.Decimal }) =>
  decimalToFils(row.debit) - decimalToFils(row.credit);

const isLocked = (bank: { reconciledUntil: Date | null }, date: Date) =>
  bank.reconciledUntil !== null && date <= bank.reconciledUntil;

function toBankLine(row: LineRow, bank: { reconciledUntil: Date | null }): BankLine {
  return {
    id: row.id,
    date: formatDate(row.date),
    description: row.description,
    reference: row.reference,
    amount: decimalToAmount(row.amount),
    balance: row.balance ? decimalToAmount(row.balance) : null,
    status: row.journalLineId ? 'matched' : 'unmatched',
    journalId: row.journalLine?.entry.id ?? null,
    journalNumber: row.journalLine?.entry.number ?? null,
    ruleName: row.rule?.name ?? null,
    locked: isLocked(bank, row.date),
  };
}

function toBookItem(row: BookRow): BookItem {
  return {
    journalLineId: row.id,
    journalId: row.entry.id,
    journalNumber: row.entry.number,
    date: formatDate(row.entry.date),
    description: row.description || row.entry.description,
    amount: fromFils(signed(row)),
  };
}

// The same row imported again gets the same fingerprint; repeats within a file are numbered.
function fingerprints(lines: readonly ParsedBankLine[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const key = [line.date, line.amount, line.description, line.reference]
      .map((part) => part.toLowerCase())
      .join('|');
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return createHash('sha256').update(`${key}|${count}`).digest('hex');
  });
}

const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 3),
  );

function score(line: { date: Date; reference: string; description: string }, book: BookRow) {
  const days = Math.abs(line.date.getTime() - book.entry.date.getTime()) / DAY;
  const text =
    `${book.entry.reference} ${book.entry.description} ${book.description}`.toLowerCase();
  const reference = line.reference.trim().toLowerCase();
  let points = 100 - Math.min(days, MATCH_WINDOW_DAYS);
  if (reference && text.includes(reference)) points += 50;
  else {
    const bookWords = words(text);
    if ([...words(line.description)].some((word) => bookWords.has(word))) points += 10;
  }
  return Math.round(points);
}

export function createBankService(deps: { prisma: PrismaClient; now?: () => Date }) {
  const { prisma } = deps;
  const now = deps.now ?? (() => new Date());

  async function loadBank(db: Db, companyId: string, id: string): Promise<BankRow> {
    const bank = await db.bankAccount.findFirst({
      where: { id, companyId },
      include: { account: true },
    });
    if (!bank) throw errors.notFound('Bank account');
    return bank;
  }

  async function loadLine(db: Db, bank: BankRow, id: string) {
    const line = await db.bankStatementLine.findFirst({
      where: { id, bankAccountId: bank.id },
      include: lineInclude,
    });
    if (!line) throw errors.notFound('Statement line');
    return line;
  }

  function requireUnlocked(bank: BankRow, date: Date) {
    if (isLocked(bank, date)) {
      throw errors.rule('BANK_RECONCILED', 'The bank account is reconciled up to this date');
    }
  }

  async function checkAccount(db: Db, companyId: string, accountId: string) {
    const account = await db.account.findFirst({
      where: { id: accountId, companyId, isPostable: true, isActive: true },
    });
    if (!account) throw errors.rule('INVALID_ACCOUNT', 'Use an active postable account');
    return account;
  }

  function unmatchedBook(db: Db, bank: BankRow, where: Prisma.JournalEntryWhereInput = {}) {
    return db.journalLine.findMany({
      where: {
        accountId: bank.accountId,
        bankLine: { is: null },
        entry: { companyId: bank.companyId, status: 'POSTED', ...where },
      },
      include: bookInclude,
      orderBy: [{ entry: { date: 'asc' } }, { entry: { number: 'asc' } }],
    });
  }

  // Posts "bank against the chosen account" for the statement line and matches the two.
  async function journalForLine(
    tx: Tx,
    actor: Actor,
    bank: BankRow,
    line: LineRow,
    input: BankLineJournalInput,
    ruleId: string | null,
  ) {
    requireUnlocked(bank, line.date);
    if (line.journalLineId) {
      throw errors.conflict('BANK_LINE_MATCHED', 'This statement line is already matched');
    }
    if (input.accountId === bank.accountId) {
      throw errors.rule('INVALID_ACCOUNT', 'Choose the other side of the bank entry');
    }
    const fils = decimalToFils(line.amount);
    const amount = fromFils(fils < 0n ? -fils : fils);
    const into = fils > 0n;
    const posted = await postJournalInTx(
      tx,
      actor,
      bank.companyId,
      {
        date: formatDate(line.date),
        description: (input.description || line.description || bank.bankName).slice(0, 500),
        reference: line.reference.slice(0, 100),
        source: 'BANK',
        lines: [
          {
            accountId: bank.accountId,
            branchId: null,
            description: '',
            debit: into ? amount : '0',
            credit: into ? '0' : amount,
          },
          {
            accountId: input.accountId,
            branchId: input.branchId,
            description: '',
            debit: into ? '0' : amount,
            credit: into ? amount : '0',
          },
        ],
      },
      now(),
    );
    const updated = await tx.bankStatementLine.updateMany({
      where: { id: line.id, journalLineId: null },
      data: {
        journalLineId: posted.lineIds[0]!,
        ruleId,
        matchedById: actor.userId,
        matchedAt: now(),
      },
    });
    if (updated.count !== 1) {
      throw errors.conflict('BANK_LINE_MATCHED', 'This statement line is already matched');
    }
  }

  async function autoMatch(actor: Actor, bank: BankRow): Promise<number> {
    const lines = await prisma.bankStatementLine.findMany({
      where: {
        bankAccountId: bank.id,
        journalLineId: null,
        ...(bank.reconciledUntil ? { date: { gt: bank.reconciledUntil } } : {}),
      },
      orderBy: lineOrder,
    });
    if (lines.length === 0) return 0;
    const book = await unmatchedBook(prisma, bank, {
      date: {
        gte: addDays(lines[0]!.date, -AUTO_MATCH_DAYS),
        lte: addDays(lines.at(-1)!.date, AUTO_MATCH_DAYS),
      },
    });
    const used = new Set<string>();
    let matched = 0;
    for (const line of lines) {
      const amount = decimalToFils(line.amount);
      const candidates = book.filter(
        (row) =>
          !used.has(row.id) &&
          signed(row) === amount &&
          Math.abs(row.entry.date.getTime() - line.date.getTime()) <= AUTO_MATCH_DAYS * DAY,
      );
      const reference = line.reference.trim().toLowerCase();
      const byReference = reference
        ? candidates.filter((row) =>
            `${row.entry.reference} ${row.entry.description}`.toLowerCase().includes(reference),
          )
        : [];
      const pick =
        candidates.length === 1
          ? candidates[0]
          : byReference.length === 1
            ? byReference[0]
            : undefined;
      if (!pick) continue;
      const updated = await prisma.bankStatementLine.updateMany({
        where: { id: line.id, journalLineId: null },
        data: { journalLineId: pick.id, matchedById: actor.userId, matchedAt: now() },
      });
      if (updated.count === 1) {
        used.add(pick.id);
        matched++;
      }
    }
    return matched;
  }

  async function applyRules(actor: Actor, bank: BankRow): Promise<number> {
    const rules = await prisma.bankRule.findMany({
      where: {
        companyId: bank.companyId,
        isActive: true,
        OR: [{ bankAccountId: null }, { bankAccountId: bank.id }],
      },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
    if (rules.length === 0) return 0;
    const lines = await prisma.bankStatementLine.findMany({
      where: {
        bankAccountId: bank.id,
        journalLineId: null,
        ...(bank.reconciledUntil ? { date: { gt: bank.reconciledUntil } } : {}),
      },
      include: lineInclude,
      orderBy: lineOrder,
    });
    let created = 0;
    for (const line of lines) {
      const text = `${line.description} ${line.reference}`.toLowerCase();
      const into = decimalToFils(line.amount) > 0n;
      const rule = rules.find(
        (row) =>
          text.includes(row.contains.toLowerCase()) &&
          (row.direction === 'ANY' || (row.direction === 'IN') === into),
      );
      if (!rule) continue;
      try {
        await prisma.$transaction((tx) =>
          journalForLine(
            tx,
            actor,
            bank,
            line,
            { accountId: rule.accountId, branchId: rule.branchId, description: undefined },
            rule.id,
          ),
        );
        created++;
      } catch (error) {
        // A line the rule cannot post (closed period, inactive account) stays for a person.
        if (!(error instanceof AppError)) throw error;
      }
    }
    return created;
  }

  async function reconcile(db: Db, bank: BankRow, asOf: Date): Promise<BankReconciliation> {
    const [book, statement, last, bankOnly, bookOnly] = await Promise.all([
      db.journalLine.aggregate({
        where: {
          accountId: bank.accountId,
          entry: { companyId: bank.companyId, status: 'POSTED', date: { lte: asOf } },
        },
        _sum: { debit: true, credit: true },
      }),
      db.bankStatementLine.aggregate({
        where: { bankAccountId: bank.id, date: { lte: asOf } },
        _sum: { amount: true },
      }),
      db.bankStatementLine.findFirst({
        where: { bankAccountId: bank.id, date: { lte: asOf } },
        orderBy: [{ date: 'desc' }, { statement: { createdAt: 'desc' } }, { lineNo: 'desc' }],
        select: { balance: true },
      }),
      db.bankStatementLine.findMany({
        where: {
          bankAccountId: bank.id,
          date: { lte: asOf },
          OR: [{ journalLineId: null }, { journalLine: { is: { entry: { date: { gt: asOf } } } } }],
        },
        include: lineInclude,
        orderBy: lineOrder,
      }),
      db.journalLine.findMany({
        where: {
          accountId: bank.accountId,
          entry: { companyId: bank.companyId, status: 'POSTED', date: { lte: asOf } },
          OR: [{ bankLine: { is: null } }, { bankLine: { is: { date: { gt: asOf } } } }],
        },
        include: bookInclude,
        orderBy: [{ entry: { date: 'asc' } }, { entry: { number: 'asc' } }],
      }),
    ]);
    const zero = filsToDecimal(0n);
    const bookBalance =
      decimalToFils(book._sum.debit ?? zero) - decimalToFils(book._sum.credit ?? zero);
    const statementBalance =
      decimalToFils(bank.openingBalance) + decimalToFils(statement._sum.amount ?? zero);
    const bankTotal = bankOnly.reduce((sum, row) => sum + decimalToFils(row.amount), 0n);
    const bookTotal = bookOnly.reduce((sum, row) => sum + signed(row), 0n);
    const difference = statementBalance - (bookBalance + bankTotal - bookTotal);
    const column = last?.balance ? decimalToFils(last.balance) : null;
    return {
      asOf: formatDate(asOf),
      bookBalance: fromFils(bookBalance),
      statementBalance: fromFils(statementBalance),
      bankBalanceColumn: column === null ? null : fromFils(column),
      unmatchedBank: bankOnly.map((row) => toBankLine(row, bank)),
      unmatchedBankTotal: fromFils(bankTotal),
      unmatchedBook: bookOnly.map(toBookItem),
      unmatchedBookTotal: fromFils(bookTotal),
      difference: fromFils(difference),
      reconciledUntil: bank.reconciledUntil && formatDate(bank.reconciledUntil),
      canLock:
        difference === 0n &&
        bankOnly.length === 0 &&
        (column === null || column === statementBalance) &&
        !isLocked(bank, asOf),
    };
  }

  async function audit(db: Db, actor: Actor, action: string, entityId: string, data = {}) {
    await writeAudit(db, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      action,
      entityType: 'bank_account',
      entityId,
      data,
      ip: actor.ip,
    });
  }

  function toRule(row: Prisma.BankRuleGetPayload<object>, codes: Map<string, string>): BankRule {
    return {
      id: row.id,
      name: row.name,
      contains: row.contains,
      direction: row.direction,
      accountId: row.accountId,
      accountCode: codes.get(row.accountId) ?? '',
      branchId: row.branchId,
      bankAccountId: row.bankAccountId,
      priority: row.priority,
      isActive: row.isActive,
    };
  }

  async function checkRule(companyId: string, input: BankRuleInput) {
    await checkAccount(prisma, companyId, input.accountId);
    if (input.branchId) {
      const branch = await prisma.branch.findFirst({ where: { id: input.branchId, companyId } });
      if (!branch) throw errors.rule('INVALID_BRANCH', 'Use an active branch of this company');
    }
    if (input.bankAccountId) await loadBank(prisma, companyId, input.bankAccountId);
  }

  return {
    async listAccounts(actor: Actor, companyId: string): Promise<BankAccountSummary[]> {
      await findCompany(prisma, actor.tenantId, companyId);
      const banks = await prisma.bankAccount.findMany({
        where: { companyId },
        include: { account: true },
        orderBy: { account: { code: 'asc' } },
      });
      return Promise.all(
        banks.map(async (bank) => {
          const [book, statement, unmatchedCount] = await Promise.all([
            prisma.journalLine.aggregate({
              where: { accountId: bank.accountId, entry: { companyId, status: 'POSTED' } },
              _sum: { debit: true, credit: true },
            }),
            prisma.bankStatementLine.aggregate({
              where: { bankAccountId: bank.id },
              _sum: { amount: true },
              _max: { date: true },
            }),
            prisma.bankStatementLine.count({
              where: { bankAccountId: bank.id, journalLineId: null },
            }),
          ]);
          const zero = filsToDecimal(0n);
          return {
            id: bank.id,
            accountId: bank.accountId,
            accountCode: bank.account.code,
            accountName: asName(bank.account.name),
            bankName: bank.bankName,
            accountNumber: bank.accountNumber,
            currency: bank.currency,
            openingBalance: decimalToAmount(bank.openingBalance),
            reconciledUntil: bank.reconciledUntil && formatDate(bank.reconciledUntil),
            mapping: (bank.mapping ?? null) as BankMapping | null,
            bookBalance: fromFils(
              decimalToFils(book._sum.debit ?? zero) - decimalToFils(book._sum.credit ?? zero),
            ),
            statementBalance: fromFils(
              decimalToFils(bank.openingBalance) + decimalToFils(statement._sum.amount ?? zero),
            ),
            unmatchedCount,
            lastLineDate: statement._max.date && formatDate(statement._max.date),
          };
        }),
      );
    },

    async createAccount(actor: Actor, companyId: string, input: BankAccountInput) {
      await findCompany(prisma, actor.tenantId, companyId);
      const account = await checkAccount(prisma, companyId, input.accountId);
      if (account.type !== 'ASSET' || account.subtype !== 'bank') {
        throw errors.rule('INVALID_ACCOUNT', 'Link a bank account of the chart of accounts');
      }
      if (await prisma.bankAccount.findUnique({ where: { accountId: account.id } })) {
        throw errors.conflict('BANK_ACCOUNT_EXISTS', 'This account is already linked to a bank');
      }
      const bank = await prisma.$transaction(async (tx) => {
        const row = await tx.bankAccount.create({
          data: {
            tenantId: actor.tenantId,
            companyId,
            accountId: account.id,
            bankName: input.bankName,
            accountNumber: input.accountNumber,
            openingBalance: filsToDecimal(toFils(input.openingBalance)),
          },
        });
        await audit(tx, actor, 'bank_account.create', row.id);
        return row;
      });
      return (await this.listAccounts(actor, companyId)).find((row) => row.id === bank.id)!;
    },

    async updateAccount(actor: Actor, companyId: string, id: string, input: BankAccountInput) {
      await findCompany(prisma, actor.tenantId, companyId);
      const bank = await loadBank(prisma, companyId, id);
      const opening = toFils(input.openingBalance);
      if (bank.reconciledUntil && opening !== decimalToFils(bank.openingBalance)) {
        throw errors.rule('BANK_RECONCILED', 'The opening balance of a reconciled bank is fixed');
      }
      await prisma.$transaction(async (tx) => {
        await tx.bankAccount.update({
          where: { id },
          data: {
            bankName: input.bankName,
            accountNumber: input.accountNumber,
            openingBalance: filsToDecimal(opening),
          },
        });
        await audit(tx, actor, 'bank_account.update', id);
      });
      return (await this.listAccounts(actor, companyId)).find((row) => row.id === id)!;
    },

    async importStatement(
      actor: Actor,
      companyId: string,
      id: string,
      input: ImportStatementInput,
    ): Promise<BankImportResult> {
      await findCompany(prisma, actor.tenantId, companyId);
      const bank = await loadBank(prisma, companyId, id);
      const parsed = applyMapping(input.rows, input.mapping);
      const lines = [...parsed.lines];
      // Statements printed newest first are stored oldest first.
      if (lines.length > 1 && lines[0]!.date > lines.at(-1)!.date) lines.reverse();
      if (lines.length === 0) {
        throw errors.rule('NO_STATEMENT_LINES', 'No transactions were found with this mapping', {
          skipped: parsed.skipped.length,
        });
      }
      const locked = lines.find((line) => isLocked(bank, parseDate(line.date)));
      if (locked) {
        throw errors.rule('BANK_RECONCILED', 'The bank account is reconciled up to this date', {
          date: locked.date,
        });
      }
      const prints = fingerprints(lines);
      const existing = new Set(
        (
          await prisma.bankStatementLine.findMany({
            where: { bankAccountId: bank.id, fingerprint: { in: prints } },
            select: { fingerprint: true },
          })
        ).map((row) => row.fingerprint),
      );
      const fresh = lines.flatMap((line, index) =>
        existing.has(prints[index]!) ? [] : [{ line, fingerprint: prints[index]! }],
      );
      const dates = lines.map((line) => line.date).sort();
      const statement = await prisma.$transaction(async (tx) => {
        const row = await tx.bankStatement.create({
          data: {
            tenantId: actor.tenantId,
            companyId,
            bankAccountId: bank.id,
            fileName: input.fileName,
            fromDate: parseDate(dates[0]!),
            toDate: parseDate(dates.at(-1)!),
            lineCount: fresh.length,
            importedById: actor.userId,
          },
        });
        await tx.bankStatementLine.createMany({
          data: fresh.map(({ line, fingerprint }, index) => ({
            tenantId: actor.tenantId,
            companyId,
            bankAccountId: bank.id,
            statementId: row.id,
            lineNo: index + 1,
            date: parseDate(line.date),
            description: line.description,
            reference: line.reference,
            amount: filsToDecimal(toFils(line.amount)),
            balance: line.balance === null ? null : filsToDecimal(toFils(line.balance)),
            fingerprint,
          })),
        });
        await tx.bankAccount.update({
          where: { id: bank.id },
          data: { mapping: input.mapping },
        });
        await audit(tx, actor, 'bank_statement.import', bank.id, {
          statementId: row.id,
          lines: fresh.length,
        });
        return row;
      });
      const autoMatched = await autoMatch(actor, bank);
      const ruleJournals = await applyRules(actor, bank);
      return {
        statementId: statement.id,
        imported: fresh.length,
        duplicates: lines.length - fresh.length,
        skipped: parsed.skipped,
        autoMatched,
        ruleJournals,
      };
    },

    async listLines(
      actor: Actor,
      companyId: string,
      id: string,
      query: LinesQuery,
    ): Promise<Page<BankLine>> {
      await findCompany(prisma, actor.tenantId, companyId);
      const bank = await loadBank(prisma, companyId, id);
      const where: Prisma.BankStatementLineWhereInput = {
        bankAccountId: bank.id,
        ...(query.status === 'matched' ? { journalLineId: { not: null } } : {}),
        ...(query.status === 'unmatched' ? { journalLineId: null } : {}),
        ...(query.from || query.to
          ? {
              date: {
                ...(query.from ? { gte: parseDate(query.from) } : {}),
                ...(query.to ? { lte: parseDate(query.to) } : {}),
              },
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        prisma.bankStatementLine.findMany({
          where,
          include: lineInclude,
          orderBy: lineOrder,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        prisma.bankStatementLine.count({ where }),
      ]);
      return {
        items: rows.map((row) => toBankLine(row, bank)),
        total,
        page: query.page,
        pageSize: query.pageSize,
      };
    },

    // Posted bank-account postings of the same amount near the date, best first.
    async candidates(
      actor: Actor,
      companyId: string,
      id: string,
      lineId: string,
    ): Promise<BankCandidate[]> {
      await findCompany(prisma, actor.tenantId, companyId);
      const bank = await loadBank(prisma, companyId, id);
      const line = await loadLine(prisma, bank, lineId);
      const amount = decimalToFils(line.amount);
      const book = await unmatchedBook(prisma, bank, {
        date: {
          gte: addDays(line.date, -MATCH_WINDOW_DAYS),
          lte: addDays(line.date, MATCH_WINDOW_DAYS),
        },
      });
      return book
        .filter((row) => signed(row) === amount)
        .map((row) => ({
          journalLineId: row.id,
          journalId: row.entry.id,
          journalNumber: row.entry.number,
          date: formatDate(row.entry.date),
          description: row.description || row.entry.description,
          reference: row.entry.reference,
          amount: fromFils(signed(row)),
          score: score(line, row),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
    },

    async match(
      actor: Actor,
      companyId: string,
      id: string,
      lineId: string,
      journalLineId: string,
    ) {
      await findCompany(prisma, actor.tenantId, companyId);
      const bank = await loadBank(prisma, companyId, id);
      await prisma.$transaction(async (tx) => {
        const line = await loadLine(tx, bank, lineId);
        requireUnlocked(bank, line.date);
        const book = await tx.journalLine.findFirst({
          where: {
            id: journalLineId,
            accountId: bank.accountId,
            entry: { companyId, status: 'POSTED' },
          },
          include: { bankLine: { select: { id: true } } },
        });
        if (!book) throw errors.rule('INVALID_MATCH', 'Pick a posted line of this bank account');
        if (signed(book) !== decimalToFils(line.amount)) {
          throw errors.rule('MATCH_AMOUNT_DIFFERS', 'The amounts are not the same');
        }
        if (line.journalLineId || book.bankLine) {
          throw errors.conflict('BANK_LINE_MATCHED', 'This line is already matched');
        }
        await tx.bankStatementLine.update({
          where: { id: line.id },
          data: { journalLineId: book.id, matchedById: actor.userId, matchedAt: now() },
        });
        await audit(tx, actor, 'bank_line.match', bank.id, { lineId, journalLineId });
      });
      return toBankLine(await loadLine(prisma, bank, lineId), bank);
    },

    async unmatch(actor: Actor, companyId: string, id: string, lineId: string) {
      await findCompany(prisma, actor.tenantId, companyId);
      const bank = await loadBank(prisma, companyId, id);
      await prisma.$transaction(async (tx) => {
        const line = await loadLine(tx, bank, lineId);
        requireUnlocked(bank, line.date);
        await tx.bankStatementLine.update({
          where: { id: line.id },
          data: { journalLineId: null, ruleId: null, matchedById: null, matchedAt: null },
        });
        await audit(tx, actor, 'bank_line.unmatch', bank.id, { lineId });
      });
      return toBankLine(await loadLine(prisma, bank, lineId), bank);
    },

    async createJournal(
      actor: Actor,
      companyId: string,
      id: string,
      lineId: string,
      input: BankLineJournalInput,
    ) {
      await findCompany(prisma, actor.tenantId, companyId);
      const bank = await loadBank(prisma, companyId, id);
      await prisma.$transaction(async (tx) => {
        await journalForLine(tx, actor, bank, await loadLine(tx, bank, lineId), input, null);
      });
      return toBankLine(await loadLine(prisma, bank, lineId), bank);
    },

    async autoMatch(actor: Actor, companyId: string, id: string) {
      await findCompany(prisma, actor.tenantId, companyId);
      return { matched: await autoMatch(actor, await loadBank(prisma, companyId, id)) };
    },

    async applyRules(actor: Actor, companyId: string, id: string) {
      await findCompany(prisma, actor.tenantId, companyId);
      return { created: await applyRules(actor, await loadBank(prisma, companyId, id)) };
    },

    async reconciliation(actor: Actor, companyId: string, id: string, asOf: string) {
      await findCompany(prisma, actor.tenantId, companyId);
      return reconcile(prisma, await loadBank(prisma, companyId, id), parseDate(asOf));
    },

    // Locks the statement lines and the bank-account postings up to the date.
    async lock(actor: Actor, companyId: string, id: string, asOf: string) {
      await findCompany(prisma, actor.tenantId, companyId);
      return prisma.$transaction(async (tx) => {
        const bank = await loadBank(tx, companyId, id);
        const date = parseDate(asOf);
        const result = await reconcile(tx, bank, date);
        if (!result.canLock) {
          throw errors.rule('RECONCILIATION_NOT_BALANCED', 'Match every statement line first', {
            difference: result.difference,
            unmatched: result.unmatchedBank.length,
          });
        }
        await tx.bankReconciliation.create({
          data: {
            tenantId: actor.tenantId,
            companyId,
            bankAccountId: bank.id,
            asOf: date,
            statementBalance: filsToDecimal(toFils(result.statementBalance)),
            bookBalance: filsToDecimal(toFils(result.bookBalance)),
            createdById: actor.userId,
          },
        });
        await tx.bankAccount.update({ where: { id: bank.id }, data: { reconciledUntil: date } });
        await audit(tx, actor, 'bank_account.reconcile', bank.id, { asOf });
        return reconcile(tx, { ...bank, reconciledUntil: date }, date);
      });
    },

    async listRules(actor: Actor, companyId: string): Promise<BankRule[]> {
      await findCompany(prisma, actor.tenantId, companyId);
      const [rules, accounts] = await Promise.all([
        prisma.bankRule.findMany({
          where: { companyId },
          orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
        }),
        prisma.account.findMany({ where: { companyId }, select: { id: true, code: true } }),
      ]);
      const codes = new Map(accounts.map((row) => [row.id, row.code]));
      return rules.map((row) => toRule(row, codes));
    },

    async createRule(actor: Actor, companyId: string, input: BankRuleInput) {
      await findCompany(prisma, actor.tenantId, companyId);
      await checkRule(companyId, input);
      const row = await prisma.bankRule.create({
        data: { tenantId: actor.tenantId, companyId, ...input },
      });
      return (await this.listRules(actor, companyId)).find((rule) => rule.id === row.id)!;
    },

    async updateRule(actor: Actor, companyId: string, ruleId: string, input: BankRuleInput) {
      await findCompany(prisma, actor.tenantId, companyId);
      await checkRule(companyId, input);
      const updated = await prisma.bankRule.updateMany({
        where: { id: ruleId, companyId },
        data: input,
      });
      if (updated.count === 0) throw errors.notFound('Bank rule');
      return (await this.listRules(actor, companyId)).find((rule) => rule.id === ruleId)!;
    },

    async deleteRule(actor: Actor, companyId: string, ruleId: string) {
      await findCompany(prisma, actor.tenantId, companyId);
      const deleted = await prisma.bankRule.deleteMany({ where: { id: ruleId, companyId } });
      if (deleted.count === 0) throw errors.notFound('Bank rule');
    },
  };
}

export type BankService = ReturnType<typeof createBankService>;
