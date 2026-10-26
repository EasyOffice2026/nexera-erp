import { createHash, randomBytes } from 'node:crypto';
import {
  fromFils,
  toFils,
  journalLineSchema,
  listJournalsQuerySchema,
  reportQuerySchema,
} from '@nexera/shared';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { Config } from '../../config';
import { Prisma } from '../../generated/prisma/client';
import { writeAudit } from '../../lib/audit';
import { asName, findCompany } from '../../lib/company-scope';
import { errors } from '../../lib/http-errors';
import type { PrismaClient } from '../../lib/prisma';
import { parseWith } from '../../lib/validate';
import { actorOf, requirePermission, type Actor } from '../../middleware/authenticate';
import { createAccountsService } from '../accounts/accounts.service';
import { createJournalsService, postJournalInTx } from '../journals/journals.service';
import { createReportsService } from '../reports/reports.service';

const idSchema = z.string().uuid();
const postingSchema = z
  .object({
    externalId: z.string().trim().min(1).max(100),
    currency: z.literal('KWD'),
    date: z.iso.date(),
    description: z.string().trim().min(1).max(500),
    reference: z.string().trim().max(100).default(''),
    lines: z.array(journalLineSchema).min(2).max(500),
  })
  .strict();

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function createCrmIntegrationRouter(deps: {
  prisma: PrismaClient;
  config: Config;
  now?: () => Date;
}) {
  const { prisma, config } = deps;
  const accounts = createAccountsService({ prisma });
  const journals = createJournalsService({ prisma, ...(deps.now ? { now: deps.now } : {}) });
  const reports = createReportsService({ prisma });
  const provision = Router();
  const service = Router();

  provision.post(
    '/:companyId/crm-integration',
    requirePermission('integrations.manage'),
    async (req, res) => {
      const actor = actorOf(req);
      const companyId = parseWith(idSchema, req.params.companyId);
      const company = await findCompany(prisma, actor.tenantId, companyId);
      if (!company.isActive) throw errors.forbidden();
      const token = randomBytes(32).toString('base64url');
      await prisma.$transaction(async (tx) => {
        const row = await tx.crmIntegration.upsert({
          where: { companyId },
          create: {
            companyId,
            tenantId: actor.tenantId,
            createdById: actor.userId,
            tokenHash: hash(token),
          },
          update: { createdById: actor.userId, tokenHash: hash(token), isActive: true },
        });
        await writeAudit(tx, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          action: 'crm.integration.rotate',
          entityType: 'crm_integration',
          entityId: row.id,
          ip: actor.ip,
        });
      });
      res.set('Cache-Control', 'no-store').status(201).json({ token, companyId });
    },
  );

  type Integration = Prisma.CrmIntegrationGetPayload<{
    include: { company: true; tenant: true; createdBy: true };
  }>;
  const authenticateCrm: RequestHandler = async (req, res, next) => {
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) throw errors.unauthenticated();
    const row = await prisma.crmIntegration.findUnique({
      where: { tokenHash: hash(token) },
      include: { company: true, tenant: true, createdBy: true },
    });
    if (
      !row ||
      !row.isActive ||
      !row.company.isActive ||
      !row.tenant.isActive ||
      !row.createdBy.isActive ||
      row.createdBy.tenantId !== row.tenantId ||
      row.company.tenantId !== row.tenantId ||
      !['owner', 'finance_manager'].includes(row.createdBy.role)
    ) {
      throw errors.unauthenticated();
    }
    res.locals.crmIntegration = row;
    res.set('Cache-Control', 'no-store');
    next();
  };
  service.use(authenticateCrm);

  function scope(res: { locals: Record<string, unknown> }, ip: string | null) {
    const link = res.locals.crmIntegration as Integration;
    const actor: Actor = { tenantId: link.tenantId, userId: link.createdById, ip };
    return { link, actor, companyId: link.companyId };
  }

  service.get('/connection', (req, res) => {
    const { link } = scope(res, req.ip ?? null);
    res.json({
      tenantId: link.tenantId,
      tenantName: link.tenant.name,
      companyId: link.companyId,
      companyName: asName(link.company.name).en,
      currency: link.company.baseCurrency,
    });
  });

  service.get('/accounts', async (req, res) => {
    const { actor, companyId } = scope(res, req.ip ?? null);
    res.json(await accounts.list(actor, companyId));
  });

  service.get('/journals', async (req, res) => {
    const { actor, companyId } = scope(res, req.ip ?? null);
    res.json(await journals.list(actor, companyId, parseWith(listJournalsQuerySchema, req.query)));
  });

  service.get('/trial-balance', async (req, res) => {
    const { actor, companyId } = scope(res, req.ip ?? null);
    res.json(await reports.trialBalance(actor, companyId, parseWith(reportQuerySchema, req.query)));
  });

  service.post('/journals', async (req, res) => {
    if (!config.crmPostingEnabled) throw errors.forbidden();
    const { actor, companyId, link } = scope(res, req.ip ?? null);
    const input = parseWith(postingSchema, req.body);
    const sourceSystem = `crm:${link.id}`;
    const normalized = {
      ...input,
      lines: input.lines.map((line) => ({
        ...line,
        debit: fromFils(toFils(line.debit)),
        credit: fromFils(toFils(line.credit)),
      })),
    };
    const payloadHash = hash(JSON.stringify(normalized));
    const key = { companyId, sourceSystem, externalId: input.externalId };
    async function existing() {
      return prisma.journalEntry.findUnique({
        where: { companyId_sourceSystem_externalId: key },
        select: { id: true, number: true, crmPayloadHash: true },
      });
    }
    function replay(entry: Awaited<ReturnType<typeof existing>>) {
      if (!entry) return null;
      if (entry.crmPayloadHash !== payloadHash) {
        throw errors.conflict(
          'CRM_EVENT_CONFLICT',
          'This CRM event was already posted with different content',
        );
      }
      return { id: entry.id, number: entry.number, duplicate: true };
    }
    const posted = replay(await existing());
    if (posted) return res.json(posted);
    try {
      const result = await prisma.$transaction(async (tx) => {
        const entry = await postJournalInTx(
          tx,
          actor,
          companyId,
          { ...normalized, source: 'INTEGRATION', sourceSystem, crmPayloadHash: payloadHash },
          deps.now?.() ?? new Date(),
        );
        return tx.journalEntry.findUniqueOrThrow({
          where: { id: entry.id },
          select: { id: true, number: true },
        });
      });
      return res.status(201).json({ ...result, duplicate: false });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const duplicate = replay(await existing());
        if (duplicate) return res.json(duplicate);
      }
      throw error;
    }
  });

  return { provision, service };
}
