import type { AccountType } from '@nexera/shared';
import { asName } from '../../lib/company-scope';
import { errors } from '../../lib/http-errors';
import type { Prisma } from '../../generated/prisma/client';
import { chartTemplates, type ChartTemplateName } from '../companies/chart-template';

type Tx = Prisma.TransactionClient;

export const POSTING_ROLES = [
  'receivable',
  'revenue',
  'sales_returns',
  'receipts_clearing',
  'tax_payable',
  'opening_equity',
  'adjustments',
] as const;
export type PostingRole = (typeof POSTING_ROLES)[number];

// The template account each role uses unless the company already maps it to another account.
export const DEFAULT_PROFILE: Record<PostingRole, string> = {
  receivable: '1210',
  revenue: '4100',
  sales_returns: '4900',
  receipts_clearing: '1150',
  tax_payable: '2300',
  opening_equity: '3900',
  adjustments: '4950',
};

const ALLOWED_TYPES: Record<PostingRole, readonly AccountType[]> = {
  receivable: ['ASSET'],
  receipts_clearing: ['ASSET'],
  revenue: ['REVENUE'],
  sales_returns: ['REVENUE'],
  tax_payable: ['LIABILITY'],
  opening_equity: ['EQUITY'],
  adjustments: ['EQUITY', 'REVENUE', 'EXPENSE'],
};

interface AccountRow {
  id: string;
  companyId: string;
  code: string;
  name: Prisma.JsonValue;
  type: AccountType;
  isActive: boolean;
  isPostable: boolean;
}

export type PostingProfile = Record<
  PostingRole,
  { accountId: string; code: string; name: { en: string; ar: string } }
>;

// Whether an account may take the postings of a role.
export function fitsRole(role: PostingRole, account: AccountRow, companyId: string): boolean {
  return (
    account.companyId === companyId &&
    account.isActive &&
    account.isPostable &&
    ALLOWED_TYPES[role].includes(account.type)
  );
}

const accountSelect = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  type: true,
  isActive: true,
  isPostable: true,
} as const;

// Makes sure every CRM posting role of the company points at a usable account. A valid mapping
// is kept; otherwise the template account with the role's code is reused, or created (with its
// header) when the company has no account with that code. Existing accounts are never changed or
// deactivated: an account with the code but of the wrong type, or inactive, is a CHART_CONFLICT.
export async function ensureCrmAccountingDefaults(
  tx: Tx,
  tenantId: string,
  companyId: string,
  templateName: ChartTemplateName = 'general_business_v1',
): Promise<PostingProfile> {
  const template = new Map(chartTemplates[templateName].map((row) => [row.code, row]));
  const accounts = await tx.account.findMany({ where: { companyId }, select: accountSelect });
  const byCode = new Map<string, AccountRow>(accounts.map((row) => [row.code, row]));

  async function templateAccount(code: string): Promise<AccountRow> {
    const found = byCode.get(code);
    const spec = template.get(code);
    if (!spec) throw new Error(`Chart template ${templateName} has no account ${code}.`);
    if (found) {
      if (found.type !== spec.type) {
        throw errors.conflict(
          'CHART_CONFLICT',
          `Account ${code} exists with type ${found.type}; the template needs ${spec.type}`,
        );
      }
      return found;
    }
    const parent = spec.parent ? await templateAccount(spec.parent) : undefined;
    const created = await tx.account.create({
      data: {
        tenantId,
        companyId,
        code: spec.code,
        name: { en: spec.en, ar: spec.ar },
        type: spec.type,
        subtype: spec.subtype,
        parentId: parent?.id ?? null,
        isPostable: !spec.header,
        taxonomyConcept: spec.concept ?? null,
      },
      select: accountSelect,
    });
    byCode.set(code, created);
    return created;
  }

  const current = await tx.crmPostingProfile.findMany({
    where: { companyId },
    include: { account: { select: accountSelect } },
  });
  const mapped = new Map(current.map((row) => [row.role, row]));
  const profile = {} as PostingProfile;
  for (const role of POSTING_ROLES) {
    let account = mapped.get(role)?.account;
    if (!account || !fitsRole(role, account, companyId)) {
      const code = DEFAULT_PROFILE[role];
      account = await templateAccount(code);
      if (!fitsRole(role, account, companyId)) {
        throw errors.conflict(
          'CHART_CONFLICT',
          `Account ${code} cannot take ${role} postings: it is inactive, a header or of the wrong type`,
        );
      }
      await tx.crmPostingProfile.upsert({
        where: { companyId_role: { companyId, role } },
        create: { tenantId, companyId, role, accountId: account.id },
        update: { accountId: account.id },
      });
    }
    profile[role] = { accountId: account.id, code: account.code, name: asName(account.name) };
  }
  return profile;
}

// The company's current mapping, for the routes that read it. Roles that are not mapped to a
// usable account are left out.
export async function loadPostingProfile(
  db: Pick<Tx, 'crmPostingProfile'>,
  companyId: string,
): Promise<Partial<PostingProfile>> {
  const rows = await db.crmPostingProfile.findMany({
    where: { companyId },
    include: { account: { select: accountSelect } },
  });
  const profile: Partial<PostingProfile> = {};
  for (const row of rows) {
    const role = row.role as PostingRole;
    if (POSTING_ROLES.includes(role) && fitsRole(role, row.account, companyId)) {
      profile[role] = {
        accountId: row.account.id,
        code: row.account.code,
        name: asName(row.account.name),
      };
    }
  }
  return profile;
}
