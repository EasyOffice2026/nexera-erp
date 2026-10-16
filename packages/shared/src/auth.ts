import { z } from 'zod';

// owner: everything, including users. finance_manager: everything except users.
// accountant: day-to-day bookkeeping. auditor: read-only.
export const roles = ['owner', 'finance_manager', 'accountant', 'auditor'] as const;
export const roleSchema = z.enum(roles);
export type Role = z.infer<typeof roleSchema>;

export const permissions = [
  'users.manage',
  'companies.manage',
  'accounts.manage',
  'periods.manage',
  'journals.write',
  'journals.post',
  'integrations.manage',
  'reports.view',
] as const;
export type Permission = (typeof permissions)[number];

export const rolePermissions: Record<Role, readonly Permission[]> = {
  owner: permissions,
  finance_manager: permissions.filter((permission) => permission !== 'users.manage'),
  accountant: ['journals.write', 'journals.post', 'reports.view'],
  auditor: ['reports.view'],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return rolePermissions[role].includes(permission);
}

export const loginRequestSchema = z.object({
  tenant: z.string().trim().toLowerCase().min(1).max(60),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const accessTokenClaimsSchema = z.object({
  sub: z.string().uuid(),
  tenantId: z.string().uuid(),
  role: roleSchema,
});
export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

export const languageSchema = z.enum(['en', 'ar']);
export type Language = z.infer<typeof languageSchema>;

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  language: Language;
  tenant: { id: string; slug: string; name: string };
  permissions: Permission[];
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  user: SessionUser;
}

export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  fullName: z.string().trim().min(1).max(200),
  role: roleSchema,
  password: z.string().min(10).max(200),
  language: languageSchema.default('en'),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  fullName: z.string().trim().min(1).max(200).optional(),
  role: roleSchema.optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(10).max(200).optional(),
  language: languageSchema.optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
