import { z } from 'zod';
import type { LocalizedName } from './localized';
import { isoDateSchema } from './periods';

export const dashboardQuerySchema = z.object({
  asOf: isoDateSchema,
  branchId: z.string().uuid().optional(),
});
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

export interface DashboardFigures {
  revenue: string;
  costOfSales: string;
  grossProfit: string;
  // Expenses other than the cost of sales.
  expenses: string;
  netProfit: string;
}

export interface DateSpan {
  from: string;
  to: string;
}

// One row of a breakdown: an account, a branch or a brand. A null id is "no branch".
export interface DashboardAmount {
  id: string | null;
  code: string | null;
  name: LocalizedName | null;
  amount: string;
}

export interface DashboardBreakdown {
  revenueByBranch: DashboardAmount[];
  revenueByBrand: DashboardAmount[];
  revenueByChannel: DashboardAmount[];
  topExpenses: DashboardAmount[];
}

export interface DashboardTrendPoint {
  // YYYY-MM
  month: string;
  revenue: string;
  // Cost of sales and all other expenses.
  expenses: string;
  netProfit: string;
}

export interface Dashboard {
  asOf: string;
  spans: { month: DateSpan; previousMonth: DateSpan; yearToDate: DateSpan };
  figures: {
    month: DashboardFigures;
    previousMonth: DashboardFigures;
    yearToDate: DashboardFigures;
  };
  breakdown: { month: DashboardBreakdown; yearToDate: DashboardBreakdown };
  // Balances at asOf. Cash lists cash and bank accounts.
  cash: { total: string; accounts: DashboardAmount[] };
  receivables: string;
  payables: string;
  // The twelve months up to the month of asOf, oldest first.
  trend: DashboardTrendPoint[];
  alerts: {
    draftJournals: number;
    // Open periods that ended before the current month.
    unclosedPastPeriods: number;
    // False when no open period covers asOf, so nothing can be posted today.
    periodOpen: boolean;
  };
}
