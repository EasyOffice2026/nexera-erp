import { xbrlQuerySchema } from '@nexera/shared';
import { Router } from 'express';
import { z } from 'zod';
import { parseWith } from '../../lib/validate';
import { actorOf, requirePermission } from '../../middleware/authenticate';
import type { XbrlService } from './xbrl.service';

const idSchema = z.string().uuid();

// Mounted under /companies/:companyId/xbrl: one company's XBRL filing.
export function createXbrlRouter(service: XbrlService): Router {
  const router = Router({ mergeParams: true });
  router.use(requirePermission('reports.view'));
  const companyOf = (params: Record<string, unknown>) => parseWith(idSchema, params.companyId);

  router.get('/preview', async (req, res) => {
    const query = parseWith(xbrlQuerySchema, req.query);
    res.json(await service.preview(actorOf(req), companyOf(req.params), query));
  });

  router.get('/instance', async (req, res) => {
    const query = parseWith(xbrlQuerySchema, req.query);
    const { xml, fileName } = await service.instance(actorOf(req), companyOf(req.params), query);
    res.attachment(fileName).type('application/xml').send(xml);
  });

  return router;
}
