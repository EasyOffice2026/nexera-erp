// Demo data for local development: tenant "easyoffice" with the two companies Mudawwarah and
// Khubuz Maraei, a brand and branches each, the template chart of accounts, FY2026, a few posted
// journals and one user per role. Safe to run again: it starts the demo tenant afresh.
import { loadConfig } from '../src/config';
import { createPasswordHasher, hashProfiles } from '../src/lib/password';
import { createPrismaClient } from '../src/lib/prisma';
import type { Actor } from '../src/middleware/authenticate';
import { createCompaniesService } from '../src/modules/companies/companies.service';
import { createJournalsService } from '../src/modules/journals/journals.service';
import { createPeriodsService } from '../src/modules/periods/periods.service';

if (process.env.NODE_ENV === 'production') {
  throw new Error('The demo seed must not run in production.');
}

// A demo database reachable from the internet should set DEMO_PASSWORD to one of its own.
const DEV_PASSWORD = process.env.DEMO_PASSWORD ?? 'DevPassw0rd!';
const TENANT = 'easyoffice';

const config = loadConfig();
const prisma = createPrismaClient(config.databaseUrl);
const hasher = createPasswordHasher(hashProfiles[config.passwordHashProfile]);

async function removeTenant(slug: string) {
  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant) return;
  const tenantId = tenant.id;
  await prisma.journalLine.deleteMany({ where: { entry: { tenantId } } });
  await prisma.journalEntry.updateMany({ where: { tenantId }, data: { reversesId: null } });
  await prisma.journalEntry.deleteMany({ where: { tenantId } });
  await prisma.period.deleteMany({ where: { tenantId } });
  await prisma.fiscalYear.deleteMany({ where: { tenantId } });
  await prisma.account.updateMany({ where: { tenantId }, data: { parentId: null } });
  await prisma.account.deleteMany({ where: { tenantId } });
  await prisma.branch.deleteMany({ where: { tenantId } });
  await prisma.brand.deleteMany({ where: { tenantId } });
  await prisma.company.deleteMany({ where: { tenantId } });
  await prisma.auditLog.deleteMany({ where: { tenantId } });
  await prisma.refreshToken.deleteMany({ where: { user: { tenantId } } });
  await prisma.user.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
}

const companies = [
  {
    name: { en: 'Mudawwarah', ar: 'المدورة' },
    legalName: 'Mudawwarah Restaurant Company W.L.L.',
    crNumber: 'DEMO-CR-0001',
    brand: { en: 'Mudawwarah', ar: 'المدورة' },
    branches: [
      { code: 'SALMIYA', en: 'Salmiya', ar: 'السالمية' },
      { code: 'HAWALLY', en: 'Hawally', ar: 'حولي' },
    ],
  },
  {
    name: { en: 'Khubuz Maraei', ar: 'خبز مرعي' },
    legalName: 'Khubuz Maraei Bakery Company W.L.L.',
    crNumber: 'DEMO-CR-0002',
    brand: { en: 'Khubuz Maraei', ar: 'خبز مرعي' },
    branches: [{ code: 'FARWANIYA', en: 'Farwaniya', ar: 'الفروانية' }],
  },
];

try {
  await removeTenant(TENANT);
  const tenant = await prisma.tenant.create({ data: { slug: TENANT, name: 'EasyOffice Group' } });
  const passwordHash = await hasher.hash(DEV_PASSWORD);
  const users = await Promise.all(
    (['owner', 'finance_manager', 'accountant', 'auditor'] as const).map((role) =>
      prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: `${role.replace('_', '.')}@easyoffice.test`,
          fullName: role.replace('_', ' ').replace(/^\w/, (c) => c.toUpperCase()),
          role,
          passwordHash,
        },
      }),
    ),
  );
  const owner = users[0]!;
  const actor: Actor = { userId: owner.id, tenantId: tenant.id, ip: null };

  const companiesService = createCompaniesService({ prisma });
  const periods = createPeriodsService({ prisma });
  const journals = createJournalsService({ prisma });

  for (const input of companies) {
    const company = await companiesService.create(actor, {
      name: input.name,
      legalName: input.legalName,
      crNumber: input.crNumber,
      baseCurrency: 'KWD',
      fiscalYearEndMonth: 12,
      useTemplate: true,
    });
    const brand = await companiesService.createBrand(actor, company.id, { name: input.brand });
    const branches = [];
    for (const branch of input.branches) {
      branches.push(
        await companiesService.createBranch(actor, company.id, {
          brandId: brand.id,
          code: branch.code,
          name: { en: branch.en, ar: branch.ar },
        }),
      );
    }
    await periods.createFiscalYear(actor, company.id, { startDate: '2026-01-01' });

    const accounts = await prisma.account.findMany({ where: { companyId: company.id } });
    const id = (code: string) => accounts.find((account) => account.code === code)!.id;
    const branchId = branches[0]!.id;
    const line = (code: string, debit: string, credit: string, branch: string | null = null) => ({
      accountId: id(code),
      branchId: branch,
      description: '',
      debit,
      credit,
    });

    const demo = [
      {
        date: '2026-01-01',
        description: 'Opening balances',
        reference: 'OB-2026',
        source: 'OPENING' as const,
        lines: [line('1130', '25000', '0'), line('1510', '15000', '0'), line('3100', '0', '40000')],
      },
      {
        date: '2026-01-31',
        description: 'January sales',
        reference: 'POS-2026-01',
        source: 'MANUAL' as const,
        lines: [
          line('1110', '3200', '0', branchId),
          line('1210', '5400', '0', branchId),
          line('1230', '2600', '0', branchId),
          line('4110', '0', '6100', branchId),
          line('4140', '0', '5100', branchId),
        ],
      },
      {
        date: '2026-01-31',
        description: 'January food cost and rent',
        reference: 'JV-2026-01',
        source: 'MANUAL' as const,
        lines: [
          line('5110', '3900', '0', branchId),
          line('6210', '1500', '0', branchId),
          line('6110', '2200', '0', branchId),
          line('1130', '0', '7600'),
        ],
      },
    ];
    for (const entry of demo) {
      const draft = await journals.createDraft(actor, company.id, entry);
      await journals.post(actor, company.id, draft.id);
    }
  }

  console.log(`Demo tenant "${TENANT}" ready. Sign in with any of:`);
  for (const user of users) console.log(`  ${user.email} (${user.role})`);
  console.log(`Password: ${DEV_PASSWORD}`);
} finally {
  await prisma.$disconnect();
}
