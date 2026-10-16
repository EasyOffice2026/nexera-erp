import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { baseDatabaseUrl, TEST_SCHEMA, testDatabaseUrl } from './test-database';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

// Runs once before all test files: start from an empty schema and apply the real migrations.
export default async function setup(project: TestProject): Promise<void> {
  const admin = baseDatabaseUrl();
  const client = new pg.Client({ connectionString: admin.toString() });

  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Cannot reach PostgreSQL at ${admin.host}. Start it with "npm run infra:up" or set DATABASE_URL.`,
      { cause: error },
    );
  }

  try {
    await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  } finally {
    await client.end();
  }

  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed:\n${result.stdout}\n${result.stderr}`);
  }

  project.provide('databaseUrl', testDatabaseUrl());
}
