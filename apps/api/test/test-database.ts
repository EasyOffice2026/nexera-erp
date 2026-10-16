// Tests run in their own Postgres schema, so they never touch the data of a developer's
// main schema. The database server itself is the one in DATABASE_URL.
export const TEST_SCHEMA = 'nexera_test';

const DEFAULT_DATABASE_URL = 'postgresql://nexera:nexera@localhost:5432/nexera';

export function baseDatabaseUrl(): URL {
  const url = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  url.searchParams.delete('schema');
  return url;
}

export function testDatabaseUrl(): string {
  const url = baseDatabaseUrl();
  url.searchParams.set('schema', TEST_SCHEMA);
  return url.toString();
}
