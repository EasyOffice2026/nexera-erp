import { journalInputSchema, listJournalsQuerySchema, reverseJournalSchema } from '@nexera/shared';
import { Router } from 'express';
import { z } from 'zod';
import { parseWith } from '../../lib/validate';
import { actorOf, requirePermission } from '../../middleware/authenticate';
import type { JournalsService } from './journals.service';

const idSchema = z.string().uuid();

// Mounted under /companies/:companyId/journals.
export function createJournalsRouter(service: JournalsService): Router {
  const router = Router({ mergeParams: true });
  const write = requirePermission('journals.write');
  const post = requirePermission('journals.post');
  const companyOf = (params: Record<string, unknown>) => parseWith(idSchema, params.companyId);

  router.get('/', requirePermission('reports.view'), async (req, res) => {
    const query = parseWith(listJournalsQuerySchema, req.query);
    res.json(await service.list(actorOf(req), companyOf(req.params), query));
  });

  router.post('/', write, async (req, res) => {
    const input = parseWith(journalInputSchema, req.body);
    res.status(201).json(await service.createDraft(actorOf(req), companyOf(req.params), input));
  });

  router.get('/:id', requirePermission('reports.view'), async (req, res) => {
    const id = parseWith(idSchema, req.params.id);
    res.json(await service.get(actorOf(req), companyOf(req.params), id));
  });

  router.put('/:id', write, async (req, res) => {
    const id = parseWith(idSchema, req.params.id);
    const input = parseWith(journalInputSchema, req.body);
    res.json(await service.updateDraft(actorOf(req), companyOf(req.params), id, input));
  });

  router.delete('/:id', write, async (req, res) => {
    const id = parseWith(idSchema, req.params.id);
    await service.deleteDraft(actorOf(req), companyOf(req.params), id);
    res.status(204).end();
  });

  router.post('/:id/post', post, async (req, res) => {
    const id = parseWith(idSchema, req.params.id);
    res.json(await service.post(actorOf(req), companyOf(req.params), id));
  });

  router.post('/:id/reverse', post, async (req, res) => {
    const id = parseWith(idSchema, req.params.id);
    const input = parseWith(reverseJournalSchema, req.body);
    res.status(201).json(await service.reverse(actorOf(req), companyOf(req.params), id, input));
  });

  return router;
}
