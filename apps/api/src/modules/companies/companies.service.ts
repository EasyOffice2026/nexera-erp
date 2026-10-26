import type {
  Branch,
  Brand,
  Company,
  CreateBranchInput,
  CreateBrandInput,
  CreateCompanyInput,
  UpdateCompanyInput,
} from '@nexera/shared';
import { writeAudit } from '../../lib/audit';
import { asName, findCompany } from '../../lib/company-scope';
import { errors } from '../../lib/http-errors';
import type { PrismaClient } from '../../lib/prisma';
import type { Actor } from '../../middleware/authenticate';
import { Prisma } from '../../generated/prisma/client';
import { restaurantChartOfAccounts, type TemplateAccount } from './chart-template';

type CompanyRow = Prisma.CompanyGetPayload<object>;
type BrandRow = Prisma.BrandGetPayload<object>;
type BranchRow = Prisma.BranchGetPayload<object>;

function toCompany(row: CompanyRow): Company {
  return {
    id: row.id,
    name: asName(row.name),
    legalName: row.legalName,
    crNumber: row.crNumber,
    baseCurrency: row.baseCurrency,
    fiscalYearEndMonth: row.fiscalYearEndMonth,
    isActive: row.isActive,
  };
}

function toBrand(row: BrandRow): Brand {
  return { id: row.id, companyId: row.companyId, name: asName(row.name), isActive: row.isActive };
}

function toBranch(row: BranchRow): Branch {
  return {
    id: row.id,
    companyId: row.companyId,
    brandId: row.brandId,
    code: row.code,
    name: asName(row.name),
    isActive: row.isActive,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

// Creates the template accounts of a new company, headers first so children find their parent.
export async function seedChartOfAccounts(
  tx: Prisma.TransactionClient,
  tenantId: string,
  companyId: string,
  template: readonly TemplateAccount[] = restaurantChartOfAccounts,
) {
  const ids = new Map<string, string>();
  for (const account of template) {
    const parentId = account.parent ? ids.get(account.parent) : undefined;
    if (account.parent && !parentId) {
      throw new Error(
        `Template account ${account.code} comes before its parent ${account.parent}.`,
      );
    }
    const row = await tx.account.create({
      data: {
        tenantId,
        companyId,
        code: account.code,
        name: { en: account.en, ar: account.ar },
        type: account.type,
        subtype: account.subtype,
        parentId: parentId ?? null,
        isPostable: !account.header,
        taxonomyConcept: account.concept ?? null,
      },
      select: { id: true },
    });
    ids.set(account.code, row.id);
  }
}

export function createCompaniesService(deps: { prisma: PrismaClient }) {
  const { prisma } = deps;

  return {
    async list(actor: Actor): Promise<Company[]> {
      const rows = await prisma.company.findMany({
        where: { tenantId: actor.tenantId },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(toCompany);
    },

    async get(actor: Actor, id: string): Promise<Company> {
      return toCompany(await findCompany(prisma, actor.tenantId, id));
    },

    async create(actor: Actor, input: CreateCompanyInput): Promise<Company> {
      try {
        const company = await prisma.$transaction(async (tx) => {
          const row = await tx.company.create({
            data: {
              tenantId: actor.tenantId,
              name: input.name,
              legalName: input.legalName,
              crNumber: input.crNumber,
              baseCurrency: input.baseCurrency,
              fiscalYearEndMonth: input.fiscalYearEndMonth,
            },
          });
          if (input.useTemplate) await seedChartOfAccounts(tx, actor.tenantId, row.id);
          await writeAudit(tx, {
            tenantId: actor.tenantId,
            userId: actor.userId,
            action: 'company.create',
            entityType: 'company',
            entityId: row.id,
            data: { crNumber: row.crNumber, useTemplate: input.useTemplate },
            ip: actor.ip,
          });
          return row;
        });
        return toCompany(company);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.conflict('CR_NUMBER_TAKEN', 'A company with this CR number already exists');
        }
        throw error;
      }
    },

    async update(actor: Actor, id: string, input: UpdateCompanyInput): Promise<Company> {
      await findCompany(prisma, actor.tenantId, id);
      try {
        const row = await prisma.company.update({
          where: { id },
          data: {
            name: input.name,
            legalName: input.legalName,
            crNumber: input.crNumber,
            isActive: input.isActive,
          },
        });
        await writeAudit(prisma, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          action: 'company.update',
          entityType: 'company',
          entityId: id,
          data: { ...input },
          ip: actor.ip,
        });
        return toCompany(row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.conflict('CR_NUMBER_TAKEN', 'A company with this CR number already exists');
        }
        throw error;
      }
    },

    async listBrands(actor: Actor, companyId: string): Promise<Brand[]> {
      await findCompany(prisma, actor.tenantId, companyId);
      const rows = await prisma.brand.findMany({
        where: { companyId },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(toBrand);
    },

    async createBrand(actor: Actor, companyId: string, input: CreateBrandInput): Promise<Brand> {
      await findCompany(prisma, actor.tenantId, companyId);
      const row = await prisma.brand.create({
        data: { tenantId: actor.tenantId, companyId, name: input.name },
      });
      await writeAudit(prisma, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        action: 'brand.create',
        entityType: 'brand',
        entityId: row.id,
        ip: actor.ip,
      });
      return toBrand(row);
    },

    async listBranches(actor: Actor, companyId: string): Promise<Branch[]> {
      await findCompany(prisma, actor.tenantId, companyId);
      const rows = await prisma.branch.findMany({ where: { companyId }, orderBy: { code: 'asc' } });
      return rows.map(toBranch);
    },

    async createBranch(actor: Actor, companyId: string, input: CreateBranchInput): Promise<Branch> {
      await findCompany(prisma, actor.tenantId, companyId);
      const brand = await prisma.brand.findFirst({ where: { id: input.brandId, companyId } });
      if (!brand) throw errors.notFound('Brand');
      try {
        const row = await prisma.branch.create({
          data: {
            tenantId: actor.tenantId,
            companyId,
            brandId: brand.id,
            code: input.code,
            name: input.name,
          },
        });
        await writeAudit(prisma, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          action: 'branch.create',
          entityType: 'branch',
          entityId: row.id,
          data: { code: row.code },
          ip: actor.ip,
        });
        return toBranch(row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.conflict('BRANCH_CODE_TAKEN', 'A branch with this code already exists');
        }
        throw error;
      }
    },
  };
}

export type CompaniesService = ReturnType<typeof createCompaniesService>;
