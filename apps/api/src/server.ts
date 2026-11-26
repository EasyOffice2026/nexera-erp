import { createApp } from './app';
import { loadConfig } from './config';
import { createPrismaClient } from './lib/prisma';

const config = loadConfig();
const prisma = createPrismaClient(config.databaseUrl);
const server = createApp(config, prisma).listen(config.port, () => {
  console.info(`Nexera API listening on port ${config.port}`);
});

function shutdown() {
  server.close((error) => {
    if (error) process.exitCode = 1;
    void prisma.$disconnect().catch((disconnectError: unknown) => {
      console.error(disconnectError);
      process.exitCode = 1;
    });
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
