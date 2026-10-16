// Creates a subscribing customer (tenant) and its first owner, for a new installation or a new
// customer in production:
//   npm run tenant:create -- --slug acme --name "Acme Group" --email owner@acme.com --full-name "Owner"
// The password comes from OWNER_PASSWORD, or a random one is made and printed once.
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from '../src/config';
import { createPasswordHasher, hashProfiles } from '../src/lib/password';
import { createPrismaClient } from '../src/lib/prisma';

const { values } = parseArgs({
  options: {
    slug: { type: 'string' },
    name: { type: 'string' },
    email: { type: 'string' },
    'full-name': { type: 'string' },
  },
});

const input = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,59}$/, 'Use 2-60 lower-case letters, digits or -'),
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().toLowerCase().email(),
    fullName: z.string().trim().min(1).max(200),
    password: z.string().min(10, 'OWNER_PASSWORD must have at least 10 characters'),
  })
  .safeParse({
    slug: values.slug,
    name: values.name,
    email: values.email,
    fullName: values['full-name'],
    password: process.env.OWNER_PASSWORD ?? randomBytes(12).toString('base64url'),
  });

if (!input.success) {
  for (const issue of input.error.issues)
    console.error(`${issue.path.join('.')}: ${issue.message}`);
  console.error(
    'Usage: npm run tenant:create -- --slug <slug> --name <name> --email <email> --full-name <name>',
  );
  process.exit(1);
}

const config = loadConfig();
const prisma = createPrismaClient(config.databaseUrl);
const hasher = createPasswordHasher(hashProfiles[config.passwordHashProfile]);

try {
  const { slug, name, email, fullName, password } = input.data;
  if (await prisma.tenant.findUnique({ where: { slug } })) {
    console.error(`A tenant with the slug "${slug}" already exists.`);
    process.exitCode = 1;
  } else {
    await prisma.tenant.create({
      data: {
        slug,
        name,
        users: {
          create: { email, fullName, role: 'owner', passwordHash: await hasher.hash(password) },
        },
      },
    });
    console.log(`Tenant "${slug}" created with owner ${email}.`);
    if (!process.env.OWNER_PASSWORD) console.log(`Password (shown once): ${password}`);
  }
} finally {
  await prisma.$disconnect();
}
