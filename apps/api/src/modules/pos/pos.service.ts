import { fromFils, toFils } from '@nexera/shared';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../config';
import { Prisma, type PrismaClient } from '../../generated/prisma/client';
import { writeAudit } from '../../lib/audit';
import { asName, findCompany } from '../../lib/company-scope';
import { formatDate, parseDate } from '../../lib/dates';
import { AppError, errors } from '../../lib/http-errors';
import { createSecretBox } from '../../lib/secret-box';
import type { SsoSigner } from '../../lib/sso';
import type { Actor, PostingActor } from '../../middleware/authenticate';
import { postJournalInTx, type SystemJournalLine } from '../journals/journals.service';

// The link with the restaurants' POS (docs/unified-platform.md): the ERP reads each branch's
// business days and goods receipts from the POS and posts their journals in the company the
// branch is linked to.

export const SOURCE_SYSTEM = 'pos';

// Each role and the code of the restaurant chart it uses unless the company maps it otherwise.
export const POS_ROLES = {
  sales: '4120',
  discounts: '4810',
  refunds: '4820',
  commission: '5150',
  cash_over_short: '6270',
  cost_of_sales: '5110',
  inventory: '1310',
  waste: '5140',
  payable: '2110',
  'method:cash': '1110',
  'method:knet': '1210',
  'method:talabat': '1230',
  'method:keeta': '1240',
  'method:other': '1250',
} as const satisfies Record<string, string>;
export type PosRole = keyof typeof POS_ROLES;
const BASE_ROLES = Object.keys(POS_ROLES) as PosRole[];
const roleSchema = z.string().regex(/^(?:[a-z_]+|method:[a-z0-9_-]{1,40})$/);

const money = z.string().regex(/^-?\d{1,15}(\.\d{1,3})?$/);
const methodLine = z.object({
  method: z.string().min(1).max(40),
  amount: money,
  commission: money,
});
const daySchema = z.object({
  id: z.string().min(1).max(100),
  branchId: z.uuid(),
  businessDate: z.iso.date(),
  orders: z.number().int(),
  gross: money,
  discounts: money,
  net: money,
  payments: z.array(methodLine),
  refunds: z.array(methodLine),
  cashDifference: money,
  costOfSales: money,
  waste: money,
  countDifference: money,
});
const receiptSchema = z.object({
  id: z.string().min(1).max(100),
  number: z.number().int(),
  branchId: z.uuid(),
  businessDate: z.iso.date(),
  invoiceNumber: z.string().nullable(),
  total: money,
  supplier: z.object({ id: z.uuid(), name: z.string().min(1).max(200) }),
});
const structureSchema = z.object({
  brands: z.array(
    z.object({
      id: z.uuid(),
      name: z.object({ en: z.string(), ar: z.string() }),
      paymentMethods: z.array(
        z.object({ key: z.string(), name: z.object({ en: z.string(), ar: z.string() }) }),
      ),
      branches: z.array(
        z.object({
          id: z.uuid(),
          name: z.object({ en: z.string(), ar: z.string() }),
          isActive: z.boolean(),
        }),
      ),
    }),
  ),
});
type PosDay = z.infer<typeof daySchema>;
type PosReceipt = z.infer<typeof receiptSchema>;

export const connectionInputSchema = z.strictObject({
  apiUrl: z.url().max(300),
  webUrl: z.url().max(300),
  key: z.string().min(10).max(200).optional(),
});
export const branchLinksInputSchema = z.strictObject({
  links: z
    .array(
      z.strictObject({
        posBranchId: z.uuid(),
        posBrandId: z.uuid(),
        branchId: z.uuid().nullable(),
      }),
    )
    .max(500),
});
export const accountsInputSchema = z.strictObject({
  accounts: z.array(z.strictObject({ role: roleSchema, accountId: z.uuid() })).max(100),
});
export const syncInputSchema = z.strictObject({ from: z.iso.date(), to: z.iso.date() });
export const documentsQuerySchema = z.object({
  companyId: z.uuid().optional(),
  status: z.enum(['posted', 'unmapped', 'failed']).optional(),
});

export interface PosDeps {
  prisma: PrismaClient;
  config: Config;
  sso: SsoSigner;
  now: () => Date;
  fetch: typeof fetch;
}

export interface SyncResult {
  posted: number;
  unchanged: number;
  unmapped: number;
  failed: number;
  unlinked: number;
}

const trimUrl = (url: string) => url.replace(/\/+$/, '');
const hashOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Signed amounts in fils; the POS sends "-1.500" for a cash shortage.
const fils = (amount: string) =>
  amount.startsWith('-') ? -toFils(amount.slice(1)) : toFils(amount);

export function createPosService({ prisma, config, sso, now, fetch: fetchImpl }: PosDeps) {
  const box = createSecretBox(config.pos.encryptionKey);

  async function connectionOf(tenantId: string) {
    const row = await prisma.posConnection.findUnique({ where: { tenantId } });
    if (!row) throw errors.rule('POS_NOT_CONNECTED', 'Connect the POS first');
    return row;
  }

  async function posGet<T extends z.ZodType>(
    connection: { apiUrl: string; keyCiphertext: string },
    path: string,
    schema: T,
  ): Promise<z.output<T>> {
    let res: Response;
    try {
      res = await fetchImpl(`${trimUrl(connection.apiUrl)}/api/v1/accounting${path}`, {
        headers: { authorization: `Bearer ${box.open(connection.keyCiphertext)}` },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw errors.rule('POS_UNREACHABLE', 'The POS could not be reached');
    }
    if (res.status === 401) throw errors.rule('POS_KEY_REFUSED', 'The POS refused the key');
    if (!res.ok) throw errors.rule('POS_ERROR', `The POS answered ${res.status}`);
    const parsed = schema.safeParse(await res.json());
    if (!parsed.success)
      throw errors.rule('POS_ANSWER_INVALID', 'The POS answer was not understood');
    return parsed.data;
  }

  // The account of each role for a company: its own mapping, else the account with the default
  // code. A way of payment without its own account falls back to "method:other".
  async function accountsOf(db: Prisma.TransactionClient | PrismaClient, companyId: string) {
    const mapped = await db.posAccount.findMany({ where: { companyId } });
    const accounts = await db.account.findMany({
      where: { companyId, isActive: true, isPostable: true },
      select: { id: true, code: true },
    });
    const valid = new Set(accounts.map((row) => row.id));
    const byCode = new Map(accounts.map((row) => [row.code, row.id]));
    const byRole = new Map(
      mapped.filter((row) => valid.has(row.accountId)).map((row) => [row.role, row.accountId]),
    );
    const resolve = (role: string): string | undefined =>
      byRole.get(role) ??
      (role in POS_ROLES ? byCode.get(POS_ROLES[role as PosRole]) : undefined) ??
      (role.startsWith('method:') && role !== 'method:other' ? resolve('method:other') : undefined);
    return { resolve, mappedRoles: [...byRole.keys()] };
  }

  class Lines {
    lines: SystemJournalLine[] = [];
    missing = new Set<string>();
    constructor(
      private readonly resolve: (role: string) => string | undefined,
      private readonly branchId: string,
    ) {}
    // Debits one role and credits the other; a negative amount the other way round.
    pair(debitRole: string, creditRole: string, amount: bigint, description: string): void {
      if (amount === 0n) return;
      if (amount < 0n) return this.pair(creditRole, debitRole, -amount, description);
      this.line(debitRole, amount, 0n, description);
      this.line(creditRole, 0n, amount, description);
    }
    line(role: string, debit: bigint, credit: bigint, description: string, partyId?: string) {
      if (debit === 0n && credit === 0n) return;
      const accountId = this.resolve(role);
      if (!accountId) {
        this.missing.add(role);
        return;
      }
      this.lines.push({
        accountId,
        branchId: this.branchId,
        description,
        debit: fromFils(debit),
        credit: fromFils(credit),
        ...(partyId ? { partyId } : {}),
      });
    }
  }

  function dayLines(day: PosDay, lines: Lines) {
    let sales = 0n;
    for (const payment of day.payments) {
      const amount = fils(payment.amount);
      const commission = fils(payment.commission);
      lines.line(`method:${payment.method}`, amount - commission, 0n, `Sales ${payment.method}`);
      lines.line('commission', commission, 0n, `Commission ${payment.method}`);
      sales += amount;
    }
    const discounts = fils(day.discounts);
    lines.line('discounts', discounts, 0n, 'Discounts');
    lines.line('sales', 0n, sales + discounts, 'Sales');
    for (const refund of day.refunds) {
      const amount = fils(refund.amount);
      const commission = fils(refund.commission);
      lines.line('refunds', amount, 0n, `Refund ${refund.method}`);
      lines.line(`method:${refund.method}`, 0n, amount - commission, `Refund ${refund.method}`);
      lines.line('commission', 0n, commission, `Commission back ${refund.method}`);
    }
    lines.pair('method:cash', 'cash_over_short', fils(day.cashDifference), 'Cash over / short');
    lines.pair('cost_of_sales', 'inventory', fils(day.costOfSales), 'Cost of sales');
    lines.pair('waste', 'inventory', fils(day.waste), 'Waste');
    lines.pair('waste', 'inventory', fils(day.countDifference), 'Stock count difference');
  }

  async function supplierParty(
    tx: Prisma.TransactionClient,
    tenantId: string,
    companyId: string,
    supplier: PosReceipt['supplier'],
  ) {
    const party = await tx.subledgerParty.upsert({
      where: {
        companyId_sourceSystem_externalRef: {
          companyId,
          sourceSystem: SOURCE_SYSTEM,
          externalRef: `supplier:${supplier.id}`,
        },
      },
      create: {
        tenantId,
        companyId,
        sourceSystem: SOURCE_SYSTEM,
        externalRef: `supplier:${supplier.id}`,
        name: supplier.name,
        kind: 'company',
      },
      update: { name: supplier.name },
    });
    return party.id;
  }

  // Posts one POS document, once per version: a changed document reverses its last journal and
  // posts again; a document whose accounts are not all mapped waits as "unmapped".
  async function apply(
    actor: PostingActor,
    link: { companyId: string; branchId: string },
    doc: { kind: 'day'; data: PosDay } | { kind: 'grn'; data: PosReceipt },
  ): Promise<keyof Omit<SyncResult, 'unlinked'>> {
    const { companyId } = link;
    const externalId = doc.data.id;
    const payloadHash = hashOf(doc.data);
    const existing = await prisma.posDocument.findUnique({
      where: { companyId_externalId: { companyId, externalId } },
    });
    if (existing?.payloadHash === payloadHash && existing.status === 'posted') return 'unchanged';

    const amount = doc.kind === 'day' ? doc.data.net : doc.data.total;
    const base = {
      tenantId: actor.tenantId,
      companyId,
      externalId,
      kind: doc.kind,
      businessDate: parseDate(doc.data.businessDate),
      payloadHash,
      amount: new Prisma.Decimal(amount),
      syncedAt: now(),
    };
    const save = (
      tx: Prisma.TransactionClient | PrismaClient,
      data: { status: string; error: string | null; journalEntryId?: string | null },
    ) =>
      tx.posDocument.upsert({
        where: { companyId_externalId: { companyId, externalId } },
        create: { ...base, ...data },
        update: { ...base, ...data },
      });

    try {
      return await prisma.$transaction(async (tx) => {
        const { resolve } = await accountsOf(tx, companyId);
        const lines = new Lines(resolve, link.branchId);
        let description: string;
        if (doc.kind === 'day') {
          dayLines(doc.data, lines);
          description = `POS sales ${doc.data.businessDate}`;
        } else {
          const partyId = await supplierParty(tx, actor.tenantId, companyId, doc.data.supplier);
          const total = fils(doc.data.total);
          lines.line('inventory', total, 0n, `Goods received #${doc.data.number}`);
          lines.line('payable', 0n, total, doc.data.supplier.name, partyId);
          description = `POS goods received #${doc.data.number} ${doc.data.supplier.name}`;
        }
        if (lines.missing.size > 0) {
          await save(tx, {
            status: 'unmapped',
            error: `No account for: ${[...lines.missing].join(', ')}`,
            journalEntryId: existing?.journalEntryId ?? null,
          });
          return 'unmapped' as const;
        }

        if (existing?.journalEntryId) {
          const old = await tx.journalEntry.findUniqueOrThrow({
            where: { id: existing.journalEntryId },
            include: { lines: true },
          });
          const reversal = await postJournalInTx(
            tx,
            actor,
            companyId,
            {
              date: formatDate(old.date),
              description: `Reversal: ${old.description}`.slice(0, 500),
              reference: old.reference,
              source: 'REVERSAL',
              sourceSystem: SOURCE_SYSTEM,
              externalId: `${externalId}:rev:${existing.payloadHash.slice(0, 12)}`,
              lines: old.lines.map((line) => ({
                accountId: line.accountId,
                branchId: line.branchId,
                description: line.description,
                debit: line.credit.toFixed(3),
                credit: line.debit.toFixed(3),
                ...(line.partyId ? { partyId: line.partyId } : {}),
              })),
            },
            now(),
          );
          await tx.journalEntry.update({
            where: { id: reversal.id },
            data: { reversesId: old.id },
          });
        }

        let journalEntryId: string | null = null;
        if (lines.lines.length > 0) {
          const posted = await postJournalInTx(
            tx,
            actor,
            companyId,
            {
              date: doc.data.businessDate,
              description,
              reference: externalId.slice(0, 100),
              source: 'INTEGRATION',
              sourceSystem: SOURCE_SYSTEM,
              externalId: `${externalId}:${payloadHash.slice(0, 12)}`,
              lines: lines.lines,
            },
            now(),
          );
          journalEntryId = posted.id;
        }
        await save(tx, { status: 'posted', error: null, journalEntryId });
        return 'posted' as const;
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await save(prisma, {
        status: 'failed',
        error: error.message,
        journalEntryId: existing?.journalEntryId ?? null,
      });
      return 'failed';
    }
  }

  async function syncTenant(actor: PostingActor, range: { from: string; to: string }) {
    const connection = await connectionOf(actor.tenantId);
    const result: SyncResult = { posted: 0, unchanged: 0, unmapped: 0, failed: 0, unlinked: 0 };
    try {
      const links = new Map(
        (await prisma.posBranchLink.findMany({ where: { tenantId: actor.tenantId } })).map(
          (row) => [row.posBranchId, row],
        ),
      );
      const days = await posGet(
        connection,
        `/days?from=${range.from}&to=${range.to}`,
        z.object({ days: z.array(daySchema) }),
      );
      const receipts = await posGet(
        connection,
        `/goods-receipts?from=${range.from}&to=${range.to}`,
        z.object({ receipts: z.array(receiptSchema) }),
      );
      const docs = [
        ...days.days.map((data) => ({ kind: 'day' as const, data })),
        ...receipts.receipts.map((data) => ({ kind: 'grn' as const, data })),
      ];
      for (const doc of docs) {
        const link = links.get(doc.data.branchId);
        if (!link) {
          result.unlinked += 1;
          continue;
        }
        result[await apply(actor, link, doc)] += 1;
      }
      await prisma.posConnection.update({
        where: { id: connection.id },
        data: { lastSyncAt: now(), lastError: null },
      });
    } catch (error) {
      await prisma.posConnection.update({
        where: { id: connection.id },
        data: { lastError: error instanceof Error ? error.message : 'Sync failed' },
      });
      throw error;
    }
    return result;
  }

  const view = (row: Awaited<ReturnType<typeof connectionOf>> | null) =>
    row && {
      apiUrl: row.apiUrl,
      webUrl: row.webUrl,
      lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
      lastError: row.lastError,
    };

  return {
    async connection(actor: Actor) {
      return view(await prisma.posConnection.findUnique({ where: { tenantId: actor.tenantId } }));
    },

    async saveConnection(actor: Actor, input: z.infer<typeof connectionInputSchema>) {
      const current = await prisma.posConnection.findUnique({
        where: { tenantId: actor.tenantId },
      });
      if (!current && !input.key) throw errors.rule('POS_KEY_REQUIRED', 'Enter the POS key');
      const data = {
        apiUrl: trimUrl(input.apiUrl),
        webUrl: trimUrl(input.webUrl),
        ...(input.key ? { keyCiphertext: box.seal(input.key) } : {}),
      };
      // The key is checked before it is kept.
      await posGet(
        { apiUrl: data.apiUrl, keyCiphertext: data.keyCiphertext ?? current?.keyCiphertext ?? '' },
        '/structure',
        structureSchema,
      );
      const row = await prisma.posConnection.upsert({
        where: { tenantId: actor.tenantId },
        create: { tenantId: actor.tenantId, keyCiphertext: '', ...data },
        update: data,
      });
      await writeAudit(prisma, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        action: 'pos.connection.save',
        entityType: 'pos_connection',
        entityId: row.id,
        data: { apiUrl: row.apiUrl, keyChanged: Boolean(input.key) },
        ip: actor.ip,
      });
      return view(row);
    },

    // The POS's brands and branches with the ERP branch each is linked to, and the ERP branches.
    async structure(actor: Actor) {
      const connection = await connectionOf(actor.tenantId);
      const pos = await posGet(connection, '/structure', structureSchema);
      const links = await prisma.posBranchLink.findMany({ where: { tenantId: actor.tenantId } });
      const linked = new Map(links.map((row) => [row.posBranchId, row.branchId]));
      const branches = await prisma.branch.findMany({
        where: { tenantId: actor.tenantId, isActive: true },
        include: { company: { select: { id: true, name: true } } },
        orderBy: [{ companyId: 'asc' }, { code: 'asc' }],
      });
      return {
        brands: pos.brands.map((brand) => ({
          ...brand,
          branches: brand.branches.map((branch) => ({
            ...branch,
            erpBranchId: linked.get(branch.id) ?? null,
          })),
        })),
        erpBranches: branches.map((branch) => ({
          id: branch.id,
          code: branch.code,
          name: asName(branch.name),
          companyId: branch.companyId,
          companyName: asName(branch.company.name),
        })),
      };
    },

    async saveBranchLinks(actor: Actor, input: z.infer<typeof branchLinksInputSchema>) {
      const targets = input.links.flatMap((link) => (link.branchId ? [link.branchId] : []));
      const branches = await prisma.branch.findMany({
        where: { tenantId: actor.tenantId, id: { in: targets } },
        select: { id: true, companyId: true },
      });
      const companyOf = new Map(branches.map((row) => [row.id, row.companyId]));
      if (companyOf.size !== new Set(targets).size) throw errors.notFound('Branch');
      await prisma.$transaction(async (tx) => {
        for (const link of input.links) {
          const where = {
            tenantId_posBranchId: { tenantId: actor.tenantId, posBranchId: link.posBranchId },
          };
          if (!link.branchId) {
            await tx.posBranchLink.deleteMany({
              where: { tenantId: actor.tenantId, posBranchId: link.posBranchId },
            });
            continue;
          }
          const data = {
            posBrandId: link.posBrandId,
            branchId: link.branchId,
            companyId: companyOf.get(link.branchId) ?? '',
          };
          await tx.posBranchLink.upsert({
            where,
            create: { tenantId: actor.tenantId, posBranchId: link.posBranchId, ...data },
            update: data,
          });
        }
        await writeAudit(tx, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          action: 'pos.branch_links.save',
          entityType: 'pos_connection',
          entityId: actor.tenantId,
          data: { links: input.links.length },
          ip: actor.ip,
        });
      });
      const rows = await prisma.posBranchLink.findMany({ where: { tenantId: actor.tenantId } });
      return rows.map((row) => ({
        posBranchId: row.posBranchId,
        posBrandId: row.posBrandId,
        branchId: row.branchId,
        companyId: row.companyId,
      }));
    },

    async accounts(actor: Actor, companyId: string) {
      await findCompany(prisma, actor.tenantId, companyId);
      const { resolve, mappedRoles } = await accountsOf(prisma, companyId);
      const roles = [...new Set([...BASE_ROLES, ...mappedRoles])];
      return roles.map((role) => ({ role, accountId: resolve(role) ?? null }));
    },

    async saveAccounts(
      actor: Actor,
      companyId: string,
      input: z.infer<typeof accountsInputSchema>,
    ) {
      await findCompany(prisma, actor.tenantId, companyId);
      const ids = [...new Set(input.accounts.map((row) => row.accountId))];
      const found = await prisma.account.count({
        where: { companyId, id: { in: ids }, isActive: true, isPostable: true },
      });
      if (found !== ids.length) throw errors.rule('INVALID_ACCOUNT', 'An account cannot be used');
      await prisma.$transaction(async (tx) => {
        for (const row of input.accounts) {
          await tx.posAccount.upsert({
            where: { companyId_role: { companyId, role: row.role } },
            create: {
              tenantId: actor.tenantId,
              companyId,
              role: row.role,
              accountId: row.accountId,
            },
            update: { accountId: row.accountId },
          });
        }
        await writeAudit(tx, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          action: 'pos.accounts.save',
          entityType: 'company',
          entityId: companyId,
          data: { roles: input.accounts.map((row) => row.role) },
          ip: actor.ip,
        });
      });
      return this.accounts(actor, companyId);
    },

    async sync(actor: Actor, range: z.infer<typeof syncInputSchema>) {
      const days = (parseDate(range.to).getTime() - parseDate(range.from).getTime()) / 86_400_000;
      if (days < 0 || days > 30) {
        throw errors.rule('RANGE_INVALID', 'Sync up to 31 days, from before to');
      }
      return syncTenant({ ...actor, principal: 'user', auditData: { via: 'pos' } }, range);
    },

    // The last three days of every connected POS, for the timer.
    async syncAll() {
      const today = now();
      const range = {
        from: formatDate(new Date(today.getTime() - 2 * 86_400_000)),
        to: formatDate(today),
      };
      for (const connection of await prisma.posConnection.findMany()) {
        try {
          await syncTenant(
            {
              tenantId: connection.tenantId,
              userId: null,
              ip: null,
              principal: 'pos_sync',
              auditData: { via: 'pos', by: 'timer' },
            },
            range,
          );
        } catch {
          // Kept as the connection's last error; the next round tries again.
        }
      }
    },

    async documents(actor: Actor, query: z.infer<typeof documentsQuerySchema>) {
      const rows = await prisma.posDocument.findMany({
        where: {
          tenantId: actor.tenantId,
          ...(query.companyId ? { companyId: query.companyId } : {}),
          ...(query.status ? { status: query.status } : {}),
        },
        orderBy: [{ businessDate: 'desc' }, { externalId: 'asc' }],
        take: 200,
      });
      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        externalId: row.externalId,
        kind: row.kind,
        businessDate: formatDate(row.businessDate),
        amount: row.amount.toFixed(3),
        status: row.status,
        error: row.error,
        journalEntryId: row.journalEntryId,
        syncedAt: row.syncedAt.toISOString(),
      }));
    },

    // A one-minute ticket that signs the person into the POS (same email), and where to send it.
    async ssoUrl(actor: Actor) {
      const connection = await connectionOf(actor.tenantId);
      const user = await prisma.user.findFirst({
        where: { id: actor.userId, tenantId: actor.tenantId },
      });
      if (!user) throw errors.unauthenticated();
      const ticket = await sso.ticket({ email: user.email, audience: config.pos.ssoAudience });
      return { url: `${connection.webUrl}/sso#ticket=${ticket}` };
    },
  };
}

export type PosService = ReturnType<typeof createPosService>;
