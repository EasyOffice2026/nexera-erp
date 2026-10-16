import { createAccountSchema, updateAccountSchema } from '@nexera/shared';
import { Router } from 'express';
import { z } from 'zod';
import { parseWith } from '../../lib/validate';
import { actorOf, requirePermission } from '../../middleware/authenticate';
import type { AccountsService } from './accounts.service';

const idSchema = z.string().uuid();

// Mounted under /companies/:companyId/accounts.
export function createAccountsRouter(service: AccountsService): Router {
  const router = Router({ mergeParams: true });
  const manage = requirePermission('accounts.manage');
  const companyOf = (params: Record<string, unknown>) => parseWith(idSchema, params.companyId);

  router.get('/', requirePermission('reports.view'), async (req, res) => {
    res.json(await service.list(actorOf(req), companyOf(req.params)));
  });

  router.post('/', manage, async (req, res) => {
    const input = parseWith(createAccountSchema, req.body);
    res.status(201).json(await service.create(actorOf(req), companyOf(req.params), input));
  });

  router.patch('/:id', manage, async (req, res) => {
    const id = parseWith(idSchema, req.params.id);
    const input = parseWith(updateAccountSchema, req.body);
    res.json(await service.update(actorOf(req), companyOf(req.params), id, input));
  });

  router.delete('/:id', manage, async (req, res) => {
    const id = parseWith(idSchema, req.params.id);
    await service.remove(actorOf(req), companyOf(req.params), id);
    res.status(204).end();
  });

  return router;
}
