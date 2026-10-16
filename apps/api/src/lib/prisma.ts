import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

export { PrismaClient };

export interface PoolOptions {
  connectionString: string;
  schema: string | undefined;
  // The most connections the API opens at once; the driver's default (10) when not given.
  max: number | undefined;
}

// Reads the settings of the address that are ours, not the database's:
// - "schema" (…/pos?schema=pos_test) selects a non-default Postgres schema;
// - "connection_limit" (…?connection_limit=5) caps the connections, as hosted databases such as
//   Supabase's pooler allow only so many per project.
export function poolOptions(databaseUrl: string): PoolOptions {
  const url = new URL(databaseUrl);
  const schema = url.searchParams.get('schema') ?? undefined;
  const limit = url.searchParams.get('connection_limit');
  url.searchParams.delete('schema');
  url.searchParams.delete('connection_limit');
  const max = limit === null ? undefined : Number(limit);
  if (max !== undefined && (!Number.isInteger(max) || max < 1)) {
    throw new Error('connection_limit in DATABASE_URL must be a whole number of at least 1.');
  }
  return { connectionString: url.toString(), schema, max };
}

export function createPrismaClient(databaseUrl: string): PrismaClient {
  const { connectionString, schema, max } = poolOptions(databaseUrl);
  const adapter = new PrismaPg(
    { connectionString, connectionTimeoutMillis: 10_000, ...(max ? { max } : {}) },
    schema ? { schema } : undefined,
  );
  // At a busy moment every connection may be taken. A payment then waits up to 10 seconds for one
  // instead of failing after 2 (the default), and may take 15 seconds instead of 5. Found by the
  // load test (docs/load-test.md).
  return new PrismaClient({ adapter, transactionOptions: { maxWait: 10_000, timeout: 15_000 } });
}
