import { z } from 'zod';
import { isoDateSchema } from './periods';

export const xbrlQuerySchema = z.object({ from: isoDateSchema, to: isoDateSchema });
export type XbrlQuery = z.infer<typeof xbrlQuerySchema>;

export const xbrlCheckCodes = [
  'TRIAL_BALANCE_BALANCED',
  'BALANCE_SHEET_BALANCED',
  'ALL_BALANCES_TAGGED',
  'NO_TOTALS_TAGGED',
  'IFRS_ELEMENTS_ONLY',
  'FULL_FINANCIAL_YEAR',
  'PERIODS_CLOSED',
  'NO_DRAFTS',
] as const;
export type XbrlCheckCode = (typeof xbrlCheckCodes)[number];

// An error stops the file being prepared; a warning is shown but allows it.
export interface XbrlCheck {
  code: XbrlCheckCode;
  severity: 'error' | 'warning';
  ok: boolean;
  // The account codes that cause a failed check, when it is about accounts.
  accounts: string[];
}

export interface XbrlFact {
  // The taxonomy element, for example ifrs-full:Revenue.
  concept: string;
  period: 'current' | 'prior';
  // An amount at the end of the period (balance sheet) or for the whole period.
  instant: boolean;
  value: string;
  // The account codes the amount comes from; empty for totals worked out from the statements.
  accounts: string[];
}

export interface XbrlPreview {
  companyId: string;
  legalName: string;
  crNumber: string;
  currency: string;
  from: string;
  to: string;
  prior: { from: string; to: string } | null;
  taxonomy: { name: string; version: string; entryPoint: string };
  ready: boolean;
  checks: XbrlCheck[];
  facts: XbrlFact[];
}
