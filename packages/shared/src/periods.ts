import { z } from 'zod';

export const isoDateSchema = z.iso.date();

export const periodStatuses = ['OPEN', 'CLOSED'] as const;
export type PeriodStatus = (typeof periodStatuses)[number];

// Opens a financial year of 12 monthly periods, starting on the first day of startMonth.
export const createFiscalYearSchema = z.object({
  startDate: isoDateSchema.refine((value) => value.endsWith('-01'), 'Start on the 1st of a month'),
});
export type CreateFiscalYearInput = z.infer<typeof createFiscalYearSchema>;

export const setPeriodStatusSchema = z.object({ status: z.enum(periodStatuses) });

export interface Period {
  id: string;
  number: number;
  startDate: string;
  endDate: string;
  status: PeriodStatus;
}

export interface FiscalYear {
  id: string;
  companyId: string;
  name: string;
  startDate: string;
  endDate: string;
  status: PeriodStatus;
  periods: Period[];
}
