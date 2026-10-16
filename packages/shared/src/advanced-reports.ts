import { z } from 'zod';
import type { AccountSubtype } from './accounts';
import { type JournalSource, journalSources } from './journals';
import type { LocalizedName } from './localized';
import { isoDateSchema } from './periods';
import { reportQuerySchema } from './reports';

export const columnModes = ['none', 'month', 'quarter', 'branch', 'brand'] as const;
export type ColumnMode = (typeof columnModes)[number];

export const compareModes = ['none', 'previousPeriod', 'previousYear'] as const;
export type CompareMode = (typeof compareModes)[number];

export const comparativeQuerySchema = reportQuerySchema.extend({
  columns: z.enum(columnModes).default('none'),
  compare: z.enum(compareModes).default('none'),
});
export type ComparativeQuery = z.infer<typeof comparativeQuerySchema>;

export const groupReportQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  compare: z.enum(compareModes).default('none'),
});
export type GroupReportQuery = z.infer<typeof groupReportQuerySchema>;

// One amount column of a multi-column report. "variance" is total minus comparison.
export interface ReportColumn {
  key: string;
  kind:
    'period' | 'branch' | 'brand' | 'company' | 'unassigned' | 'total' | 'comparison' | 'variance';
  name: LocalizedName | null;
  from: string;
  to: string;
  branchId: string | null;
  brandId: string | null;
  companyId: string | null;
}

export interface ColumnAccount {
  // Null in the group report, where one row adds the same account code of every company.
  accountId: string | null;
  code: string;
  name: LocalizedName;
  amounts: string[];
}

export interface ColumnLine {
  key: AccountSubtype;
  amounts: string[];
  accounts: ColumnAccount[];
}

// Amounts are in the same order as the columns.
export interface ColumnIncomeStatement {
  from: string;
  to: string;
  columns: ReportColumn[];
  revenue: ColumnLine[];
  totalRevenue: string[];
  costOfSales: ColumnLine[];
  totalCostOfSales: string[];
  grossProfit: string[];
  expenses: ColumnLine[];
  totalExpenses: string[];
  netProfit: string[];
}

export const cashFlowQuerySchema = z.object({ from: isoDateSchema, to: isoDateSchema });
export type CashFlowQuery = z.infer<typeof cashFlowQuerySchema>;

export const cashFlowSections = ['operating', 'investing', 'financing'] as const;
export type CashFlowSection = (typeof cashFlowSections)[number];

export interface CashFlowLine {
  key: AccountSubtype;
  amount: string;
  accounts: { accountId: string; code: string; name: LocalizedName; amount: string }[];
}

// Indirect method: profit, plus non-cash items, plus the change in every other balance.
export interface CashFlowStatement {
  from: string;
  to: string;
  netProfit: string;
  operating: { lines: CashFlowLine[]; total: string };
  investing: { lines: CashFlowLine[]; total: string };
  financing: { lines: CashFlowLine[]; total: string };
  netChange: string;
  openingCash: string;
  closingCash: string;
  // Opening cash plus the net change equals the closing cash in the books.
  balanced: boolean;
}

export const journalRegisterQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  branchId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  source: z.enum(journalSources).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});
export type JournalRegisterQuery = z.infer<typeof journalRegisterQuerySchema>;

export interface RegisterLine {
  accountId: string;
  code: string;
  name: LocalizedName;
  branchId: string | null;
  branchName: LocalizedName | null;
  description: string;
  debit: string;
  credit: string;
}

export interface RegisterEntry {
  id: string;
  number: number | null;
  date: string;
  description: string;
  reference: string;
  source: JournalSource;
  lines: RegisterLine[];
  totalDebit: string;
  totalCredit: string;
}

export interface JournalRegister {
  from: string;
  to: string;
  entries: RegisterEntry[];
  page: number;
  pageSize: number;
  total: number;
  // For every journal that matches the filter, not only this page.
  totalDebit: string;
  totalCredit: string;
}
