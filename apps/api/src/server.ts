import { createApp } from './app';
import { loadConfig } from './config';
import { createPrismaClient } from './lib/prisma';

const config = loadConfig();
const prisma = createPrismaClient(config.databaseUrl);

const server = createApp({ prisma, config }).listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
  });
}
