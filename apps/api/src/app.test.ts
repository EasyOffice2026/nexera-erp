import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { loadConfig } from './config';
import { createPrismaClient } from './lib/prisma';

function testApp(url?: string) {
  const config = loadConfig({ NODE_ENV: 'test', PASSWORD_HASH_PROFILE: 'fast', DATABASE_URL: url });
  const db = createPrismaClient(config.databaseUrl);
  return { db, http: request(createApp(config, db)) };
}

describe('API routing', () => {
  const { db, http } = testApp();
  afterAll(() => db.$disconnect());

  it('serves liveness, leaves protected data guarded and returns JSON errors', async () => {
    await http
      .get('/api/v1/health')
      .expect(200, { status: 'ok' })
      .expect('Cache-Control', 'no-store');
    await http.get('/api/v1/companies').expect(401);
    await http.get('/api/v1/missing').expect(404);
    await http
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400);
  });
});

const database = process.env.NEXERA_TEST_DATABASE_URL;
describe.runIf(Boolean(database))('ledger on PostgreSQL', () => {
  const { db, http } = testApp(database);
  const slug = `ledger-test-${crypto.randomUUID()}`;
  const date = '2026-11-02';
  const start = new Date('2026-11-01');
  const end = new Date('2026-11-30');
  const password = 'test passphrase 267';
  const email = 'owner@example.test';
  let tenantId: string;
  let companyId: string;
  let outsiderCompanyId: string;
  let periodId: string;
  let nextPeriodId: string;
  let cash: string;
  let sales: string;
  let outsidersCash: string;
  let token: string;
  const route = () => `/api/v1/companies/${companyId}`;
  const bearer = () => `Bearer ${token}`;
  const submitted = () => ({
    description: 'November sales',
    date,
    lines: [
      { accountId: cash, debit: '120.125' },
      { accountId: sales, credit: '120.125' },
    ],
  });
  beforeAll(async () => {
    const { createPasswordHasher, hashProfiles } = await import('./lib/password');
    const passwordHash = await createPasswordHasher(hashProfiles.fast).hash(password);
    const [tenant, outsider] = await Promise.all(
      [slug, `${slug}-outside`].map((name) => db.tenant.create({ data: { name, slug: name } })),
    );
    if (!tenant || !outsider) throw new Error('Could not create test tenants');
    tenantId = tenant.id;
    const [company, other] = await Promise.all(
      [tenant.id, outsider.id].map((id) =>
        db.company.create({
          data: {
            tenantId: id,
            name: { en: 'Restaurant', ar: 'مطعم' },
            legalName: 'Restaurant',
            crNumber: '001',
          },
        }),
      ),
    );
    if (!company || !other) throw new Error('Could not create test companies');
    companyId = company.id;
    outsiderCompanyId = other.id;
    await db.user.createMany({
      data: [
        { tenantId, email, passwordHash, fullName: 'Finance Owner', role: 'owner' },
        {
          tenantId,
          email: 'auditor@example.test',
          passwordHash,
          fullName: 'Auditor',
          role: 'auditor',
        },
      ],
    });
    const year = await db.fiscalYear.create({
      data: {
        tenantId,
        companyId,
        name: '2026',
        startDate: start,
        endDate: new Date('2026-12-31'),
      },
    });
    periodId = (
      await db.period.create({
        data: {
          tenantId,
          companyId,
          fiscalYearId: year.id,
          number: 1,
          startDate: start,
          endDate: end,
        },
      })
    ).id;
    nextPeriodId = (
      await db.period.create({
        data: {
          tenantId,
          companyId,
          fiscalYearId: year.id,
          number: 2,
          startDate: new Date('2026-12-01'),
          endDate: new Date('2026-12-31'),
        },
      })
    ).id;
    const accounts = await db.account.createManyAndReturn({
      data: [
        {
          companyId,
          tenantId,
          code: '1000',
          name: { en: 'Cash', ar: 'نقد' },
          type: 'ASSET',
          subtype: 'cash',
        },
        {
          companyId,
          tenantId,
          code: '4000',
          name: { en: 'Sales', ar: 'مبيعات' },
          type: 'REVENUE',
          subtype: 'sales',
        },
        {
          companyId: other.id,
          tenantId: outsider.id,
          code: '1000',
          name: { en: 'Cash', ar: 'نقد' },
          type: 'ASSET',
          subtype: 'cash',
        },
      ],
    });
    cash = accounts.find(
      (account) => account.code === '1000' && account.companyId === companyId,
    )!.id;
    sales = accounts.find((account) => account.code === '4000')!.id;
    outsidersCash = accounts.find((account) => account.companyId === outsiderCompanyId)!.id;
    const session = await http
      .post('/api/v1/auth/login')
      .send({ tenant: slug, email, password })
      .expect(200);
    token = (session.body as { accessToken: string }).accessToken;
  });
  afterAll(() => db.$disconnect());

  it('lists only authorized companies and rejects foreign accounts, malformed amounts and unbalanced journals', async () => {
    const list = await http.get('/api/v1/companies').set('Authorization', bearer()).expect(200);
    expect(list.body).toEqual([expect.objectContaining({ id: companyId })]);
    await http
      .get(`/api/v1/companies/${outsiderCompanyId}/setup`)
      .set('Authorization', bearer())
      .expect(404);
    const endpoint = `${route()}/journals`;
    await http
      .post(endpoint)
      .set('Authorization', bearer())
      .send({
        ...submitted(),
        lines: [
          { accountId: outsidersCash, debit: '1.000' },
          { accountId: sales, credit: '1.000' },
        ],
      })
      .expect(409);
    await http
      .post(endpoint)
      .set('Authorization', bearer())
      .send({
        ...submitted(),
        lines: [
          { accountId: cash, debit: 'abc' },
          { accountId: sales, credit: '1.000' },
        ],
      })
      .expect(400);
    await http
      .post(endpoint)
      .set('Authorization', bearer())
      .send({
        ...submitted(),
        lines: [
          { accountId: cash, debit: '2.000' },
          { accountId: sales, credit: '1.000' },
        ],
      })
      .expect(409);
  });

  it('enforces current roles and invalidates existing sessions on password change', async () => {
    const email = 'auditor@example.test';
    const response = await http
      .post('/api/v1/auth/login')
      .send({ tenant: slug, email, password })
      .expect(200);
    const auditor = `Bearer ${(response.body as { accessToken: string }).accessToken}`;
    await http.get(`${route()}/setup`).set('Authorization', auditor).expect(200);
    await http
      .post(`${route()}/journals`)
      .set('Authorization', auditor)
      .send(submitted())
      .expect(403);
    const updated = await db.user.update({
      where: { tenantId_email: { tenantId, email } },
      data: { role: 'accountant' },
    });
    const permitted = await http
      .post(`${route()}/journals`)
      .set('Authorization', auditor)
      .send(submitted())
      .expect(201);
    await http
      .delete(`${route()}/journals/${(permitted.body as { id: string }).id}`)
      .set('Authorization', auditor)
      .expect(204);
    await http
      .patch(`/api/v1/users/${updated.id}`)
      .set('Authorization', bearer())
      .send({ password: 'new disposable passphrase 456' })
      .expect(200);
    await http.get(`${route()}/setup`).set('Authorization', auditor).expect(401);
    const cookie = (response.headers['set-cookie'] as unknown as string[])[0]?.split(';')[0];
    expect(cookie).toBeTruthy();
    await http
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie ?? '')
      .expect(401);
  });

  it('consumes each refresh token once under concurrent requests', async () => {
    const login = await http
      .post('/api/v1/auth/login')
      .send({ tenant: slug, email, password })
      .expect(200);
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0]?.split(';')[0];
    expect(cookie).toBeTruthy();
    const refresh = () => http.post('/api/v1/auth/refresh').set('Cookie', cookie ?? '');
    const results = await Promise.all([refresh(), refresh()]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
  });

  it('edits and deletes drafts, posts once under concurrency and reconciles a reversal', async () => {
    const endpoint = `${route()}/journals`;
    const balancePath = `${route()}/periods/${periodId}/trial-balance`;
    const draft = await http
      .post(endpoint)
      .set('Authorization', bearer())
      .send(submitted())
      .expect(201);
    const id = (draft.body as { id: string }).id;
    const journal = `${endpoint}/${id}`;
    await http
      .put(journal)
      .set('Authorization', bearer())
      .send({ ...submitted(), reference: 'POS-001' })
      .expect(200);
    const initial = await http.get(balancePath).set('Authorization', bearer()).expect(200);
    expect(initial.body).toMatchObject({ totals: { periodDebit: '0.000', periodCredit: '0.000' } });
    await db.period.update({ where: { id: periodId }, data: { status: 'CLOSED' } });
    await http.post(`${journal}/post`).set('Authorization', bearer()).expect(409);
    await db.period.update({ where: { id: periodId }, data: { status: 'OPEN' } });
    const post = () => http.post(`${journal}/post`).set('Authorization', bearer()).expect(200);
    const [first, second] = await Promise.all([post(), post()]);
    expect(first.body).toMatchObject({ number: 1, status: 'POSTED', reference: 'POS-001' });
    expect(second.body).toEqual(first.body);
    await http.delete(journal).set('Authorization', bearer()).expect(409);
    const posted = await http.get(balancePath).set('Authorization', bearer()).expect(200);
    expect(posted.body).toMatchObject({
      totals: { periodDebit: '120.125', closingDebit: '120.125', closingCredit: '120.125' },
    });
    const opening = await http
      .get(`${route()}/periods/${nextPeriodId}/trial-balance`)
      .set('Authorization', bearer())
      .expect(200);
    expect(opening.body).toMatchObject({
      totals: { openingDebit: '120.125', openingCredit: '120.125', periodDebit: '0.000' },
    });
    const search = await http
      .get(endpoint)
      .query({ search: 'JE-0001' })
      .set('Authorization', bearer())
      .expect(200);
    expect(search.body).toMatchObject({ total: 1, items: [expect.objectContaining({ id })] });
    const reverse = () =>
      http.post(`${journal}/reverse`).set('Authorization', bearer()).send({ date });
    const reversals = await Promise.all([reverse(), reverse()]);
    expect(reversals.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(reversals.find((result) => result.status === 201)?.body).toMatchObject({
      number: 2,
      reversesId: id,
    });
    const reconciled = await http.get(balancePath).set('Authorization', bearer()).expect(200);
    expect(reconciled.body).toMatchObject({
      totals: {
        periodDebit: '240.250',
        periodCredit: '240.250',
        closingDebit: '0.000',
        closingCredit: '0.000',
      },
    });
    expect(
      await db.auditLog.count({ where: { tenantId, action: 'journal.post', entityId: id } }),
    ).toBe(1);
    const extra = await http
      .post(endpoint)
      .set('Authorization', bearer())
      .send(submitted())
      .expect(201);
    await http
      .delete(`${endpoint}/${(extra.body as { id: string }).id}`)
      .set('Authorization', bearer())
      .expect(204);
  });
});
