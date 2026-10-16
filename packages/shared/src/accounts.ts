import { z } from 'zod';
import { localizedNameSchema, type LocalizedName } from './localized';

export const accountTypes = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const;
export const accountTypeSchema = z.enum(accountTypes);
export type AccountType = z.infer<typeof accountTypeSchema>;

// Where an account appears in the IFRS statements.
export const accountSubtypes = {
  ASSET: [
    'cash',
    'bank',
    'receivable',
    'inventory',
    'prepayment',
    'other_current_asset',
    'fixed_asset',
    'accumulated_depreciation',
    'right_of_use_asset',
    'other_non_current_asset',
  ],
  LIABILITY: [
    'payable',
    'accrued_liability',
    'other_current_liability',
    'lease_liability',
    'employee_benefits',
    'other_non_current_liability',
  ],
  EQUITY: ['share_capital', 'reserve', 'retained_earnings', 'owner_current_account'],
  REVENUE: ['sales', 'sales_deduction', 'other_income'],
  EXPENSE: ['cost_of_sales', 'operating_expense', 'depreciation', 'finance_cost', 'other_expense'],
} as const satisfies Record<AccountType, readonly string[]>;

export type AccountSubtype = (typeof accountSubtypes)[AccountType][number];

export const allAccountSubtypes: AccountSubtype[] = Object.values(accountSubtypes).flat();

export function isSubtypeOf(type: AccountType, subtype: string): subtype is AccountSubtype {
  return (accountSubtypes[type] as readonly string[]).includes(subtype);
}

// Assets and expenses grow with debits; the others with credits.
export function isDebitNormal(type: AccountType): boolean {
  return type === 'ASSET' || type === 'EXPENSE';
}

export const ACCOUNT_CODE_PATTERN = /^\d{2,10}$/;

const accountFields = {
  code: z.string().trim().regex(ACCOUNT_CODE_PATTERN, 'Use 2 to 10 digits'),
  name: localizedNameSchema,
  type: accountTypeSchema,
  subtype: z.string().trim().min(1),
  parentId: z.string().uuid().nullable().default(null),
  // A header groups other accounts; only postable accounts take journal lines.
  isPostable: z.boolean().default(true),
  // The IFRS / Qayd taxonomy element this account reports under, for example
  // "ifrs-full:CashAndCashEquivalents".
  taxonomyConcept: z
    .string()
    .trim()
    .regex(/^[A-Za-z][\w.-]*:[A-Za-z_][\w.-]*$/, 'Use prefix:Element')
    .nullable()
    .default(null),
};

export const createAccountSchema = z
  .object(accountFields)
  .refine((value) => isSubtypeOf(value.type, value.subtype), {
    path: ['subtype'],
    message: 'The subtype does not belong to the account type',
  });
export type CreateAccountInput = z.infer<typeof createAccountSchema>;

export const updateAccountSchema = z.object({
  name: localizedNameSchema.optional(),
  subtype: z.string().trim().min(1).optional(),
  parentId: z.string().uuid().nullable().optional(),
  isPostable: z.boolean().optional(),
  taxonomyConcept: accountFields.taxonomyConcept.optional(),
  isActive: z.boolean().optional(),
});
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

export interface Account {
  id: string;
  companyId: string;
  code: string;
  name: LocalizedName;
  type: AccountType;
  subtype: AccountSubtype;
  parentId: string | null;
  isPostable: boolean;
  isActive: boolean;
  taxonomyConcept: string | null;
}
