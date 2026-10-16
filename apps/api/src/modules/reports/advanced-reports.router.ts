import {
  cashFlowQuerySchema,
  comparativeQuerySchema,
  groupReportQuerySchema,
  journalRegisterQuerySchema,
} from '@nexera/shared';
import { Router } from 'express';
import { z } from 'zod';
import { parseWith } from '../../lib/validate';
import { actorOf, requirePermission } from '../../middleware/authenticate';
import type { AdvancedReportsService } from './advanced-reports.service';

const idSchema = z.string().uuid();

// Mounted under /companies/:companyId/reports, next to the basic statements.
export function createAdvancedReportsRouter(service: AdvancedReportsService): Router {
  const router = Router({ mergeParams: true });
  router.use(requirePermission('reports.view'));
  const companyOf = (params: Record<string, unknown>) => parseWith(idSchema, params.companyId);

  router.get('/income-statement/columns', async (req, res) => {
    const query = parseWith(comparativeQuerySchema, req.query);
    res.json(await service.comparativeIncomeStatement(actorOf(req), companyOf(req.params), query));
  });

  router.get('/cash-flow', async (req, res) => {
    const query = parseWith(cashFlowQuerySchema, req.query);
    res.json(await service.cashFlow(actorOf(req), companyOf(req.params), query));
  });

  router.get('/journal-register', async (req, res) => {
    const query = parseWith(journalRegisterQuerySchema, req.query);
    res.json(await service.journalRegister(actorOf(req), companyOf(req.params), query));
  });

  return router;
}

// Mounted under /reports: reports across every company of the tenant.
export function createGroupReportsRouter(service: AdvancedReportsService): Router {
  const router = Router();
  router.use(requirePermission('reports.view'));

  router.get('/group/income-statement', async (req, res) => {
    const query = parseWith(groupReportQuerySchema, req.query);
    res.json(await service.groupIncomeStatement(actorOf(req), query));
  });

  return router;
}
