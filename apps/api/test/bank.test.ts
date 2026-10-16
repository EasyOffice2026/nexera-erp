import type {
  BankAccountSummary,
  BankCandidate,
  BankImportResult,
  BankLine,
  BankReconciliation,
  Page,
} from '@nexera/shared';
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

async function journal(world: World, date: string, debit: string, credit: string, amount: string) {
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
  return api.post(`${base}/${(draft.body as { id: string }).id}/post`).set(world.auth);
}

const header = ['Date', 'Description', 'Reference', 'Debit', 'Credit', 'Balance'];
const mapping = {
  headerRow: 0,
  date: 0,
  dateOrder: 'DMY',
  description: 1,
  reference: 2,
  amountMode: 'split',
  moneyOut: 3,
  moneyIn: 4,
  balance: 5,
};
const january = [
  header,
  ['', 'Opening balance', '', '', '', '0.000'],
  ['06/01/2026', 'CAPITAL DEPOSIT', '', '', '10,000.000', '10,000.000'],
  ['12/01/2026', 'CHEQUE 1001', 'CHQ1001', '2,000.000', '', '8,000.000'],
  ['15/01/2026', 'KNET SETTLEMENT 0115', '', '', '450.250', '8,450.250'],
  ['20/01/2026', 'BANK CHARGES', '', '2.500', '', '8,447.750'],
];

async function setup() {
  const world = await createWorld(prisma, api);
  const base = `/api/v1/companies/${world.company.id}/bank`;
  await journal(world, '2026-01-05', '1130', '3100', '10000');
  await journal(world, '2026-01-10', '5110', '1130', '2000');
  const created = await api
    .post(`${base}/accounts`)
    .set(world.auth)
    .send({ accountId: world.account('1130'), bankName: 'NBK', accountNumber: '****1234' });
  expect(created.status).toBe(201);
  const bank = created.body as BankAccountSummary;
  const rule = await api
    .post(`${base}/rules`)
    .set(world.auth)
    .send({ name: 'KNET', contains: 'knet', direction: 'IN', accountId: world.account('1210') });
  expect(rule.status).toBe(201);
  const upload = (rows: string[][], fileName = 'jan.xlsx') =>
    api
      .post(`${base}/accounts/${bank.id}/statements`)
      .set(world.auth)
      .send({ fileName, rows, mapping });
  const lines = async (status?: string) =>
    (
      await api
        .get(`${base}/accounts/${bank.id}/lines${status ? `?status=${status}` : ''}`)
        .set(world.auth)
    ).body as Page<BankLine>;
  return { world, base: `${base}/accounts/${bank.id}`, root: base, bank, upload, lines };
}

describe('bank reconciliation', () => {
  it('imports a statement once, matches it and creates journals from rules', async () => {
    const { world, base, upload, lines } = await setup();
    const res = await upload(january);
    expect(res.status).toBe(201);
    expect(res.body as BankImportResult).toMatchObject({
      imported: 4,
      duplicates: 0,
      skipped: [{ row: 2, reason: 'NO_DATE' }],
      autoMatched: 2,
      ruleJournals: 1,
    });
    const again = await upload(january, 'jan-again.xlsx');
    expect(again.body as BankImportResult).toMatchObject({ imported: 0, duplicates: 4 });

    const open = await lines('unmatched');
    expect(open.items.map((line) => [line.description, line.amount])).toEqual([
      ['BANK CHARGES', '-2.500'],
    ]);
    const knet = (await lines('matched')).items.find((line) => line.ruleName === 'KNET');
    expect(knet?.journalNumber).toBeGreaterThan(0);

    const charges = open.items[0]!;
    const none = await api.get(`${base}/lines/${charges.id}/candidates`).set(world.auth);
    expect(none.body).toEqual([]);
    const fee = await prisma.account.findFirstOrThrow({
      where: {
        companyId: world.company.id,
        taxonomyConcept: { contains: 'BankAndSimilarCharges' },
      },
    });
    const made = await api
      .post(`${base}/lines/${charges.id}/journal`)
      .set(world.auth)
      .send({ accountId: fee.id });
    expect(made.status).toBe(201);
    const matched = made.body as BankLine;
    expect(matched.status).toBe('matched');
    const entry = await api
      .get(`/api/v1/companies/${world.company.id}/journals/${matched.journalId}`)
      .set(world.auth);
    expect(entry.body).toMatchObject({ source: 'BANK', status: 'POSTED', totalDebit: '2.500' });

    const accounts = (
      await api.get(`/api/v1/companies/${world.company.id}/bank/accounts`).set(world.auth)
    ).body as BankAccountSummary[];
    expect(accounts[0]).toMatchObject({
      bookBalance: '8447.750',
      statementBalance: '8447.750',
      unmatchedCount: 0,
      lastLineDate: '2026-01-20',
      mapping: { amountMode: 'split', moneyIn: 4 },
    });
  });

  it('reconciles, locks the month and suggests later matches', async () => {
    const { world, base, upload, lines } = await setup();
    await upload(january);
    const charges = (await lines('unmatched')).items[0]!;
    const fee = await prisma.account.findFirstOrThrow({
      where: {
        companyId: world.company.id,
        taxonomyConcept: { contains: 'BankAndSimilarCharges' },
      },
    });
    await api
      .post(`${base}/lines/${charges.id}/journal`)
      .set(world.auth)
      .send({ accountId: fee.id });
    // A cheque written in January that the bank pays in February.
    await journal(world, '2026-01-25', '5110', '1130', '100');

    const rec = await api.get(`${base}/reconciliation?asOf=2026-01-31`).set(world.auth);
    expect(rec.body as BankReconciliation).toMatchObject({
      bookBalance: '8347.750',
      statementBalance: '8447.750',
      bankBalanceColumn: '8447.750',
      unmatchedBank: [],
      unmatchedBookTotal: '-100.000',
      difference: '0.000',
      canLock: true,
    });

    const lock = await api
      .post(`${base}/reconciliations`)
      .set(world.auth)
      .send({ asOf: '2026-01-31' });
    expect(lock.status).toBe(201);
    expect((lock.body as BankReconciliation).reconciledUntil).toBe('2026-01-31');

    const late = await journal(world, '2026-01-20', '1130', '3100', '5');
    expect(JSON.stringify(late.body)).toContain('BANK_RECONCILED');
    const matched = (await lines('matched')).items[0]!;
    const unmatch = await api.post(`${base}/lines/${matched.id}/unmatch`).set(world.auth);
    expect(JSON.stringify(unmatch.body)).toContain('BANK_RECONCILED');
    const old = await upload([header, ['30/01/2026', 'LATE', '', '1.000', '', '']], 'late.csv');
    expect(JSON.stringify(old.body)).toContain('BANK_RECONCILED');

    const february = await upload(
      [header, ['02/02/2026', 'CHEQUE 1002', '', '100.000', '', '8,347.750']],
      'feb.csv',
    );
    expect(february.body).toMatchObject({ imported: 1, autoMatched: 0 });
    const cheque = (await lines('unmatched')).items[0]!;
    const candidates = (await api.get(`${base}/lines/${cheque.id}/candidates`).set(world.auth))
      .body as BankCandidate[];
    expect(candidates.map((row) => [row.date, row.amount])).toEqual([['2026-01-25', '-100.000']]);
    const wrong = await api
      .post(`${base}/lines/${cheque.id}/match`)
      .set(world.auth)
      .send({
        journalLineId: (await prisma.journalLine.findFirstOrThrow({ where: { debit: 10000 } })).id,
      });
    expect(JSON.stringify(wrong.body)).toMatch(/INVALID_MATCH|MATCH_AMOUNT_DIFFERS/);
    const ok = await api
      .post(`${base}/lines/${cheque.id}/match`)
      .set(world.auth)
      .send({ journalLineId: candidates[0]!.journalLineId });
    expect((ok.body as BankLine).status).toBe('matched');
  });

  it('links only bank accounts, once each', async () => {
    const { world, root } = await setup();
    const cash = await api
      .post(`${root}/accounts`)
      .set(world.auth)
      .send({ accountId: world.account('1110'), bankName: 'KFH' });
    expect(JSON.stringify(cash.body)).toContain('INVALID_ACCOUNT');
    const twice = await api
      .post(`${root}/accounts`)
      .set(world.auth)
      .send({ accountId: world.account('1130'), bankName: 'KFH' });
    expect(twice.status).toBe(409);
  });

  it('lets the auditor read but not import, and keeps tenants apart', async () => {
    const { world, root, base } = await setup();
    const auditor = await createUser(prisma, world.tenant.id, 'auditor', 'auditor@acme.com');
    const auth = await signIn(api, 'acme', auditor.email);
    expect((await api.get(`${root}/accounts`).set(auth)).status).toBe(200);
    const upload = await api
      .post(`${base}/statements`)
      .set(auth)
      .send({ fileName: 'x.csv', rows: january, mapping });
    expect(upload.status).toBe(403);

    const other = await createWorld(prisma, api, 'other');
    expect((await api.get(`${root}/accounts`).set(other.auth)).status).toBe(404);
    expect((await api.get(`${base}/lines`).set(other.auth)).status).toBe(404);
  });
});
