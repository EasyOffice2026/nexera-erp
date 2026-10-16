import { z } from 'zod';
import type { AccountSubtype, AccountType } from './accounts';
import type { LocalizedName } from './localized';
import { isoDateSchema } from './periods';

export const reportQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  branchId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: LocalizedName;
  type: AccountType;
  subtype: AccountSubtype;
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  closingDebit: string;
  closingCredit: string;
}

export interface TrialBalance {
  from: string;
  to: string;
  rows: TrialBalanceRow[];
  totals: Omit<TrialBalanceRow, 'accountId' | 'code' | 'name' | 'type' | 'subtype'>;
}

export interface LedgerRow {
  journalId: string;
  number: number | null;
  date: string;
  description: string;
  reference: string;
  branchId: string | null;
  debit: string;
  credit: string;
  balance: string;
}

export interface AccountLedger {
  accountId: string;
  code: string;
  name: LocalizedName;
  from: string;
  to: string;
  opening: string;
  rows: LedgerRow[];
  closing: string;
}

export interface StatementLine {
  key: string;
  amount: string;
  accounts: { accountId: string; code: string; name: LocalizedName; amount: string }[];
}

export interface IncomeStatement {
  from: string;
  to: string;
  revenue: StatementLine[];
  totalRevenue: string;
  costOfSales: string;
  grossProfit: string;
  expenses: StatementLine[];
  totalExpenses: string;
  netProfit: string;
}

export interface BalanceSheet {
  asOf: string;
  assets: StatementLine[];
  totalAssets: string;
  liabilities: StatementLine[];
  totalLiabilities: string;
  equity: StatementLine[];
  // Profit not yet closed into retained earnings.
  currentYearProfit: string;
  totalEquity: string;
  balanced: boolean;
}

export const balanceSheetQuerySchema = z.object({
  asOf: isoDateSchema,
  branchId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
});
export type BalanceSheetQuery = z.infer<typeof balanceSheetQuerySchema>;
