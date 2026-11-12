import { createApp } from './app';
import { loadConfig } from './config';
import { createPrismaClient } from './lib/prisma';
import type { PosService } from './modules/pos/pos.service';

const config = loadConfig();
const prisma = createPrismaClient(config.databaseUrl);

const app = createApp({ prisma, config });
const posService = app.locals.posService as PosService;
// Every connected POS is read again on a timer (docs/unified-platform.md); off when 0.
const posTimer =
  config.pos.syncIntervalMinutes > 0
    ? setInterval(() => void posService.syncAll(), config.pos.syncIntervalMinutes * 60_000)
    : undefined;
const server = app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(posTimer);
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
  });
}
