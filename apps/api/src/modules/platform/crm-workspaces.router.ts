import { localizedNameSchema } from '@nexera/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../../config';
import { Prisma } from '../../generated/prisma/client';
import { writeAudit } from '../../lib/audit';
import { canonicalJson, sha256Hex } from '../../lib/canonical-json';
import { formatDate, parseDate } from '../../lib/dates';
import { errors } from '../../lib/http-errors';
import type { PrismaClient } from '../../lib/prisma';
import { parseWith } from '../../lib/validate';
import { platformAuth } from '../../middleware/platform-auth';
import { generalBusinessChartOfAccounts } from '../companies/chart-template';
import { seedChartOfAccounts } from '../companies/companies.service';
import { insertFiscalYear } from '../periods/periods.service';
import {
  ensureCrmAccountingDefaults,
  loadPostingProfile,
  type PostingProfile,
} from './crm-defaults';

type Tx = Prisma.TransactionClient;
type Binding = Prisma.CrmWorkspaceBindingGetPayload<object>;

const idSchema = z.string().uuid();
const provisionSchema = z
  .object({
    tenant: z
      .object({
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
        name: z.string().trim().min(1).max(200),
      })
      .strict(),
    company: z
      .object({
        legalName: z.string().trim().min(1).max(300),
        name: localizedNameSchema.strict(),
        crNumber: z.string().trim().min(1).max(50),
        fiscalYearEndMonth: z.number().int().min(1).max(12).default(12),
        firstFiscalYearStart: z.iso.date(),
      })
      .strict(),
    currency: z.literal('KWD'),
    chartTemplate: z.literal('general_business_v1'),
  })
  .strict()
  .superRefine((value, ctx) => {
    const start = parseDate(value.company.firstFiscalYearStart);
    const expectedMonth = (value.company.fiscalYearEndMonth % 12) + 1;
    if (start.getUTCDate() !== 1 || start.getUTCMonth() + 1 !== expectedMonth) {
      ctx.addIssue({
        code: 'custom',
        path: ['company', 'firstFiscalYearStart'],
        message: `The first financial year must start on the 1st of month ${expectedMonth}`,
      });
    }
  });
type ProvisionInput = z.output<typeof provisionSchema>;
const credentialSchema = z.object({ tokenSha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

// One provisioning step at a time per workspace (and per tenant slug), in every API process.
async function lock(tx: Tx, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

async function ensureFiscalYear(
  tx: Tx,
  binding: Pick<Binding, 'tenantId' | 'companyId'>,
  start: Date,
) {
  const covering = await tx.fiscalYear.findFirst({
    where: { companyId: binding.companyId, startDate: { lte: start }, endDate: { gte: start } },
  });
  if (!covering) await insertFiscalYear(tx, binding.tenantId, binding.companyId, start);
}

async function view(tx: Tx, binding: Binding, profile: PostingProfile) {
  const years = await tx.fiscalYear.findMany({
    where: { companyId: binding.companyId },
    orderBy: { startDate: 'asc' },
  });
  return {
    bindingId: binding.id,
    workspaceId: binding.workspaceId,
    tenantId: binding.tenantId,
    companyId: binding.companyId,
    status: binding.status,
    currency: 'KWD',
    fiscalYears: years.map((year) => ({
      start: formatDate(year.startDate),
      end: formatDate(year.endDate),
    })),
    profile: Object.fromEntries(
      Object.entries(profile).map(([role, account]) => [
        role,
        { accountId: account.accountId, code: account.code },
      ]),
    ),
  };
}

const transactionOptions = { maxWait: 30_000, timeout: 60_000 };

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

// The provider's API for hosted CRM workspaces: each workspace gets its own tenant and legal
// company with the general business chart, a fiscal year and CRM posting defaults, and the
// hashes of the service tokens its CRM backend uses. No person and no password is created here.
export function createPlatformRouter(deps: {
  prisma: PrismaClient;
  config: Config;
  now?: () => Date;
}) {
  const { prisma, config } = deps;
  const router = Router();
  router.use(platformAuth(config, deps.now));

  function audit(
    tx: Tx,
    binding: Pick<Binding, 'tenantId' | 'id' | 'workspaceId'>,
    keyId: string,
    action: string,
    ip: string | null,
    data: Record<string, string> = {},
  ) {
    return writeAudit(tx, {
      tenantId: binding.tenantId,
      userId: null,
      action,
      entityType: 'crm_workspace_binding',
      entityId: binding.id,
      data: {
        principal: 'platform',
        platformKeyId: keyId,
        workspaceId: binding.workspaceId,
        ...data,
      },
      ip,
    });
  }

  async function findBinding(tx: Tx, workspaceId: string) {
    const binding = await tx.crmWorkspaceBinding.findUnique({ where: { workspaceId } });
    if (!binding) throw errors.notFound('The workspace');
    return binding;
  }

  async function provision(
    tx: Tx,
    workspaceId: string,
    input: ProvisionInput,
    requestHash: string,
    keyId: string,
    ip: string | null,
  ) {
    await lock(tx, `crm-workspace:${workspaceId}`);
    const start = parseDate(input.company.firstFiscalYearStart);
    const existing = await tx.crmWorkspaceBinding.findUnique({ where: { workspaceId } });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw errors.conflict(
          'WORKSPACE_REQUEST_CONFLICT',
          'This workspace was provisioned with a different request',
        );
      }
      await ensureFiscalYear(tx, existing, start);
      const profile = await ensureCrmAccountingDefaults(tx, existing.tenantId, existing.companyId);
      await audit(tx, existing, keyId, 'platform.crm_workspace.ensure', ip);
      return { status: 200, body: await view(tx, existing, profile) };
    }

    await lock(tx, `tenant-slug:${input.tenant.slug}`);
    if (await tx.tenant.findUnique({ where: { slug: input.tenant.slug } })) {
      throw errors.conflict('TENANT_SLUG_TAKEN', 'This tenant slug is taken');
    }
    const tenant = await tx.tenant.create({
      data: { slug: input.tenant.slug, name: input.tenant.name, isActive: true },
    });
    const company = await tx.company.create({
      data: {
        tenantId: tenant.id,
        name: input.company.name,
        legalName: input.company.legalName,
        crNumber: input.company.crNumber,
        baseCurrency: 'KWD',
        fiscalYearEndMonth: input.company.fiscalYearEndMonth,
      },
    });
    await seedChartOfAccounts(tx, tenant.id, company.id, generalBusinessChartOfAccounts);
    const binding = await tx.crmWorkspaceBinding.create({
      data: {
        workspaceId,
        tenantId: tenant.id,
        companyId: company.id,
        chartTemplate: input.chartTemplate,
        requestHash,
      },
    });
    await ensureFiscalYear(tx, binding, start);
    const profile = await ensureCrmAccountingDefaults(tx, tenant.id, company.id);
    await audit(tx, binding, keyId, 'platform.crm_workspace.provision', ip, {
      companyId: company.id,
    });
    return { status: 201, body: await view(tx, binding, profile) };
  }

  router.put('/crm-workspaces/:workspaceId', async (req, res) => {
    const workspaceId = parseWith(idSchema, req.params.workspaceId);
    const input = parseWith(provisionSchema, req.body);
    const requestHash = sha256Hex(canonicalJson(input));
    const keyId = res.locals.platformKeyId as string;
    try {
      const result = await prisma.$transaction(
        (tx) => provision(tx, workspaceId, input, requestHash, keyId, req.ip ?? null),
        transactionOptions,
      );
      res.status(result.status).json(result.body);
    } catch (error) {
      // Another workspace took the slug between our check and insert.
      if (isUniqueViolation(error)) {
        throw errors.conflict('TENANT_SLUG_TAKEN', 'This tenant slug is taken');
      }
      throw error;
    }
  });

  router.get('/crm-workspaces/:workspaceId', async (req, res) => {
    const workspaceId = parseWith(idSchema, req.params.workspaceId);
    const keyId = res.locals.platformKeyId as string;
    const body = await prisma.$transaction(async (tx) => {
      const binding = await findBinding(tx, workspaceId);
      const profile = (await loadPostingProfile(tx, binding.companyId)) as PostingProfile;
      const credentials = await tx.crmServiceCredential.findMany({
        where: { bindingId: binding.id },
        orderBy: { createdAt: 'asc' },
        select: { id: true, status: true, createdAt: true, revokedAt: true, lastUsedAt: true },
      });
      await audit(tx, binding, keyId, 'platform.crm_workspace.read', req.ip ?? null);
      return {
        ...(await view(tx, binding, profile)),
        credentials: credentials.map((row) => ({
          credentialId: row.id,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
          revokedAt: row.revokedAt?.toISOString() ?? null,
          lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        })),
      };
    });
    res.json(body);
  });

  router.put('/crm-workspaces/:workspaceId/credentials/:credentialId', async (req, res) => {
    const workspaceId = parseWith(idSchema, req.params.workspaceId);
    const credentialId = parseWith(idSchema, req.params.credentialId);
    const { tokenSha256 } = parseWith(credentialSchema, req.body);
    const keyId = res.locals.platformKeyId as string;
    const conflict = () =>
      errors.conflict('CREDENTIAL_CONFLICT', 'This credential id or token hash is already in use');
    try {
      const status = await prisma.$transaction(async (tx) => {
        await lock(tx, `crm-workspace:${workspaceId}`);
        const binding = await findBinding(tx, workspaceId);
        if (binding.status !== 'active') {
          throw errors.conflict('BINDING_SUSPENDED', 'The workspace is suspended');
        }
        const existing = await tx.crmServiceCredential.findUnique({ where: { id: credentialId } });
        if (existing) {
          if (existing.bindingId !== binding.id || existing.tokenHash !== tokenSha256) {
            throw conflict();
          }
          if (existing.status !== 'active') {
            throw errors.conflict('CREDENTIAL_REVOKED', 'This credential was revoked');
          }
          return 200;
        }
        if (await tx.crmServiceCredential.findUnique({ where: { tokenHash: tokenSha256 } })) {
          throw conflict();
        }
        const active = await tx.crmServiceCredential.count({
          where: { bindingId: binding.id, status: 'active' },
        });
        if (active >= 2) {
          throw errors.conflict(
            'TOO_MANY_CREDENTIALS',
            'A workspace has at most two active credentials. Revoke one first',
          );
        }
        await tx.crmServiceCredential.create({
          data: { id: credentialId, bindingId: binding.id, tokenHash: tokenSha256 },
        });
        await audit(tx, binding, keyId, 'platform.crm_credential.register', req.ip ?? null, {
          credentialId,
        });
        return 201;
      });
      res.status(status).json({ credentialId, status: 'active' });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict();
      throw error;
    }
  });

  router.delete('/crm-workspaces/:workspaceId/credentials/:credentialId', async (req, res) => {
    const workspaceId = parseWith(idSchema, req.params.workspaceId);
    const credentialId = parseWith(idSchema, req.params.credentialId);
    const keyId = res.locals.platformKeyId as string;
    await prisma.$transaction(async (tx) => {
      await lock(tx, `crm-workspace:${workspaceId}`);
      const binding = await findBinding(tx, workspaceId);
      const revoked = await tx.crmServiceCredential.updateMany({
        where: { id: credentialId, bindingId: binding.id, status: 'active' },
        data: { status: 'revoked', revokedAt: deps.now?.() ?? new Date() },
      });
      if (revoked.count > 0) {
        await audit(tx, binding, keyId, 'platform.crm_credential.revoke', req.ip ?? null, {
          credentialId,
        });
      }
    });
    res.status(204).end();
  });

  for (const [action, status] of [
    ['suspend', 'suspended'],
    ['resume', 'active'],
  ] as const) {
    router.post(`/crm-workspaces/:workspaceId/${action}`, async (req, res) => {
      const workspaceId = parseWith(idSchema, req.params.workspaceId);
      const keyId = res.locals.platformKeyId as string;
      await prisma.$transaction(async (tx) => {
        await lock(tx, `crm-workspace:${workspaceId}`);
        const binding = await findBinding(tx, workspaceId);
        if (binding.status !== status) {
          await tx.crmWorkspaceBinding.update({ where: { id: binding.id }, data: { status } });
        }
        await audit(tx, binding, keyId, `platform.crm_workspace.${action}`, req.ip ?? null);
      });
      res.json({ status });
    });
  }

  return router;
}
