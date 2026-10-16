import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma does not read .env by itself. Load the repository's .env when there is one.
const envFile = new URL('../../.env', import.meta.url);
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Same default as src/config.ts: the credentials of docker-compose.yml.
    url: process.env.DATABASE_URL ?? 'postgresql://nexera:nexera@localhost:5432/nexera',
  },
});
