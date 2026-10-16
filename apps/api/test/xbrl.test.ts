import type { XbrlFact, XbrlPreview } from '@nexera/shared';
import supertest from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestPrisma,
  createUser,
  createWorld,
  resetDatabase,
  signIn,
} from './helpers';

const prisma = createTestPrisma();
const api = supertest(createTestApp(prisma));

beforeEach(() => resetDatabase(prisma));
afterAll(() => prisma.$disconnect());

type World = Awaited<ReturnType<typeof createWorld>>;

// Debits the first account and credits the second, by account code.
async function journal(
  world: World,
  date: string,
  debit: string,
  credit: string,
  amount: string,
  post = true,
) {
  const base = `/api/v1/companies/${world.company.id}/journals`;
  const draft = await api
    .post(base)
    .set(world.auth)
    .send({
      date,
      description: `${debit}/${credit}`,
      lines: [
        { accountId: world.account(debit), debit: amount, credit: '0' },
        { accountId: world.account(credit), debit: '0', credit: amount },
      ],
    });
  expect(draft.status).toBe(201);
  if (!post) return;
  const posted = await api
    .post(`${base}/${(draft.body as { id: string }).id}/post`)
    .set(world.auth);
  expect(posted.status).toBe(200);
}

// Capital in, equipment bought, sales, cost of sales and depreciation.
async function firstYear(world: World) {
  await journal(world, '2026-01-05', '1130', '3100', '10000');
  await journal(world, '2026-01-10', '1510', '1130', '3000');
  await journal(world, '2026-03-15', '1110', '4110', '5000');
  await journal(world, '2026-03-20', '5110', '1130', '2000');
  await journal(world, '2026-12-31', '6310', '1590', '100');
}

const FY = 'from=2026-01-01&to=2026-12-31';

function preview(world: World, auth = world.auth) {
  return api.get(`/api/v1/companies/${world.company.id}/xbrl/preview?${FY}`).set(auth);
}

const fact = (facts: XbrlFact[], concept: string, period: XbrlFact['period'] = 'current') =>
  facts.find((row) => row.concept === `ifrs-full:${concept}` && row.period === period);

describe('XBRL preparation', () => {
  it('builds the facts of the year from the posted statements', async () => {
    const world = await createWorld(prisma, api);
    await firstYear(world);
    await journal(world, '2026-06-01', '1110', '4110', '999', false);

    const res = await preview(world);
    expect(res.status).toBe(200);
    const body = res.body as XbrlPreview;
    expect(body.ready).toBe(true);
    expect(body.prior).toBeNull();
    expect(body.crNumber).toBe('CR-acme');
    const value = (concept: string) => fact(body.facts, concept)?.value;
    expect(value('RevenueFromSaleOfGoods')).toBe('5000.000');
    expect(value('Revenue')).toBe('5000.000');
    expect(value('CostOfSales')).toBe('2000.000');
    expect(value('GrossProfit')).toBe('3000.000');
    expect(value('DepreciationPropertyPlantAndEquipment')).toBe('100.000');
    expect(value('ProfitLoss')).toBe('2900.000');
    expect(value('PropertyPlantAndEquipment')).toBe('2900.000');
    expect(fact(body.facts, 'PropertyPlantAndEquipment')?.accounts).toEqual(['1510', '1590']);
    expect(value('Machinery')).toBeUndefined();
    expect(value('CashAndCashEquivalents')).toBe('10000.000');
    expect(value('Assets')).toBe('12900.000');
    expect(value('IssuedCapital')).toBe('10000.000');
    expect(value('RetainedEarnings')).toBe('2900.000');
    expect(value('Equity')).toBe('12900.000');
    expect(value('Liabilities')).toBe('0.000');
    expect(value('EquityAndLiabilities')).toBe('12900.000');
    expect(fact(body.facts, 'Assets')?.instant).toBe(true);
    expect(fact(body.facts, 'Revenue')?.instant).toBe(false);

    const status = Object.fromEntries(body.checks.map((check) => [check.code, check.ok]));
    expect(status).toMatchObject({
      TRIAL_BALANCE_BALANCED: true,
      BALANCE_SHEET_BALANCED: true,
      ALL_BALANCES_TAGGED: true,
      FULL_FINANCIAL_YEAR: true,
      PERIODS_CLOSED: false,
      NO_DRAFTS: false,
    });
  });

  it('downloads the instance document', async () => {
    const world = await createWorld(prisma, api);
    await firstYear(world);
    const res = await api
      .get(`/api/v1/companies/${world.company.id}/xbrl/instance?${FY}`)
      .set(world.auth)
      .buffer(true)
      .parse((response, done) => {
        let text = '';
        response.on('data', (chunk: Buffer) => (text += chunk.toString()));
        response.on('end', () => done(null, text));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.headers['content-disposition']).toContain('CR-acme_2026-12-31.xbrl');
    const xml = res.body as string;
    expect(xml).toContain('xlink:href="https://xbrl.ifrs.org/taxonomy/2025-03-27/');
    expect(xml).toContain('>CR-acme</xbrli:identifier>');
    expect(xml).toContain('<xbrli:startDate>2026-01-01</xbrli:startDate>');
    expect(xml).toContain(
      '<ifrs-full:Revenue contextRef="CY" unitRef="KWD" decimals="3">5000.000</ifrs-full:Revenue>',
    );
    expect(xml).toContain(
      '<ifrs-full:Assets contextRef="CY_I" unitRef="KWD" decimals="3">12900.000</ifrs-full:Assets>',
    );
    expect(xml).toContain(
      'Test Co WLL</ifrs-full:NameOfReportingEntityOrOtherMeansOfIdentification>',
    );
  });

  it('refuses the file while a balance has no taxonomy element or one tagged with a total', async () => {
    const world = await createWorld(prisma, api);
    await firstYear(world);
    await prisma.account.update({
      where: { id: world.account('4900') },
      data: { taxonomyConcept: null },
    });
    await prisma.account.update({
      where: { id: world.account('4170') },
      data: { taxonomyConcept: 'ifrs-full:Revenue' },
    });
    await journal(world, '2026-04-01', '1110', '4900', '50');
    await journal(world, '2026-04-02', '1110', '4170', '70');

    const body = (await preview(world)).body as XbrlPreview;
    expect(body.ready).toBe(false);
    const byCode = Object.fromEntries(body.checks.map((check) => [check.code, check]));
    expect(byCode.ALL_BALANCES_TAGGED).toMatchObject({ ok: false, accounts: ['4900'] });
    expect(byCode.NO_TOTALS_TAGGED).toMatchObject({ ok: false, accounts: ['4170'] });
    // The statement totals still include them.
    expect(fact(body.facts, 'Revenue')?.value).toBe('5070.000');
    expect(fact(body.facts, 'ProfitLoss')?.value).toBe('3020.000');

    const instance = await api
      .get(`/api/v1/companies/${world.company.id}/xbrl/instance?${FY}`)
      .set(world.auth);
    expect(instance.status).toBe(422);
  });

  it('adds the previous year when there are earlier postings', async () => {
    const world = await createWorld(prisma, api);
    const earlier = await api
      .post(`/api/v1/companies/${world.company.id}/fiscal-years`)
      .set(world.auth)
      .send({ startDate: '2025-01-01' });
    expect(earlier.status).toBe(201);
    await journal(world, '2025-06-01', '1130', '3100', '4000');
    await firstYear(world);

    const body = (await preview(world)).body as XbrlPreview;
    expect(body.prior).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    expect(fact(body.facts, 'IssuedCapital', 'prior')?.value).toBe('4000.000');
    expect(fact(body.facts, 'IssuedCapital')?.value).toBe('14000.000');
    expect(fact(body.facts, 'Revenue', 'prior')?.value).toBe('0.000');
  });

  it('lets an auditor prepare it and keeps other tenants out', async () => {
    const world = await createWorld(prisma, api);
    await firstYear(world);
    const auditor = await createUser(prisma, world.tenant.id, 'auditor', 'auditor@acme.com');
    expect((await preview(world, await signIn(api, 'acme', auditor.email))).status).toBe(200);

    const other = await createWorld(prisma, api, 'other');
    expect((await preview(world, other.auth)).status).toBe(404);
  });
});
