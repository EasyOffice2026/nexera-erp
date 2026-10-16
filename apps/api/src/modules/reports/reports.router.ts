import { balanceSheetQuerySchema, reportQuerySchema } from '@nexera/shared';
import { Router } from 'express';
import { z } from 'zod';
import { parseWith } from '../../lib/validate';
import { actorOf, requirePermission } from '../../middleware/authenticate';
import type { ReportsService } from './reports.service';

const idSchema = z.string().uuid();

// Mounted under /companies/:companyId/reports.
export function createReportsRouter(service: ReportsService): Router {
  const router = Router({ mergeParams: true });
  router.use(requirePermission('reports.view'));
  const companyOf = (params: Record<string, unknown>) => parseWith(idSchema, params.companyId);

  router.get('/trial-balance', async (req, res) => {
    const query = parseWith(reportQuerySchema, req.query);
    res.json(await service.trialBalance(actorOf(req), companyOf(req.params), query));
  });

  router.get('/ledger/:accountId', async (req, res) => {
    const accountId = parseWith(idSchema, req.params.accountId);
    const query = parseWith(reportQuerySchema, req.query);
    res.json(await service.ledger(actorOf(req), companyOf(req.params), accountId, query));
  });

  router.get('/income-statement', async (req, res) => {
    const query = parseWith(reportQuerySchema, req.query);
    res.json(await service.incomeStatement(actorOf(req), companyOf(req.params), query));
  });

  router.get('/balance-sheet', async (req, res) => {
    const query = parseWith(balanceSheetQuerySchema, req.query);
    res.json(await service.balanceSheet(actorOf(req), companyOf(req.params), query));
  });

  return router;
}
