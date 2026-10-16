import type { Role } from '@nexera/shared';
import type supertest from 'supertest';
import { inject } from 'vitest';
import { createApp } from '../src/app';
import { type Config, loadConfig } from '../src/config';
import { createPasswordHasher, hashProfiles } from '../src/lib/password';
import { createPrismaClient, type PrismaClient } from '../src/lib/prisma';

export const TEST_PASSWORD = 'Password123!';

export function createTestPrisma(): PrismaClient {
  return createPrismaClient(inject('databaseUrl'));
}

// Fast hashing and a fixed secret. Never use these values outside tests.
export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    PASSWORD_HASH_PROFILE: 'fast',
    JWT_ACCESS_SECRET: 'test-only-access-token-secret-0123456789abcdef',
    DATABASE_URL: inject('databaseUrl'),
    AUTH_RATE_LIMIT_MAX: '1000',
    ...overrides,
  });
}

export const testHasher = createPasswordHasher(hashProfiles.fast);

// Empties every table, children before parents.
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.journalLine.deleteMany();
  await prisma.journalEntry.updateMany({ data: { reversesId: null } });
  await prisma.journalEntry.deleteMany();
  await prisma.period.deleteMany();
  await prisma.fiscalYear.deleteMany();
  await prisma.account.updateMany({ data: { parentId: null } });
  await prisma.account.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.brand.deleteMany();
  await prisma.company.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();
}

export function createTestApp(prisma: PrismaClient) {
  return createApp({ prisma, config: testConfig(), hasher: testHasher, log: () => {} });
}

export type TestAgent = ReturnType<typeof supertest>;

export async function createTenant(prisma: PrismaClient, slug = 'acme') {
  return prisma.tenant.create({ data: { slug, name: `${slug} group` } });
}

export async function createUser(
  prisma: PrismaClient,
  tenantId: string,
  role: Role,
  email = `${role}@example.com`,
) {
  return prisma.user.create({
    data: {
      tenantId,
      email,
      fullName: role,
      role,
      passwordHash: await testHasher.hash(TEST_PASSWORD),
    },
  });
}

// Signs in and answers a function that adds the bearer token to a request.
export async function signIn(api: TestAgent, tenant: string, email: string) {
  const res = await api.post('/api/v1/auth/login').send({ tenant, email, password: TEST_PASSWORD });
  if (res.status !== 200)
    throw new Error(`Sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
  const token = (res.body as { accessToken: string }).accessToken;
  return { authorization: `Bearer ${token}` };
}

// A tenant with an owner, one company with the template chart, a brand, a branch and FY2026.
export async function createWorld(prisma: PrismaClient, api: TestAgent, slug = 'acme') {
  const tenant = await createTenant(prisma, slug);
  const owner = await createUser(prisma, tenant.id, 'owner', `owner@${slug}.com`);
  const auth = await signIn(api, slug, owner.email);

  const company = (
    await api
      .post('/api/v1/companies')
      .set(auth)
      .send({
        name: { en: 'Test Co', ar: 'شركة' },
        legalName: 'Test Co WLL',
        crNumber: `CR-${slug}`,
      })
  ).body as { id: string };
  const brand = (
    await api
      .post(`/api/v1/companies/${company.id}/brands`)
      .set(auth)
      .send({ name: { en: 'Brand', ar: 'علامة' } })
  ).body as { id: string };
  const branch = (
    await api
      .post(`/api/v1/companies/${company.id}/branches`)
      .set(auth)
      .send({ brandId: brand.id, code: 'B1', name: { en: 'Branch 1', ar: 'فرع 1' } })
  ).body as { id: string };
  const year = (
    await api
      .post(`/api/v1/companies/${company.id}/fiscal-years`)
      .set(auth)
      .send({ startDate: '2026-01-01' })
  ).body as { id: string; periods: { id: string; number: number }[] };

  const accounts = await prisma.account.findMany({ where: { companyId: company.id } });
  const account = (code: string) => {
    const found = accounts.find((row) => row.code === code);
    if (!found) throw new Error(`No account ${code}`);
    return found.id;
  };

  return { tenant, owner, auth, company, brand, branch, year, account };
}
