import { z } from 'zod';
import { localizedNameSchema, type LocalizedName } from './localized';

// A company is one legal entity (one Commercial Registration), which files its own statements.
export const createCompanySchema = z.object({
  name: localizedNameSchema,
  legalName: z.string().trim().min(1).max(300),
  crNumber: z.string().trim().min(1).max(50),
  baseCurrency: z.string().trim().length(3).toUpperCase().default('KWD'),
  fiscalYearEndMonth: z.number().int().min(1).max(12).default(12),
  // Seeds the standard IFRS chart of accounts for restaurants.
  useTemplate: z.boolean().default(true),
});
export type CreateCompanyInput = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = z.object({
  name: localizedNameSchema.optional(),
  legalName: z.string().trim().min(1).max(300).optional(),
  crNumber: z.string().trim().min(1).max(50).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;

export const createBrandSchema = z.object({ name: localizedNameSchema });
export type CreateBrandInput = z.infer<typeof createBrandSchema>;

export const createBranchSchema = z.object({
  brandId: z.string().uuid(),
  code: z.string().trim().min(1).max(20),
  name: localizedNameSchema,
});
export type CreateBranchInput = z.infer<typeof createBranchSchema>;

export interface Company {
  id: string;
  name: LocalizedName;
  legalName: string;
  crNumber: string;
  baseCurrency: string;
  fiscalYearEndMonth: number;
  isActive: boolean;
}

export interface Brand {
  id: string;
  companyId: string;
  name: LocalizedName;
  isActive: boolean;
}

export interface Branch {
  id: string;
  companyId: string;
  brandId: string;
  code: string;
  name: LocalizedName;
  isActive: boolean;
}
