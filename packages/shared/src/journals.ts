import { z } from 'zod';
import { amountSchema, toFils } from './money';
import { isoDateSchema } from './periods';

export const journalStatuses = ['DRAFT', 'POSTED'] as const;
export type JournalStatus = (typeof journalStatuses)[number];

export const journalSources = ['MANUAL', 'OPENING', 'REVERSAL', 'INTEGRATION'] as const;
export type JournalSource = (typeof journalSources)[number];

export const journalLineSchema = z
  .object({
    accountId: z.string().uuid(),
    branchId: z.string().uuid().nullable().default(null),
    description: z.string().trim().max(500).default(''),
    debit: amountSchema.default('0'),
    credit: amountSchema.default('0'),
  })
  .refine((line) => toFils(line.debit) > 0n !== toFils(line.credit) > 0n, {
    message: 'Each line needs either a debit or a credit',
  });
export type JournalLineInput = z.infer<typeof journalLineSchema>;

export const journalInputSchema = z.object({
  date: isoDateSchema,
  description: z.string().trim().min(1).max(500),
  reference: z.string().trim().max(100).default(''),
  source: z.enum(['MANUAL', 'OPENING']).default('MANUAL'),
  lines: z.array(journalLineSchema).min(2).max(500),
});
export type JournalInput = z.infer<typeof journalInputSchema>;

export const reverseJournalSchema = z.object({
  date: isoDateSchema,
  description: z.string().trim().max(500).optional(),
});

export const listJournalsQuerySchema = z.object({
  status: z.enum(journalStatuses).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export interface JournalLine {
  id: string;
  lineNo: number;
  accountId: string;
  accountCode: string;
  accountName: { en: string; ar: string };
  branchId: string | null;
  description: string;
  debit: string;
  credit: string;
}

export interface Journal {
  id: string;
  companyId: string;
  number: number | null;
  date: string;
  description: string;
  reference: string;
  source: JournalSource;
  sourceSystem: string | null;
  externalId: string | null;
  status: JournalStatus;
  totalDebit: string;
  totalCredit: string;
  reversesId: string | null;
  reversedById: string | null;
  createdAt: string;
  postedAt: string | null;
  lines: JournalLine[];
}

export interface JournalSummary {
  id: string;
  number: number | null;
  date: string;
  description: string;
  reference: string;
  source: JournalSource;
  status: JournalStatus;
  totalDebit: string;
  reversedById: string | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
