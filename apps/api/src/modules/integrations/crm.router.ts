import { createHash, randomBytes } from 'node:crypto';
import {
  AMOUNT_PATTERN,
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
import { canonicalJson } from '../../lib/canonical-json';
import { asName, findCompany } from '../../lib/company-scope';
import { formatDate, parseDate } from '../../lib/dates';
import { AppError, errors } from '../../lib/http-errors';
import { decimalToFils } from '../../lib/money';
import type { PrismaClient } from '../../lib/prisma';
import { parseWith } from '../../lib/validate';
import {
  actorOf,
  requirePermission,
  type Actor,
  type PostingActor,
} from '../../middleware/authenticate';
import { createAccountsService } from '../accounts/accounts.service';
import { createJournalsService, postJournalInTx } from '../journals/journals.service';
import { createReportsService } from '../reports/reports.service';
import { loadPostingProfile, type PostingRole } from '../platform/crm-defaults';

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

const amountString = z.string().regex(AMOUNT_PATTERN, 'Use a decimal string with up to 3 decimals');
const EVENT_TYPES = [
  'invoice.issued',
  'payment.received',
  'credit_note.issued',
  'refund.paid',
] as const;
const eventSchema = z
  .object({
    eventId: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9:._-]+$/),
    type: z.enum(EVENT_TYPES),
    currency: z.string().min(1).max(10),
    date: z.iso.date(),
    reference: z.string().max(100),
    description: z
      .string()
      .min(1)
      .max(500)
      .refine((value) => value.trim().length > 0, 'The description is empty'),
    customer: z
      .object({
        ref: z.string().min(1).max(64),
        name: z.string().trim().min(1).max(200),
        kind: z.enum(['company', 'individual']),
      })
      .strict(),
    amounts: z.object({ net: amountString, tax: amountString, total: amountString }).strict(),
    source: z
      .record(z.string(), z.unknown())
      .optional()
      .refine(
        (value) => value === undefined || JSON.stringify(value).length <= 1024,
        'The source object is larger than 1 KB',
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!AMOUNT_PATTERN.test(value.amounts.net) || !AMOUNT_PATTERN.test(value.amounts.tax)) return;
    if (!AMOUNT_PATTERN.test(value.amounts.total)) return;
    const net = toFils(value.amounts.net);
    const tax = toFils(value.amounts.tax);
    const total = toFils(value.amounts.total);
    if (total <= 0n)
      ctx.addIssue({
        code: 'custom',
        path: ['amounts', 'total'],
        message: 'The total must be more than zero',
      });
    if (net + tax !== total) {
      ctx.addIssue({ code: 'custom', path: ['amounts'], message: 'net + tax must equal total' });
    }
    if ((value.type === 'payment.received' || value.type === 'refund.paid') && tax !== 0n) {
      ctx.addIssue({
        code: 'custom',
        path: ['amounts', 'tax'],
        message: 'Payments and refunds carry no tax',
      });
    }
  });
type CrmEvent = z.output<typeof eventSchema>;
const customerRefSchema = z.string().min(1).max(64);
const asOfSchema = z.object({ asOf: z.iso.date().optional() }).strict();

// The journal lines of an event: each side as [role, amount in fils]; zero lines are left out.
function eventLines(event: CrmEvent) {
  const net = toFils(event.amounts.net);
  const tax = toFils(event.amounts.tax);
  const total = toFils(event.amounts.total);
  const lines: { role: PostingRole; debit: bigint; credit: bigint }[] = {
    'invoice.issued': [
      { role: 'receivable' as const, debit: total, credit: 0n },
      { role: 'revenue' as const, debit: 0n, credit: net },
      { role: 'tax_payable' as const, debit: 0n, credit: tax },
    ],
    'payment.received': [
      { role: 'receipts_clearing' as const, debit: total, credit: 0n },
      { role: 'receivable' as const, debit: 0n, credit: total },
    ],
    'credit_note.issued': [
      { role: 'sales_returns' as const, debit: net, credit: 0n },
      { role: 'tax_payable' as const, debit: tax, credit: 0n },
      { role: 'receivable' as const, debit: 0n, credit: total },
    ],
    'refund.paid': [
      { role: 'receivable' as const, debit: total, credit: 0n },
      { role: 'receipts_clearing' as const, debit: 0n, credit: total },
    ],
  }[event.type];
  return lines.filter((line) => line.debit !== 0n || line.credit !== 0n);
}

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
  type Binding = Prisma.CrmWorkspaceBindingGetPayload<{
    include: { company: true; tenant: true };
  }>;
  type Scope =
    | { kind: 'legacy'; link: Integration; actor: Actor; companyId: string }
    | {
        kind: 'hosted';
        binding: Binding;
        credentialId: string;
        actor: PostingActor;
        companyId: string;
      };

  // A hosted workspace credential (sent with X-Crm-Workspace-Id) is bound to one binding; every
  // failure answers the same 401, so a caller learns nothing about why.
  async function authenticateHosted(token: string, workspaceId: string) {
    if (!token.startsWith('nxc_') || !idSchema.safeParse(workspaceId).success) {
      throw errors.unauthenticated();
    }
    const credential = await prisma.crmServiceCredential.findUnique({
      where: { tokenHash: hash(token) },
      include: { binding: { include: { company: true, tenant: true } } },
    });
    const binding = credential?.binding;
    if (
      !credential ||
      !binding ||
      credential.status !== 'active' ||
      binding.status !== 'active' ||
      binding.workspaceId !== workspaceId ||
      !binding.tenant.isActive ||
      !binding.company.isActive ||
      binding.company.tenantId !== binding.tenantId ||
      binding.company.id !== binding.companyId
    ) {
      throw errors.unauthenticated();
    }
    const now = deps.now?.() ?? new Date();
    if (!credential.lastUsedAt || now.getTime() - credential.lastUsedAt.getTime() > 60_000) {
      await prisma.crmServiceCredential.update({
        where: { id: credential.id },
        data: { lastUsedAt: now },
      });
    }
    return { binding, credentialId: credential.id };
  }

  const authenticateCrm: RequestHandler = async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) throw errors.unauthenticated();
    const workspaceId = req.get('x-crm-workspace-id');
    if (workspaceId !== undefined) {
      const hosted = await authenticateHosted(token, workspaceId);
      res.locals.crmBinding = hosted.binding;
      res.locals.crmCredentialId = hosted.credentialId;
      next();
      return;
    }
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
    next();
  };
  service.use(authenticateCrm);

  function scope(res: { locals: Record<string, unknown> }, ip: string | null): Scope {
    const binding = res.locals.crmBinding as Binding | undefined;
    if (binding) {
      const credentialId = res.locals.crmCredentialId as string;
      return {
        kind: 'hosted',
        binding,
        credentialId,
        companyId: binding.companyId,
        actor: {
          tenantId: binding.tenantId,
          userId: null,
          ip,
          principal: 'crm_service',
          auditData: { principal: 'crm_service', bindingId: binding.id, credentialId },
        },
      };
    }
    const link = res.locals.crmIntegration as Integration;
    const actor: Actor = { tenantId: link.tenantId, userId: link.createdById, ip };
    return { kind: 'legacy', link, actor, companyId: link.companyId };
  }

  function hostedScope(res: { locals: Record<string, unknown> }, ip: string | null) {
    const found = scope(res, ip);
    if (found.kind !== 'hosted') throw errors.unauthenticated();
    return found;
  }

  function legacyScope(res: { locals: Record<string, unknown> }, ip: string | null) {
    const found = scope(res, ip);
    if (found.kind !== 'legacy') throw errors.unauthenticated();
    return found;
  }

  // Read-only services only look at the tenant; a service principal reads as its tenant.
  function readActor(found: Scope): Actor {
    return { tenantId: found.actor.tenantId, userId: found.actor.userId ?? '', ip: found.actor.ip };
  }

  service.get('/connection', async (req, res) => {
    const found = scope(res, req.ip ?? null);
    if (found.kind === 'hosted') {
      const { binding } = found;
      const profile = await loadPostingProfile(prisma, binding.companyId);
      const periods = await prisma.period.findMany({
        where: { companyId: binding.companyId, status: 'OPEN' },
        orderBy: { startDate: 'asc' },
      });
      res.json({
        bindingId: binding.id,
        workspaceId: binding.workspaceId,
        tenantId: binding.tenantId,
        tenantName: binding.tenant.name,
        companyId: binding.companyId,
        companyName: asName(binding.company.name).en,
        currency: binding.company.baseCurrency,
        postingEnabled: config.crmPostingEnabled,
        profile,
        openPeriods: periods.map((period) => ({
          start: formatDate(period.startDate),
          end: formatDate(period.endDate),
        })),
      });
      return;
    }
    const { link } = found;
    res.json({
      tenantId: link.tenantId,
      tenantName: link.tenant.name,
      companyId: link.companyId,
      companyName: asName(link.company.name).en,
      currency: link.company.baseCurrency,
    });
  });

  service.get('/accounts', async (req, res) => {
    const found = scope(res, req.ip ?? null);
    res.json(await accounts.list(readActor(found), found.companyId));
  });

  service.get('/journals', async (req, res) => {
    const found = scope(res, req.ip ?? null);
    res.json(
      await journals.list(
        readActor(found),
        found.companyId,
        parseWith(listJournalsQuerySchema, req.query),
      ),
    );
  });

  service.get('/trial-balance', async (req, res) => {
    const found = scope(res, req.ip ?? null);
    res.json(
      await reports.trialBalance(
        readActor(found),
        found.companyId,
        parseWith(reportQuerySchema, req.query),
      ),
    );
  });

  service.post('/journals', async (req, res) => {
    // Hosted workspaces post events through /events only.
    const { actor, companyId, link } = legacyScope(res, req.ip ?? null);
    if (!config.crmPostingEnabled) throw errors.forbidden();
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

  service.get('/customers/:ref/balance', async (req, res) => {
    const { binding, companyId } = hostedScope(res, req.ip ?? null);
    const ref = parseWith(customerRefSchema, req.params.ref);
    const party = await prisma.subledgerParty.findUnique({
      where: {
        companyId_sourceSystem_externalRef: {
          companyId,
          sourceSystem: `crm:${binding.id}`,
          externalRef: ref,
        },
      },
    });
    if (!party) return res.json({ ref, partyId: null, balance: '0.000' });
    // Only receivable lines carry the party, so this is the customer's receivable balance.
    const sums = await prisma.journalLine.aggregate({
      where: { partyId: party.id, entry: { companyId, status: 'POSTED' } },
      _sum: { debit: true, credit: true },
    });
    const balance =
      (sums._sum.debit ? decimalToFils(sums._sum.debit) : 0n) -
      (sums._sum.credit ? decimalToFils(sums._sum.credit) : 0n);
    return res.json({ ref, partyId: party.id, balance: fromFils(balance) });
  });

  service.get('/receivables', async (req, res) => {
    const { binding, companyId } = hostedScope(res, req.ip ?? null);
    const { asOf } = parseWith(asOfSchema, req.query);
    const sums = await prisma.journalLine.groupBy({
      by: ['partyId'],
      where: {
        partyId: { not: null },
        party: { companyId, sourceSystem: `crm:${binding.id}` },
        entry: { companyId, status: 'POSTED', ...(asOf ? { date: { lte: parseDate(asOf) } } : {}) },
      },
      _sum: { debit: true, credit: true },
    });
    const parties = await prisma.subledgerParty.findMany({
      where: { id: { in: sums.flatMap((row) => (row.partyId ? [row.partyId] : [])) } },
    });
    const byId = new Map(parties.map((party) => [party.id, party]));
    const rows = sums.flatMap((row) => {
      const party = row.partyId ? byId.get(row.partyId) : undefined;
      if (!party) return [];
      const balance =
        (row._sum.debit ? decimalToFils(row._sum.debit) : 0n) -
        (row._sum.credit ? decimalToFils(row._sum.credit) : 0n);
      return [{ ref: party.externalRef, name: party.name, balance: fromFils(balance) }];
    });
    rows.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    res.json(rows);
  });

  // The posting endpoint of hosted workspaces: one journal per (binding, eventId), however often
  // or concurrently the CRM worker sends it. The CRM never chooses accounts; the company's
  // posting profile does.
  service.post('/events', async (req, res) => {
    const { binding, companyId, actor } = hostedScope(res, req.ip ?? null);
    if (!config.crmPostingEnabled) throw errors.postingDisabled();
    const event = parseWith(eventSchema, req.body);
    if (req.get('idempotency-key') !== event.eventId) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_MISMATCH', 'Idempotency-Key must equal eventId');
    }
    if (event.currency !== 'KWD') {
      throw errors.rule('CURRENCY_NOT_SUPPORTED', 'Only KWD is supported');
    }
    const normalized = {
      eventId: event.eventId,
      type: event.type,
      currency: event.currency,
      date: event.date,
      reference: event.reference,
      description: event.description,
      customer: { ref: event.customer.ref },
      amounts: {
        net: fromFils(toFils(event.amounts.net)),
        tax: fromFils(toFils(event.amounts.tax)),
        total: fromFils(toFils(event.amounts.total)),
      },
      source: event.source,
    };
    const payloadHash = hash(canonicalJson(normalized));
    const sourceSystem = `crm:${binding.id}`;
    const key = { companyId, sourceSystem, externalId: event.eventId };
    async function replay() {
      const entry = await prisma.journalEntry.findUnique({
        where: { companyId_sourceSystem_externalId: key },
        select: { id: true, number: true, crmPayloadHash: true },
      });
      if (!entry) return null;
      if (entry.crmPayloadHash !== payloadHash) {
        throw errors.conflict(
          'CRM_EVENT_CONFLICT',
          'This CRM event was already posted with different content',
        );
      }
      return { journalId: entry.id, number: entry.number, eventId: event.eventId, duplicate: true };
    }
    const posted = await replay();
    if (posted) return res.json(posted);
    try {
      const result = await prisma.$transaction(async (tx) => {
        await tx.subledgerParty.createMany({
          data: [
            {
              tenantId: binding.tenantId,
              companyId,
              sourceSystem,
              externalRef: event.customer.ref,
              name: event.customer.name,
              kind: event.customer.kind,
            },
          ],
          skipDuplicates: true,
        });
        let party = await tx.subledgerParty.findUniqueOrThrow({
          where: {
            companyId_sourceSystem_externalRef: {
              companyId,
              sourceSystem,
              externalRef: event.customer.ref,
            },
          },
        });
        if (party.name !== event.customer.name || party.kind !== event.customer.kind) {
          party = await tx.subledgerParty.update({
            where: { id: party.id },
            data: { name: event.customer.name, kind: event.customer.kind },
          });
        }
        const profile = await loadPostingProfile(tx, companyId);
        const lines = eventLines(event).map((line) => {
          const account = profile[line.role];
          if (!account) {
            throw errors.rule('PROFILE_INCOMPLETE', `No usable account is mapped to ${line.role}`, {
              role: line.role,
            });
          }
          return {
            accountId: account.accountId,
            debit: fromFils(line.debit),
            credit: fromFils(line.credit),
            branchId: null,
            description: '',
            ...(line.role === 'receivable' ? { partyId: party.id } : {}),
          };
        });
        const entry = await postJournalInTx(
          tx,
          {
            ...actor,
            auditData: {
              ...actor.auditData,
              eventId: event.eventId,
              eventType: event.type,
              ...(event.source ? { source: JSON.stringify(event.source) } : {}),
            },
          },
          companyId,
          {
            date: event.date,
            description: event.description,
            reference: event.reference,
            lines,
            source: 'INTEGRATION',
            sourceSystem,
            externalId: event.eventId,
            crmPayloadHash: payloadHash,
          },
          deps.now?.() ?? new Date(),
        );
        return tx.journalEntry.findUniqueOrThrow({
          where: { id: entry.id },
          select: { id: true, number: true },
        });
      });
      return res.status(201).json({
        journalId: result.id,
        number: result.number,
        eventId: event.eventId,
        duplicate: false,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const duplicate = await replay();
        if (duplicate) return res.json(duplicate);
      }
      throw error;
    }
  });

  return { provision, service };
}
