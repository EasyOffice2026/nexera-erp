import { Router } from 'express';
import { z } from 'zod';
import { parseWith } from '../../lib/validate';
import { actorOf, requirePermission } from '../../middleware/authenticate';
import {
  accountsInputSchema,
  branchLinksInputSchema,
  connectionInputSchema,
  documentsQuerySchema,
  type PosService,
  syncInputSchema,
} from './pos.service';

const idSchema = z.string().uuid();

// Mounted under /pos. Setting up the link and syncing need integrations.manage; reading what was
// posted needs reports.view; opening the POS needs only a signed-in person.
export function createPosRouter(service: PosService): Router {
  const router = Router();
  const manage = requirePermission('integrations.manage');
  const read = requirePermission('reports.view');

  router.get('/connection', read, async (req, res) => {
    res.json({ connection: await service.connection(actorOf(req)) });
  });
  router.put('/connection', manage, async (req, res) => {
    const input = parseWith(connectionInputSchema, req.body);
    res.json({ connection: await service.saveConnection(actorOf(req), input) });
  });
  router.get('/structure', manage, async (req, res) => {
    res.json(await service.structure(actorOf(req)));
  });
  router.put('/branch-links', manage, async (req, res) => {
    const input = parseWith(branchLinksInputSchema, req.body);
    res.json(await service.saveBranchLinks(actorOf(req), input));
  });
  router.get('/companies/:companyId/accounts', read, async (req, res) => {
    const companyId = parseWith(idSchema, req.params.companyId);
    res.json(await service.accounts(actorOf(req), companyId));
  });
  router.put('/companies/:companyId/accounts', manage, async (req, res) => {
    const companyId = parseWith(idSchema, req.params.companyId);
    const input = parseWith(accountsInputSchema, req.body);
    res.json(await service.saveAccounts(actorOf(req), companyId, input));
  });
  router.post('/sync', manage, async (req, res) => {
    const input = parseWith(syncInputSchema, req.body);
    res.json(await service.sync(actorOf(req), input));
  });
  router.get('/documents', read, async (req, res) => {
    const query = parseWith(documentsQuerySchema, req.query);
    res.json(await service.documents(actorOf(req), query));
  });
  router.post('/sso', async (req, res) => {
    res.json(await service.ssoUrl(actorOf(req)));
  });
  return router;
}
