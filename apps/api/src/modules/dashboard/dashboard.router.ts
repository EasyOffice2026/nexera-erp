import { dashboardQuerySchema } from '@nexera/shared';
import { Router } from 'express';
import { z } from 'zod';
import { parseWith } from '../../lib/validate';
import { actorOf, requirePermission } from '../../middleware/authenticate';
import type { DashboardService } from './dashboard.service';

const idSchema = z.string().uuid();

// Mounted under /companies/:companyId/dashboard.
export function createDashboardRouter(service: DashboardService): Router {
  const router = Router({ mergeParams: true });
  router.use(requirePermission('reports.view'));

  router.get('/', async (req, res) => {
    const companyId = parseWith(idSchema, (req.params as Record<string, unknown>).companyId);
    const query = parseWith(dashboardQuerySchema, req.query);
    res.json(await service.get(actorOf(req), companyId, query));
  });

  return router;
}
