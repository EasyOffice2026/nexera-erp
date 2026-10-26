import { createHash, randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createTestPrisma, createWorld, resetDatabase, testConfig, testHasher } from './helpers';

const prisma = createTestPrisma();
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const PLATFORM_TOKEN = `nxp_prov1_${'s'.repeat(40)}`;
const platformEnv = {
  PLATFORM_PROVISIONING_ENABLED: 'true',
  PLATFORM_API_KEYS: `prov1:${sha(PLATFORM_TOKEN)}`,
  PLATFORM_RATE_LIMIT_MAX: '100000',
};
const appWith = (overrides: Record<string, string>) =>
  supertest(createApp({ prisma, config: testConfig(overrides), hasher: testHasher }));
const api = appWith({ ...platformEnv, CRM_INTEGRATION_POSTING_ENABLED: 'true' });
const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://localhost/x',
  JWT_ACCESS_SECRET: 'test-only-access-token-secret-0123456789abcdef',
};
const platform = { authorization: `Bearer ${PLATFORM_TOKEN}` };
const ws = '/api/v1/platform/crm-workspaces';
const crm = '/api/v1/integrations/crm';

beforeEach(() => resetDatabase(prisma));
afterAll(() => prisma.$disconnect());

const errorCode = (response: { body: unknown }) =>
  (response.body as { error: { code: string } }).error.code;

const journalIdOf = (response: { body: unknown }) =>
  (response.body as { journalId: string }).journalId;

function body(slug = 'crm-acme', overrides: Record<string, unknown> = {}) {
  return {
    tenant: { slug, name: 'Acme Trading' },
    company: {
      legalName: 'Acme Trading Co. W.L.L.',
      name: { en: 'Acme Trading', ar: 'أكمي للتجارة' },
      crNumber: '123456',
      fiscalYearEndMonth: 12,
      firstFiscalYearStart: '2026-01-01',
    },
    currency: 'KWD',
    chartTemplate: 'general_business_v1',
    ...overrides,
  };
}

interface Provisioned {
  bindingId: string;
  workspaceId: string;
  tenantId: string;
  companyId: string;
  profile: Record<
    | 'receivable'
    | 'revenue'
    | 'sales_returns'
    | 'receipts_clearing'
    | 'tax_payable'
    | 'opening_equity'
    | 'adjustments',
    { accountId: string; code: string }
  >;
  fiscalYears: { start: string; end: string }[];
}

async function provision(slug = 'crm-acme') {
  const workspaceId = randomUUID();
  const response = await api.put(`${ws}/${workspaceId}`).set(platform).send(body(slug));
  expect(response.status).toBe(201);
  return response.body as Provisioned;
}

async function connect(slug = 'crm-acme') {
  const binding = await provision(slug);
  const token = `nxc_${randomUUID()}${randomUUID()}`;
  const credentialId = randomUUID();
  const registered = await api
    .put(`${ws}/${binding.workspaceId}/credentials/${credentialId}`)
    .set(platform)
    .send({ tokenSha256: sha(token) });
  expect(registered.status).toBe(201);
  const headers = {
    authorization: `Bearer ${token}`,
    'x-crm-workspace-id': binding.workspaceId,
  };
  return { binding, token, credentialId, headers };
}

function event(type: string, overrides: Record<string, unknown> = {}) {
  const taxed = type === 'invoice.issued' || type === 'credit_note.issued';
  return {
    eventId: `crmws:test:${type}:${randomUUID()}`,
    type,
    currency: 'KWD',
    date: '2026-02-10',
    reference: 'INV-0001',
    description: `CRM ${type}`,
    customer: { ref: '42', name: 'Gulf Retail', kind: 'company' },
    amounts: taxed
      ? { net: '100.000', tax: '5.000', total: '105.000' }
      : { net: '105.000', tax: '0.000', total: '105.000' },
    source: { documentId: 7, paymentId: null, invoiceReference: null },
    ...overrides,
  };
}

function send(
  agent: typeof api,
  headers: Record<string, string>,
  payload: { eventId: string } & Record<string, unknown>,
) {
  return agent
    .post(`${crm}/events`)
    .set(headers)
    .set('idempotency-key', payload.eventId)
    .send(payload);
}

async function linesOf(journalId: string) {
  const lines = await prisma.journalLine.findMany({
    where: { entryId: journalId },
    include: { account: true },
    orderBy: { lineNo: 'asc' },
  });
  return lines.map((line) => ({
    code: line.account.code,
    debit: line.debit.toFixed(3),
    credit: line.credit.toFixed(3),
    party: line.partyId !== null,
  }));
}

describe('platform authentication', () => {
  it('is turned off by default and needs a platform key', async () => {
    const defaults = loadConfig(baseEnv);
    expect(defaults.platform.provisioningEnabled).toBe(false);
    expect(defaults.crmPostingEnabled).toBe(false);
    const off = appWith({});
    const disabled = await off.put(`${ws}/${randomUUID()}`).set(platform).send(body());
    expect(disabled.status).toBe(403);
    expect(errorCode(disabled)).toBe('PLATFORM_DISABLED');

    const id = randomUUID();
    expect((await api.get(`${ws}/${id}`)).status).toBe(401);
    const wrong = await api
      .get(`${ws}/${id}`)
      .set({ authorization: `Bearer nxp_prov1_${'t'.repeat(40)}` });
    expect(wrong.status).toBe(401);
    const unknownKey = await api
      .get(`${ws}/${id}`)
      .set({ authorization: `Bearer nxp_other_${'s'.repeat(40)}` });
    expect(unknownKey.status).toBe(401);
    const browser = await api.get(`${ws}/${id}`).set(platform).set('origin', 'https://evil.test');
    expect(browser.status).toBe(403);
    const ok = await api.get(`${ws}/${id}`).set(platform);
    expect(ok.status).toBe(404);
    expect(ok.headers['cache-control']).toBe('no-store');

    const world = await createWorld(prisma, api, 'people');
    expect((await api.get(`${ws}/${id}`).set(world.auth)).status).toBe(401);
    expect((await api.get('/api/v1/companies').set(platform)).status).toBe(401);
  });

  it('rejects provisioning when enabled without keys', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        PLATFORM_PROVISIONING_ENABLED: 'true',
      }),
    ).toThrow(/PLATFORM_API_KEYS/);
  });

  it('rate limits each key', async () => {
    const limited = appWith({ ...platformEnv, PLATFORM_RATE_LIMIT_MAX: '2' });
    const id = randomUUID();
    await limited.get(`${ws}/${id}`).set(platform);
    await limited.get(`${ws}/${id}`).set(platform);
    const third = await limited.get(`${ws}/${id}`).set(platform);
    expect(third.status).toBe(429);
    expect(errorCode(third)).toBe('RATE_LIMITED');
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('workspace provisioning', () => {
  it('creates an isolated tenant, company, general chart, fiscal year and profile once', async () => {
    const workspaceId = randomUUID();
    const first = await api.put(`${ws}/${workspaceId}`).set(platform).send(body());
    expect(first.status).toBe(201);
    const created = first.body as Provisioned;
    expect(created).toMatchObject({ workspaceId, status: 'active', currency: 'KWD' });
    expect(created.fiscalYears).toEqual([{ start: '2026-01-01', end: '2026-12-31' }]);
    expect(
      Object.fromEntries(Object.entries(created.profile).map(([role, row]) => [role, row.code])),
    ).toEqual({
      receivable: '1210',
      revenue: '4100',
      sales_returns: '4900',
      receipts_clearing: '1150',
      tax_payable: '2300',
      opening_equity: '3900',
      adjustments: '4950',
    });

    const again = await api.put(`${ws}/${workspaceId}`).set(platform).send(body());
    expect(again.status).toBe(200);
    expect(again.body).toEqual(created);

    expect(await prisma.user.count({ where: { tenantId: created.tenantId } })).toBe(0);
    const company = await prisma.company.findUniqueOrThrow({ where: { id: created.companyId } });
    expect(company).toMatchObject({ tenantId: created.tenantId, baseCurrency: 'KWD' });
    const codes = (await prisma.account.findMany({ where: { companyId: created.companyId } })).map(
      (row) => row.code,
    );
    expect(codes).toEqual(expect.arrayContaining(['1110', '1120', '1150', '1210', '2110', '6100']));
    expect(codes).not.toContain('4110');
    const periods = await prisma.period.findMany({ where: { companyId: created.companyId } });
    expect(periods).toHaveLength(12);
    expect(periods.every((row) => row.status === 'OPEN')).toBe(true);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: created.tenantId, action: 'platform.crm_workspace.provision' },
    });
    expect(audit.userId).toBeNull();
    expect(audit.data).toMatchObject({ platformKeyId: 'prov1' });
  });

  it('rejects a changed request, a taken slug and bad input', async () => {
    const first = await provision();
    const changed = await api
      .put(`${ws}/${first.workspaceId}`)
      .set(platform)
      .send(body('crm-acme', { tenant: { slug: 'crm-acme', name: 'Renamed' } }));
    expect(changed.status).toBe(409);
    expect(errorCode(changed)).toBe('WORKSPACE_REQUEST_CONFLICT');
    const taken = await api.put(`${ws}/${randomUUID()}`).set(platform).send(body());
    expect(taken.status).toBe(409);
    expect(errorCode(taken)).toBe('TENANT_SLUG_TAKEN');
    await prisma.tenant.create({ data: { slug: 'easyoffice', name: 'Demo' } });
    const demo = await api.put(`${ws}/${randomUUID()}`).set(platform).send(body('easyoffice'));
    expect(errorCode(demo)).toBe('TENANT_SLUG_TAKEN');

    for (const bad of [
      body('crm-usd', { currency: 'USD' }),
      body('crm-chart', { chartTemplate: 'restaurant' }),
      body('crm-extra', { extra: true }),
      body('crm-fy', {
        company: { ...body().company, firstFiscalYearStart: '2026-02-01' },
      }),
    ]) {
      const response = await api.put(`${ws}/${randomUUID()}`).set(platform).send(bad);
      expect(response.status).toBe(400);
      expect(errorCode(response)).toBe('VALIDATION_ERROR');
    }
    expect((await api.put(`${ws}/not-a-uuid`).set(platform).send(body('crm-x'))).status).toBe(400);
    expect(await prisma.crmWorkspaceBinding.count()).toBe(1);
  });

  it('serializes concurrent provisioning of one workspace', async () => {
    const workspaceId = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => api.put(`${ws}/${workspaceId}`).set(platform).send(body())),
    );
    expect(responses.map((row) => row.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(new Set(responses.map((row) => (row.body as Provisioned).companyId)).size).toBe(1);
    expect(await prisma.tenant.count({ where: { slug: 'crm-acme' } })).toBe(1);
    expect(await prisma.crmWorkspaceBinding.count()).toBe(1);
    expect(await prisma.fiscalYear.count()).toBe(1);
  });

  it('gives the same slug to one of two racing workspaces only', async () => {
    const responses = await Promise.all(
      [randomUUID(), randomUUID()].map((id) => api.put(`${ws}/${id}`).set(platform).send(body())),
    );
    expect(responses.map((row) => row.status).sort()).toEqual([201, 409]);
    expect(await prisma.tenant.count()).toBe(1);
  });

  it('repairs a missing default without touching accounts and refuses a wrong-typed account', async () => {
    const first = await provision();
    const before = await prisma.account.findMany({
      where: { companyId: first.companyId },
      orderBy: { code: 'asc' },
    });
    await prisma.crmPostingProfile.deleteMany({
      where: { companyId: first.companyId, role: 'receivable' },
    });
    const repaired = await api.put(`${ws}/${first.workspaceId}`).set(platform).send(body());
    expect(repaired.status).toBe(200);
    expect((repaired.body as Provisioned).profile.receivable).toEqual(first.profile.receivable);
    expect(
      await prisma.account.findMany({
        where: { companyId: first.companyId },
        orderBy: { code: 'asc' },
      }),
    ).toEqual(before);

    await prisma.crmPostingProfile.deleteMany({
      where: { companyId: first.companyId, role: 'receivable' },
    });
    await prisma.account.update({
      where: { id: first.profile.receivable.accountId },
      data: { type: 'LIABILITY' },
    });
    const conflict = await api.put(`${ws}/${first.workspaceId}`).set(platform).send(body());
    expect(conflict.status).toBe(409);
    expect(errorCode(conflict)).toBe('CHART_CONFLICT');
    expect(
      await prisma.crmPostingProfile.count({
        where: { companyId: first.companyId, role: 'receivable' },
      }),
    ).toBe(0);
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: first.profile.receivable.accountId },
    });
    expect(account.type).toBe('LIABILITY');
  });

  it('leaves existing tenants and restaurant companies untouched', async () => {
    const world = await createWorld(prisma, api, 'legacy');
    const accountsBefore = await prisma.account.count({ where: { companyId: world.company.id } });
    await provision();
    expect(await prisma.account.count({ where: { companyId: world.company.id } })).toBe(
      accountsBefore,
    );
    expect(world.account('4110')).toBeTruthy();
    expect(await prisma.crmPostingProfile.count({ where: { companyId: world.company.id } })).toBe(
      0,
    );
  });
});

describe('service credentials', () => {
  it('registers, rotates and revokes hashes idempotently', async () => {
    const binding = await provision();
    const url = (id: string) => `${ws}/${binding.workspaceId}/credentials/${id}`;
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    const [ha, hb, hc] = ['a', 'b', 'c'].map((value) => sha(`nxc_${value}`));
    expect((await api.put(url(a)).set(platform).send({ tokenSha256: ha })).status).toBe(201);
    const replay = await api.put(url(a)).set(platform).send({ tokenSha256: ha });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ credentialId: a, status: 'active' });
    const changed = await api.put(url(a)).set(platform).send({ tokenSha256: hb });
    expect(errorCode(changed)).toBe('CREDENTIAL_CONFLICT');
    const reused = await api.put(url(b)).set(platform).send({ tokenSha256: ha });
    expect(errorCode(reused)).toBe('CREDENTIAL_CONFLICT');
    expect((await api.put(url(b)).set(platform).send({ tokenSha256: hb })).status).toBe(201);
    const third = await api.put(url(c)).set(platform).send({ tokenSha256: hc });
    expect(third.status).toBe(409);
    expect(errorCode(third)).toBe('TOO_MANY_CREDENTIALS');
    expect((await api.delete(url(a)).set(platform)).status).toBe(204);
    expect((await api.delete(url(a)).set(platform)).status).toBe(204);
    expect((await api.delete(url(randomUUID())).set(platform)).status).toBe(204);
    expect((await api.put(url(c)).set(platform).send({ tokenSha256: hc })).status).toBe(201);
    const revokedAgain = await api.put(url(a)).set(platform).send({ tokenSha256: ha });
    expect(revokedAgain.status).toBe(409);

    const read = await api.get(`${ws}/${binding.workspaceId}`).set(platform);
    expect(read.status).toBe(200);
    const text = JSON.stringify(read.body);
    for (const hash of [ha, hb, hc]) expect(text).not.toContain(hash);
    expect(text).not.toMatch(/nxc_|nxp_|tokenHash/);
    const states = Object.fromEntries(
      (read.body as { credentials: { credentialId: string; status: string }[] }).credentials.map(
        (row) => [row.credentialId, row.status],
      ),
    );
    expect(states).toEqual({ [a]: 'revoked', [b]: 'active', [c]: 'active' });
  });

  it('authenticates only the bound workspace and stops on revoke or suspend', async () => {
    const one = await connect('crm-one');
    const two = await connect('crm-two');
    const connection = await api.get(`${crm}/connection`).set(one.headers);
    expect(connection.status).toBe(200);
    expect(connection.headers['cache-control']).toBe('no-store');
    expect(connection.body).toMatchObject({
      bindingId: one.binding.bindingId,
      workspaceId: one.binding.workspaceId,
      tenantId: one.binding.tenantId,
      companyId: one.binding.companyId,
      currency: 'KWD',
      postingEnabled: true,
    });
    expect((connection.body as { openPeriods: unknown[] }).openPeriods).toContainEqual({
      start: '2026-01-01',
      end: '2026-01-31',
    });
    expect(
      (connection.body as { profile: Record<string, unknown> }).profile.receivable,
    ).toMatchObject({ code: '1210' });
    expect(JSON.stringify(connection.body)).not.toMatch(/nxc_|nxp_/);

    const mismatch = { ...one.headers, 'x-crm-workspace-id': two.binding.workspaceId };
    expect((await api.get(`${crm}/connection`).set(mismatch)).status).toBe(401);
    expect(
      (await api.get(`${crm}/connection`).set({ authorization: one.headers.authorization })).status,
    ).toBe(401);
    expect(
      (
        await api
          .get(`${crm}/connection`)
          .set({ ...one.headers, authorization: platform.authorization })
      ).status,
    ).toBe(401);
    expect((await api.get(`${ws}/${one.binding.workspaceId}`).set(one.headers)).status).toBe(401);

    const accounts = await api
      .get(`${crm}/accounts?companyId=${two.binding.companyId}`)
      .set(one.headers);
    expect(accounts.status).toBe(200);
    expect(
      (accounts.body as { companyId: string }[]).every(
        (row) => row.companyId === one.binding.companyId,
      ),
    ).toBe(true);
    expect(
      (await api.get(`${crm}/trial-balance?from=2026-01-01&to=2026-12-31`).set(one.headers)).status,
    ).toBe(200);
    expect((await api.get(`${crm}/journals`).set(one.headers)).status).toBe(200);
    // Hosted credentials cannot use the raw-lines legacy posting route.
    expect((await api.post(`${crm}/journals`).set(one.headers).send({})).status).toBe(401);

    expect((await api.post(`${ws}/${one.binding.workspaceId}/suspend`).set(platform)).body).toEqual(
      { status: 'suspended' },
    );
    expect((await api.get(`${crm}/connection`).set(one.headers)).status).toBe(401);
    const suspendedPut = await api
      .put(`${ws}/${one.binding.workspaceId}/credentials/${randomUUID()}`)
      .set(platform)
      .send({ tokenSha256: sha('nxc_new') });
    expect(suspendedPut.status).toBe(409);
    await api.post(`${ws}/${one.binding.workspaceId}/resume`).set(platform);
    expect((await api.get(`${crm}/connection`).set(one.headers)).status).toBe(200);

    await prisma.company.update({
      where: { id: one.binding.companyId },
      data: { isActive: false },
    });
    expect((await api.get(`${crm}/connection`).set(one.headers)).status).toBe(401);
    await prisma.company.update({ where: { id: one.binding.companyId }, data: { isActive: true } });

    await api
      .delete(`${ws}/${one.binding.workspaceId}/credentials/${one.credentialId}`)
      .set(platform);
    expect((await api.get(`${crm}/connection`).set(one.headers)).status).toBe(401);
    expect((await api.get(`${crm}/connection`).set(two.headers)).status).toBe(200);
  });

  it('keeps legacy integration tokens on the legacy routes only', async () => {
    const world = await createWorld(prisma, api);
    const created = await api
      .post(`/api/v1/companies/${world.company.id}/crm-integration`)
      .set(world.auth);
    const legacy = { authorization: `Bearer ${(created.body as { token: string }).token}` };
    expect((await api.get(`${crm}/connection`).set(legacy)).status).toBe(200);
    const payload = event('invoice.issued');
    const posted = await send(api, legacy, payload);
    expect(posted.status).toBe(401);
    expect((await api.get(`${crm}/receivables`).set(legacy)).status).toBe(401);
  });
});

describe('CRM events', () => {
  it('posts each event type with party lines on the receivable account', async () => {
    const { headers, binding } = await connect();
    const expected: Record<
      string,
      { code: string; debit: string; credit: string; party: boolean }[]
    > = {
      'invoice.issued': [
        { code: '1210', debit: '105.000', credit: '0.000', party: true },
        { code: '4100', debit: '0.000', credit: '100.000', party: false },
        { code: '2300', debit: '0.000', credit: '5.000', party: false },
      ],
      'payment.received': [
        { code: '1150', debit: '105.000', credit: '0.000', party: false },
        { code: '1210', debit: '0.000', credit: '105.000', party: true },
      ],
      'credit_note.issued': [
        { code: '4900', debit: '100.000', credit: '0.000', party: false },
        { code: '2300', debit: '5.000', credit: '0.000', party: false },
        { code: '1210', debit: '0.000', credit: '105.000', party: true },
      ],
      'refund.paid': [
        { code: '1210', debit: '105.000', credit: '0.000', party: true },
        { code: '1150', debit: '0.000', credit: '105.000', party: false },
      ],
    };
    for (const [type, lines] of Object.entries(expected)) {
      const payload = event(type);
      const response = await send(api, headers, payload);
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ eventId: payload.eventId, duplicate: false });
      expect(await linesOf(journalIdOf(response))).toEqual(lines);
      const entry = await prisma.journalEntry.findUniqueOrThrow({
        where: { id: journalIdOf(response) },
      });
      expect(entry).toMatchObject({
        companyId: binding.companyId,
        status: 'POSTED',
        source: 'INTEGRATION',
        sourceSystem: `crm:${binding.bindingId}`,
        externalId: payload.eventId,
        createdById: null,
        postedById: null,
        description: payload.description,
        reference: payload.reference,
      });
      expect(entry.date.toISOString().slice(0, 10)).toBe('2026-02-10');
    }
    const invoiceWithoutTax = event('invoice.issued', {
      amounts: { net: '10', tax: '0', total: '10.000' },
    });
    const noTax = await send(api, headers, invoiceWithoutTax);
    expect(noTax.status).toBe(201);
    expect((await linesOf(journalIdOf(noTax))).map((line) => line.code)).toEqual(['1210', '4100']);

    expect(await prisma.subledgerParty.count()).toBe(1);
    const balance = await api.get(`${crm}/customers/42/balance`).set(headers);
    expect(balance.body).toMatchObject({ ref: '42', balance: '10.000' });
    expect((balance.body as { partyId: string | null }).partyId).toBeTruthy();
    expect((await api.get(`${crm}/customers/99/balance`).set(headers)).body).toEqual({
      ref: '99',
      partyId: null,
      balance: '0.000',
    });
    expect((await api.get(`${crm}/receivables`).set(headers)).body).toEqual([
      { ref: '42', name: 'Gulf Retail', balance: '10.000' },
    ]);
    expect((await api.get(`${crm}/receivables?asOf=2026-01-31`).set(headers)).body).toEqual([]);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: binding.tenantId, action: 'journal.post' },
    });
    expect(audit.userId).toBeNull();
    expect(audit.data).toMatchObject({ principal: 'crm_service', bindingId: binding.bindingId });
  });

  it('replays duplicates, rejects changed content and posts one journal under concurrency', async () => {
    const { headers } = await connect();
    const payload = event('invoice.issued');
    const first = await send(api, headers, payload);
    expect(first.status).toBe(201);
    const replay = await send(api, headers, {
      ...payload,
      customer: { ...payload.customer, name: 'New name' },
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, duplicate: true });
    const changed = await send(api, headers, { ...payload, reference: 'INV-0002' });
    expect(changed.status).toBe(409);
    expect(errorCode(changed)).toBe('CRM_EVENT_CONFLICT');

    const racing = event('payment.received');
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => send(api, headers, racing)),
    );
    expect(responses.every((row) => [200, 201].includes(row.status))).toBe(true);
    expect(responses.filter((row) => row.status === 201)).toHaveLength(1);
    expect(new Set(responses.map((row) => journalIdOf(row))).size).toBe(1);
    expect(await prisma.journalEntry.count({ where: { externalId: racing.eventId } })).toBe(1);
    const numbers = (await prisma.journalEntry.findMany({ orderBy: { number: 'asc' } })).map(
      (row) => row.number,
    );
    expect(numbers).toEqual([1, 2]);
  });

  it('keeps the same customer separate in two workspaces', async () => {
    const one = await connect('crm-one');
    const two = await connect('crm-two');
    const first = await send(api, one.headers, event('invoice.issued', { eventId: 'same:1' }));
    const second = await send(api, two.headers, event('invoice.issued', { eventId: 'same:1' }));
    expect([first.status, second.status]).toEqual([201, 201]);
    const parties = await prisma.subledgerParty.findMany();
    expect(new Set(parties.map((row) => row.companyId))).toEqual(
      new Set([one.binding.companyId, two.binding.companyId]),
    );
    expect((await api.get(`${crm}/journals`).set(one.headers)).body).toMatchObject({
      total: 1,
    });
  });

  it('checks posting switch, headers, validation and accounting rules', async () => {
    const { headers, binding } = await connect();
    const off = appWith(platformEnv);
    const disabled = await send(off, headers, event('invoice.issued'));
    expect(disabled.status).toBe(403);
    expect(errorCode(disabled)).toBe('POSTING_DISABLED');
    // Authentication comes first, even with posting off.
    expect(
      (await send(off, { ...headers, authorization: 'Bearer nxc_nope' }, event('invoice.issued')))
        .status,
    ).toBe(401);

    const payload = event('invoice.issued');
    const mismatch = await api
      .post(`${crm}/events`)
      .set(headers)
      .set('idempotency-key', 'other')
      .send(payload);
    expect(errorCode(mismatch)).toBe('IDEMPOTENCY_KEY_MISMATCH');
    for (const bad of [
      event('invoice.issued', { amounts: { net: '100.000', tax: '5.000', total: '104.000' } }),
      event('payment.received', { amounts: { net: '100.000', tax: '5.000', total: '105.000' } }),
      event('invoice.issued', { amounts: { net: '0', tax: '0', total: '0' } }),
      event('invoice.issued', { amounts: { net: '1.0001', tax: '0', total: '1.0001' } }),
      event('invoice.issued', { type: 'quote.accepted' }),
      event('invoice.issued', { eventId: 'bad id' }),
      event('invoice.issued', { extra: 1 }),
      event('invoice.issued', { source: { blob: 'x'.repeat(2000) } }),
    ]) {
      const response = await send(api, headers, bad);
      expect(response.status).toBe(400);
      expect(errorCode(response)).toBe('VALIDATION_ERROR');
    }
    const usd = await send(api, headers, event('invoice.issued', { currency: 'USD' }));
    expect(usd.status).toBe(422);
    expect(errorCode(usd)).toBe('CURRENCY_NOT_SUPPORTED');

    const noPeriod = await send(api, headers, event('invoice.issued', { date: '2030-01-01' }));
    expect(noPeriod.status).toBe(422);
    expect(errorCode(noPeriod)).toBe('NO_PERIOD');
    await prisma.period.updateMany({
      where: { companyId: binding.companyId, startDate: new Date('2026-02-01T00:00:00Z') },
      data: { status: 'CLOSED' },
    });
    const closed = await send(api, headers, event('invoice.issued'));
    expect(closed.status).toBe(422);
    expect(errorCode(closed)).toBe('PERIOD_CLOSED');

    await prisma.crmPostingProfile.deleteMany({
      where: { companyId: binding.companyId, role: 'revenue' },
    });
    const incomplete = await send(api, headers, event('invoice.issued', { date: '2026-03-01' }));
    expect(incomplete.status).toBe(422);
    expect(errorCode(incomplete)).toBe('PROFILE_INCOMPLETE');
    await prisma.account.update({
      where: { id: binding.profile.receipts_clearing.accountId },
      data: { isActive: false },
    });
    const inactive = await send(api, headers, event('payment.received', { date: '2026-03-01' }));
    expect(inactive.status).toBe(422);
    expect(['PROFILE_INCOMPLETE', 'INVALID_ACCOUNT']).toContain(errorCode(inactive));
    expect(await prisma.journalEntry.count()).toBe(0);
    expect(await prisma.subledgerParty.count()).toBe(0);
  });
});
