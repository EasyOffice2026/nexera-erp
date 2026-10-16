import { z } from 'zod';
import type { LocalizedName } from './localized';
import { fromFils, toFils } from './money';
import { isoDateSchema } from './periods';

// Bank statements are imported from any bank's Excel or CSV file. The file is read into rows of
// text and a column mapping says which column holds what. Amounts are signed: positive is money
// into the bank (a debit on the bank account in the books), negative is money out.

export const kuwaitiBanks = [
  'National Bank of Kuwait (NBK)',
  'Kuwait Finance House (KFH)',
  'Boubyan Bank',
  'Burgan Bank',
  'Gulf Bank',
  'Commercial Bank of Kuwait (CBK)',
  'Al Ahli Bank of Kuwait (ABK)',
  'Kuwait International Bank (KIB)',
  'Warba Bank',
] as const;

export const SIGNED_AMOUNT_PATTERN = /^-?\d{1,15}(\.\d{1,3})?$/;
export const signedAmountSchema = z
  .string()
  .trim()
  .regex(SIGNED_AMOUNT_PATTERN, 'Must be an amount with up to 3 decimals');

export const dateOrders = ['DMY', 'MDY', 'YMD'] as const;
export type DateOrder = (typeof dateOrders)[number];

const column = z.number().int().min(0).max(99);

export const bankMappingSchema = z
  .object({
    // The row with the column headings (0-based); the transactions are the rows below it.
    headerRow: z.number().int().min(-1).max(200),
    date: column,
    dateOrder: z.enum(dateOrders).default('DMY'),
    description: column,
    reference: column.nullable().default(null),
    // "signed": one amount column; "split": separate money-out (debit) and money-in (credit) columns.
    amountMode: z.enum(['signed', 'split']),
    amount: column.nullable().default(null),
    moneyOut: column.nullable().default(null),
    moneyIn: column.nullable().default(null),
    balance: column.nullable().default(null),
    // For banks that show money out as positive in a signed column.
    negate: z.boolean().default(false),
  })
  .refine(
    (m) =>
      m.amountMode === 'signed' ? m.amount !== null : m.moneyOut !== null && m.moneyIn !== null,
    { message: 'Choose the amount column, or both the money-out and money-in columns' },
  );
export type BankMapping = z.infer<typeof bankMappingSchema>;

const ARABIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;

function westernDigits(text: string): string {
  return text
    .replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10))
    .replace(/\u066B/g, '.')
    .replace(/\u066C/g, ',');
}

// "1,234.500", "(12.5)", "12.500-", "12.500 DR", "KWD 12.5", "١٢٫٥" -> signed fils, or null.
export function parseAmount(raw: string): bigint | null {
  let text = westernDigits(raw).trim().toUpperCase();
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (/\bDR\.?$/.test(text)) {
    negative = true;
    text = text.replace(/\bDR\.?$/, '');
  }
  text = text.replace(/\bCR\.?$/, '');
  text = text.replace(/KWD|KD|د\.ك|دينار/g, '').replace(/[\s,\u00A0]/g, '');
  if (text.endsWith('-')) {
    negative = !negative;
    text = text.slice(0, -1);
  }
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }
  if (!/^\d{1,15}(\.\d+)?$/.test(text)) return null;
  const [whole = '0', fraction = ''] = text.split('.');
  if (fraction.length > 3 && /[1-9]/.test(fraction.slice(3))) return null;
  const fils = toFils(`${whole}.${fraction.slice(0, 3)}`);
  return negative ? -fils : fils;
}

const months: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
  يناير: 1,
  فبراير: 2,
  مارس: 3,
  أبريل: 4,
  ابريل: 4,
  مايو: 5,
  يونيو: 6,
  يوليو: 7,
  أغسطس: 8,
  اغسطس: 8,
  سبتمبر: 9,
  أكتوبر: 10,
  اكتوبر: 10,
  نوفمبر: 11,
  ديسمبر: 12,
};

function isoOf(year: number, month: number, day: number): string | null {
  if (year < 100) year += 2000;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

// Reads the date styles banks use. Numbers between 20000 and 80000 are Excel day serials.
export function parseStatementDate(raw: string, order: DateOrder): string | null {
  const text = westernDigits(raw).trim().toLowerCase();
  if (!text) return null;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[t\s].*)?$/.exec(text);
  if (match) return isoOf(Number(match[1]), Number(match[2]), Number(match[3]));
  if (/^\d{5}(\.\d+)?$/.test(text)) {
    const serial = Math.floor(Number(text));
    if (serial < 20000 || serial > 80000) return null;
    return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
  }
  match = /^(\d{1,2})[\s\-/.]+([a-z\u0600-\u06ff]{3,})\.?[\s\-/.,]+(\d{2,4})/.exec(text);
  if (match) {
    const month = months[match[2]!] ?? months[match[2]!.slice(0, 3)];
    return month ? isoOf(Number(match[3]), month, Number(match[1])) : null;
  }
  match = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})(?:\s.*)?$/.exec(text);
  if (!match) return null;
  const [a, b, c] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (match[1]!.length === 4) return isoOf(a, b, c);
  return order === 'MDY' ? isoOf(c, a, b) : isoOf(c, b, a);
}

const headings = {
  date: ['transaction date', 'posting date', 'date', 'التاريخ', 'تاريخ'],
  description: [
    'description',
    'details',
    'narration',
    'narrative',
    'particulars',
    'remarks',
    'transaction',
    'البيان',
    'الوصف',
    'التفاصيل',
    'الشرح',
    'بيان',
  ],
  reference: ['reference', 'ref', 'cheque', 'check', 'المرجع', 'مرجع', 'رقم الشيك'],
  moneyOut: [
    'debit',
    'withdrawal',
    'money out',
    'paid out',
    'مدين',
    'المدين',
    'سحب',
    'مسحوبات',
    'السحب',
  ],
  moneyIn: [
    'credit',
    'deposit',
    'money in',
    'paid in',
    'دائن',
    'الدائن',
    'إيداع',
    'ايداع',
    'إيداعات',
    'الإيداع',
  ],
  amount: ['amount', 'المبلغ', 'مبلغ'],
  balance: ['balance', 'الرصيد', 'رصيد'],
} as const;

// Finds the heading row and the columns from English or Arabic headings, for a first suggestion.
export function guessMapping(rows: readonly (readonly string[])[]): BankMapping | null {
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const cells = (rows[r] ?? []).map((cell) => westernDigits(cell).trim().toLowerCase());
    const used = new Set<number>();
    const find = (key: keyof typeof headings): number | null => {
      for (const word of headings[key]) {
        const index = cells.findIndex((cell, i) => !used.has(i) && cell.includes(word));
        if (index >= 0) {
          used.add(index);
          return index;
        }
      }
      return null;
    };
    const date = find('date');
    if (date === null) continue;
    const balance = find('balance');
    const moneyOut = find('moneyOut');
    const moneyIn = find('moneyIn');
    const amount = moneyOut === null || moneyIn === null ? find('amount') : null;
    const reference = find('reference');
    const description = find('description');
    if (description === null || ((moneyOut === null || moneyIn === null) && amount === null))
      continue;
    const split = moneyOut !== null && moneyIn !== null;
    return {
      headerRow: r,
      date,
      dateOrder: 'DMY',
      description,
      reference,
      amountMode: split ? 'split' : 'signed',
      amount: split ? null : amount,
      moneyOut: split ? moneyOut : null,
      moneyIn: split ? moneyIn : null,
      balance,
      negate: false,
    };
  }
  return null;
}

export interface ParsedBankLine {
  row: number;
  date: string;
  description: string;
  reference: string;
  amount: string;
  balance: string | null;
}

export type SkipReason = 'NO_DATE' | 'NO_AMOUNT' | 'BAD_AMOUNT';

// Turns the rows below the heading row into statement lines. Rows without a date (opening and
// closing balance rows, page footers) and rows without an amount are skipped and reported.
export function applyMapping(
  rows: readonly (readonly string[])[],
  mapping: BankMapping,
): { lines: ParsedBankLine[]; skipped: { row: number; reason: SkipReason }[] } {
  const lines: ParsedBankLine[] = [];
  const skipped: { row: number; reason: SkipReason }[] = [];
  const cell = (row: readonly string[], index: number | null) =>
    index === null ? '' : (row[index] ?? '').trim();
  for (let r = mapping.headerRow + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    if (row.every((value) => !value.trim())) continue;
    const date = parseStatementDate(cell(row, mapping.date), mapping.dateOrder);
    if (!date) {
      skipped.push({ row: r + 1, reason: 'NO_DATE' });
      continue;
    }
    let fils: bigint | null;
    if (mapping.amountMode === 'signed') {
      fils = parseAmount(cell(row, mapping.amount));
    } else {
      const outText = cell(row, mapping.moneyOut);
      const inText = cell(row, mapping.moneyIn);
      const out = outText ? parseAmount(outText) : 0n;
      const into = inText ? parseAmount(inText) : 0n;
      fils = out === null || into === null ? null : into - (out < 0n ? -out : out);
      if (!outText && !inText) fils = 0n;
    }
    if (fils === null) {
      skipped.push({ row: r + 1, reason: 'BAD_AMOUNT' });
      continue;
    }
    if (mapping.negate) fils = -fils;
    if (fils === 0n) {
      skipped.push({ row: r + 1, reason: 'NO_AMOUNT' });
      continue;
    }
    const balance = parseAmount(cell(row, mapping.balance));
    lines.push({
      row: r + 1,
      date,
      description: cell(row, mapping.description).replace(/\s+/g, ' ').slice(0, 500),
      reference: cell(row, mapping.reference).slice(0, 100),
      amount: fromFils(fils),
      balance: balance === null ? null : fromFils(balance),
    });
  }
  return { lines, skipped };
}

export const bankAccountInputSchema = z.object({
  accountId: z.string().uuid(),
  bankName: z.string().trim().min(1).max(100),
  accountNumber: z.string().trim().max(50).default(''),
  // The balance at the bank before the first statement line that will be imported.
  openingBalance: signedAmountSchema.default('0'),
});
export type BankAccountInput = z.infer<typeof bankAccountInputSchema>;

export const importStatementSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  rows: z
    .array(z.array(z.string().max(1000)).max(60))
    .min(1)
    .max(20000),
  mapping: bankMappingSchema,
});
export type ImportStatementInput = z.infer<typeof importStatementSchema>;

export const bankLineStatuses = ['unmatched', 'matched'] as const;
export type BankLineStatus = (typeof bankLineStatuses)[number];

export const listBankLinesQuerySchema = z.object({
  status: z.enum(bankLineStatuses).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const matchBankLineSchema = z.object({ journalLineId: z.string().uuid() });

export const bankLineJournalSchema = z.object({
  accountId: z.string().uuid(),
  branchId: z.string().uuid().nullable().default(null),
  description: z.string().trim().max(500).optional(),
});
export type BankLineJournalInput = z.infer<typeof bankLineJournalSchema>;

export const bankDirections = ['ANY', 'IN', 'OUT'] as const;
export type BankDirection = (typeof bankDirections)[number];

export const bankRuleInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  // Matched without regard to case against the statement line's description and reference.
  contains: z.string().trim().min(2).max(100),
  direction: z.enum(bankDirections).default('ANY'),
  accountId: z.string().uuid(),
  branchId: z.string().uuid().nullable().default(null),
  bankAccountId: z.string().uuid().nullable().default(null),
  priority: z.number().int().min(1).max(1000).default(100),
  isActive: z.boolean().default(true),
});
export type BankRuleInput = z.infer<typeof bankRuleInputSchema>;

export const reconciliationQuerySchema = z.object({ asOf: isoDateSchema });
export const lockReconciliationSchema = z.object({ asOf: isoDateSchema });

export interface BankAccountSummary {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: LocalizedName;
  bankName: string;
  accountNumber: string;
  currency: string;
  openingBalance: string;
  reconciledUntil: string | null;
  mapping: BankMapping | null;
  bookBalance: string;
  statementBalance: string;
  unmatchedCount: number;
  lastLineDate: string | null;
}

export interface BankLine {
  id: string;
  date: string;
  description: string;
  reference: string;
  amount: string;
  balance: string | null;
  status: BankLineStatus;
  journalId: string | null;
  journalNumber: number | null;
  ruleName: string | null;
  locked: boolean;
}

export interface BankCandidate {
  journalLineId: string;
  journalId: string;
  journalNumber: number | null;
  date: string;
  description: string;
  reference: string;
  amount: string;
  score: number;
}

export interface BankImportResult {
  statementId: string;
  imported: number;
  duplicates: number;
  skipped: { row: number; reason: SkipReason }[];
  autoMatched: number;
  ruleJournals: number;
}

export interface BankRule {
  id: string;
  name: string;
  contains: string;
  direction: BankDirection;
  accountId: string;
  accountCode: string;
  branchId: string | null;
  bankAccountId: string | null;
  priority: number;
  isActive: boolean;
}

export interface BookItem {
  journalLineId: string;
  journalId: string;
  journalNumber: number | null;
  date: string;
  description: string;
  amount: string;
}

// Book balance + bank items not in the books - book items not at the bank = statement balance.
export interface BankReconciliation {
  asOf: string;
  bookBalance: string;
  statementBalance: string;
  bankBalanceColumn: string | null;
  unmatchedBank: BankLine[];
  unmatchedBankTotal: string;
  unmatchedBook: BookItem[];
  unmatchedBookTotal: string;
  difference: string;
  reconciledUntil: string | null;
  canLock: boolean;
}
