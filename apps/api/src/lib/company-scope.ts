import type { LocalizedName } from '@nexera/shared';
import type { Prisma } from '../generated/prisma/client';
import { errors } from './http-errors';

type CompanyClient = Pick<Prisma.TransactionClient, 'company'>;

// The company of the request, only when it belongs to the person's tenant.
export async function findCompany(db: CompanyClient, tenantId: string, companyId: string) {
  const company = await db.company.findFirst({ where: { id: companyId, tenantId } });
  if (!company) throw errors.notFound('Company');
  return company;
}

// Bilingual names are stored as JSON and always have both languages (see localizedNameSchema).
export function asName(value: Prisma.JsonValue): LocalizedName {
  return value as LocalizedName;
}
