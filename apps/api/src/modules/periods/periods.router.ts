import { createFiscalYearSchema, setPeriodStatusSchema } from '@nexera/shared';
import { Router } from 'express';
import { z } from 'zod';
import { parseWith } from '../../lib/validate';
import { actorOf, requirePermission } from '../../middleware/authenticate';
import type { PeriodsService } from './periods.service';

const idSchema = z.string().uuid();

// Mounted under /companies/:companyId.
export function createPeriodsRouter(service: PeriodsService): Router {
  const router = Router({ mergeParams: true });
  const manage = requirePermission('periods.manage');
  const companyOf = (params: Record<string, unknown>) => parseWith(idSchema, params.companyId);

  router.get('/fiscal-years', requirePermission('reports.view'), async (req, res) => {
    res.json(await service.listFiscalYears(actorOf(req), companyOf(req.params)));
  });

  router.post('/fiscal-years', manage, async (req, res) => {
    const input = parseWith(createFiscalYearSchema, req.body);
    res
      .status(201)
      .json(await service.createFiscalYear(actorOf(req), companyOf(req.params), input));
  });

  router.patch('/periods/:id', manage, async (req, res) => {
    const id = parseWith(idSchema, req.params.id);
    const { status } = parseWith(setPeriodStatusSchema, req.body);
    res.json(await service.setPeriodStatus(actorOf(req), companyOf(req.params), id, status));
  });

  return router;
}
