import express from 'express';
import { resolve } from 'node:path';
import type { Config } from './config';
import { createPasswordHasher, hashProfiles } from './lib/password';
import type { PrismaClient } from './lib/prisma';
import { createTokenService } from './lib/tokens';
import { authenticate } from './middleware/authenticate';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { requestLog, writeJsonLine } from './middleware/request-log';
import { securityHeaders } from './middleware/security-headers';
import { createAuthRouter } from './modules/auth/auth.router';
import { createAuthService } from './modules/auth/auth.service';
import { createHealthRouter } from './modules/health/health.router';
import { createLedgerRouter } from './modules/ledger/ledger.router';
import { createUsersRouter } from './modules/users/users.router';
import { createUsersService } from './modules/users/users.service';

export function createApp(config: Config, prisma: PrismaClient) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  const api = express.Router();
  const hasher = createPasswordHasher(hashProfiles[config.passwordHashProfile]);
  const tokens = createTokenService(config);
  const authenticated = authenticate(tokens, prisma);
  api.use(securityHeaders({ https: config.nodeEnv === 'production' }));
  api.use(requestLog(config.nodeEnv === 'test' ? () => undefined : writeJsonLine));
  api.use(express.json({ limit: '256kb' }));
  api.use('/health', createHealthRouter(prisma));
  api.use(
    '/auth',
    createAuthRouter({
      service: createAuthService({ prisma, hasher, tokens, config }),
      authenticate: authenticated,
      config,
    }),
  );
  api.use('/users', authenticated, createUsersRouter(createUsersService({ prisma, hasher })));
  api.use('/companies', authenticated, createLedgerRouter(prisma));
  app.use('/api/v1', api);
  app.use('/api', notFoundHandler);
  if (config.webDist) {
    const directory = resolve(config.webDist);
    app.use(express.static(directory));
    app.get('/', (_req, res) => res.sendFile(resolve(directory, 'index.html')));
  }
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
