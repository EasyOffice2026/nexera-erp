import { createUserSchema, type AccountSubtype, type AccountType } from '@nexera/shared';
import { z } from 'zod';
import { loadConfig } from '../src/config';
import { addDays, addMonths, parseDate } from '../src/lib/dates';
import { createPasswordHasher, hashProfiles } from '../src/lib/password';
import { createPrismaClient } from '../src/lib/prisma';

const chart = [
  ['1000', 'Cash and cash equivalents', 'النقد وما في حكمه', 'ASSET', 'cash'],
  ['1100', 'Trade receivables', 'الذمم المدينة التجارية', 'ASSET', 'receivable'],
  ['1200', 'Inventory', 'المخزون', 'ASSET', 'inventory'],
  ['2000', 'Trade payables', 'الذمم الدائنة التجارية', 'LIABILITY', 'payable'],
  ['3000', 'Share capital', 'رأس المال', 'EQUITY', 'share_capital'],
  ['4000', 'Restaurant sales', 'مبيعات المطعم', 'REVENUE', 'sales'],
  ['5000', 'Operating expenses', 'المصروفات التشغيلية', 'EXPENSE', 'operating_expense'],
] as const satisfies readonly (readonly [string, string, string, AccountType, AccountSubtype])[];

const setupSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{0,59}$/),
  tenant: z.string().trim().min(1).max(200),
  owner: createUserSchema,
  companies: z
    .array(
      z.object({
        en: z.string().trim().min(1).max(200),
        ar: z.string().trim().min(1).max(200),
        cr: z.string().trim().min(1).max(40),
      }),
    )
    .min(1),
  year: z.coerce.number().int().min(2000).max(9998),
});

async function provision(input: unknown) {
  const setup = setupSchema.parse(input);
  const config = loadConfig();
  const passwordHash = await createPasswordHasher(hashProfiles[config.passwordHashProfile]).hash(
    setup.owner.password,
  );
  const db = createPrismaClient(config.databaseUrl);
  try {
    return await db.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({ data: { slug: setup.slug, name: setup.tenant } });
      const tenantId = tenant.id;
      const { email, fullName, language } = setup.owner;
      await tx.user.create({
        data: { tenantId, email, fullName, language, role: 'owner', passwordHash },
      });
      for (const { en, ar, cr } of setup.companies) {
        const { id: companyId } = await tx.company.create({
          data: { tenantId, name: { en, ar }, legalName: en, crNumber: cr },
        });
        await tx.account.createMany({
          data: chart.map(([code, en, ar, type, subtype]) => ({
            tenantId,
            companyId,
            code,
            name: { en, ar },
            type,
            subtype,
          })),
        });
        const start = parseDate(`${setup.year}-01-01`);
        const fiscalYear = await tx.fiscalYear.create({
          data: {
            tenantId,
            companyId,
            name: String(setup.year),
            startDate: start,
            endDate: addDays(addMonths(start, 12), -1),
          },
        });
        await tx.period.createMany({
          data: Array.from({ length: 12 }, (_, index) => ({
            tenantId,
            companyId,
            fiscalYearId: fiscalYear.id,
            number: index + 1,
            startDate: addMonths(start, index),
            endDate: addDays(addMonths(start, index + 1), -1),
          })),
        });
      }
      return tenant.slug;
    });
  } finally {
    await db.$disconnect();
  }
}

export async function runProvision(input: unknown) {
  try {
    console.info(`Created tenant ${await provision(input)}`);
  } catch (error) {
    // Validation errors can refer to credential fields. Keep the original input out of the log.
    if (error instanceof z.ZodError) {
      console.error(
        error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n'),
      );
    } else if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
      console.error('The tenant already exists. Existing records were preserved.');
    } else {
      console.error('Could not create the tenant. Check the database connection and migrations.');
    }
    process.exitCode = 1;
  }
}
