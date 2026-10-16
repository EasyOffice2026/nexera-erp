import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type RequestHandler } from 'express';
import type { Config } from './config';
import { createPasswordHasher, hashProfiles, type PasswordHasher } from './lib/password';
import type { PrismaClient } from './lib/prisma';
import { createTokenService } from './lib/tokens';
import { authenticate } from './middleware/authenticate';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { type LogLine, requestLog, writeJsonLine } from './middleware/request-log';
import { securityHeaders } from './middleware/security-headers';
import { createAccountsRouter } from './modules/accounts/accounts.router';
import { createAccountsService } from './modules/accounts/accounts.service';
import { createAuthRouter } from './modules/auth/auth.router';
import { createAuthService } from './modules/auth/auth.service';
import { createCompaniesRouter } from './modules/companies/companies.router';
import { createCompaniesService } from './modules/companies/companies.service';
import { createHealthRouter } from './modules/health/health.router';
import { createJournalsRouter } from './modules/journals/journals.router';
import { createJournalsService } from './modules/journals/journals.service';
import { createPeriodsRouter } from './modules/periods/periods.router';
import { createPeriodsService } from './modules/periods/periods.service';
import { createDashboardRouter } from './modules/dashboard/dashboard.router';
import { createDashboardService } from './modules/dashboard/dashboard.service';
import {
  createAdvancedReportsRouter,
  createGroupReportsRouter,
} from './modules/reports/advanced-reports.router';
import { createAdvancedReportsService } from './modules/reports/advanced-reports.service';
import { createReportsRouter } from './modules/reports/reports.router';
import { createReportsService } from './modules/reports/reports.service';
import { createUsersRouter } from './modules/users/users.router';
import { createUsersService } from './modules/users/users.service';

export interface AppDeps {
  prisma: PrismaClient;
  config: Config;
  // Tests pass their own hasher to watch how it is used.
  hasher?: PasswordHasher;
  // Tests pass their own clock.
  now?: () => Date;
  // Where the line of each request goes: standard output, or nowhere while testing.
  log?: (line: LogLine) => void;
}

// The built web app: files under /assets are kept for a year (their names change with each
// build); every other path that is not a file gets index.html, so the app's own routes work.
function serveWeb(dist: string, https: boolean): RequestHandler[] {
  const index = path.join(dist, 'index.html');
  const headers: RequestHandler = (_req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      ...(https ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
    });
    next();
  };
  const files = express.static(dist, {
    index: false,
    setHeaders: (res, file) => {
      res.set(
        'Cache-Control',
        file.includes(`${path.sep}assets${path.sep}`)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      );
    },
  });
  const fallback: RequestHandler = (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    res.set('Cache-Control', 'no-cache').sendFile(index);
  };
  return [headers, files, fallback];
}

export function createApp({ prisma, config, hasher, now, log }: AppDeps) {
  const app = express();
  const https = config.refreshToken.cookieSecure;
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use('/api', securityHeaders({ https }));
  app.use(requestLog(log ?? (config.nodeEnv === 'test' ? () => {} : writeJsonLine)));
  // A journal may have up to 500 lines.
  app.use(express.json({ limit: '1mb' }));

  const tokens = createTokenService(config);
  const passwordHasher = hasher ?? createPasswordHasher(hashProfiles[config.passwordHashProfile]);
  const auth = authenticate(tokens);

  const v1 = express.Router();
  v1.use('/health', createHealthRouter(prisma));
  v1.use(
    '/auth',
    createAuthRouter({
      service: createAuthService({ prisma, hasher: passwordHasher, tokens, config }),
      authenticate: auth,
      config,
    }),
  );
  v1.use('/users', auth, createUsersRouter(createUsersService({ prisma, hasher: passwordHasher })));
  v1.use('/companies', auth, createCompaniesRouter(createCompaniesService({ prisma })));
  v1.use(
    '/companies/:companyId/accounts',
    auth,
    createAccountsRouter(createAccountsService({ prisma })),
  );
  v1.use('/companies/:companyId', auth, createPeriodsRouter(createPeriodsService({ prisma })));
  v1.use(
    '/companies/:companyId/journals',
    auth,
    createJournalsRouter(createJournalsService({ prisma, ...(now ? { now } : {}) })),
  );
  v1.use(
    '/companies/:companyId/reports',
    auth,
    createReportsRouter(createReportsService({ prisma })),
  );
  const advancedReports = createAdvancedReportsService({ prisma });
  v1.use('/companies/:companyId/reports', auth, createAdvancedReportsRouter(advancedReports));
  v1.use('/reports', auth, createGroupReportsRouter(advancedReports));
  v1.use(
    '/companies/:companyId/dashboard',
    auth,
    createDashboardRouter(createDashboardService({ prisma })),
  );
  app.use('/api/v1', v1);
  app.use('/api', notFoundHandler);

  if (config.webDist) {
    if (!existsSync(path.join(config.webDist, 'index.html'))) {
      throw new Error(`WEB_DIST (${config.webDist}) has no index.html. Build the web app first.`);
    }
    app.use(...serveWeb(path.resolve(config.webDist), https));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
