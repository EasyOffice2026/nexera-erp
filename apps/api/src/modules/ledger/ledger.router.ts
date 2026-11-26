import { journalInputSchema, listJournalsQuerySchema, reverseJournalSchema } from '@nexera/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../lib/prisma';
import { parseWith } from '../../lib/validate';
import { actorOf, requirePermission } from '../../middleware/authenticate';
import { createLedgerService } from './ledger.service';

export function createLedgerRouter(prisma: PrismaClient) {
  const router = Router();
  const service = createLedgerService(prisma);
  const ids = z.object({ companyId: z.uuid(), journalId: z.uuid() });
  const read = requirePermission('reports.view');
  const write = requirePermission('journals.write');
  const post = requirePermission('journals.post');

  router.get('/', read, async (req, res) => {
    res.json(await service.listCompanies(actorOf(req)));
  });
  router.get('/:companyId/setup', read, async (req, res) => {
    res.json(await service.setup(actorOf(req), parseWith(z.uuid(), req.params.companyId)));
  });
  router.get('/:companyId/journals', read, async (req, res) => {
    res.json(
      await service.list(
        actorOf(req),
        parseWith(z.uuid(), req.params.companyId),
        parseWith(listJournalsQuerySchema, req.query),
      ),
    );
  });
  router.get('/:companyId/journals/:journalId', read, async (req, res) => {
    const { companyId, journalId } = parseWith(ids, req.params);
    res.json(await service.get(actorOf(req), companyId, journalId));
  });
  router.post('/:companyId/journals', write, async (req, res) => {
    res
      .status(201)
      .json(
        await service.saveDraft(
          actorOf(req),
          parseWith(z.uuid(), req.params.companyId),
          parseWith(journalInputSchema, req.body),
        ),
      );
  });
  router.put('/:companyId/journals/:journalId', write, async (req, res) => {
    const { companyId, journalId } = parseWith(ids, req.params);
    res.json(
      await service.saveDraft(
        actorOf(req),
        companyId,
        parseWith(journalInputSchema, req.body),
        journalId,
      ),
    );
  });
  router.delete('/:companyId/journals/:journalId', write, async (req, res) => {
    const { companyId, journalId } = parseWith(ids, req.params);
    await service.deleteDraft(actorOf(req), companyId, journalId);
    res.status(204).end();
  });
  router.post('/:companyId/journals/:journalId/post', post, async (req, res) => {
    const { companyId, journalId } = parseWith(ids, req.params);
    res.json(await service.post(actorOf(req), companyId, journalId));
  });
  router.post('/:companyId/journals/:journalId/reverse', post, async (req, res) => {
    const { companyId, journalId } = parseWith(ids, req.params);
    res
      .status(201)
      .json(
        await service.reverse(
          actorOf(req),
          companyId,
          journalId,
          parseWith(reverseJournalSchema, req.body),
        ),
      );
  });
  router.get('/:companyId/periods/:periodId/trial-balance', read, async (req, res) => {
    const { companyId, periodId } = parseWith(
      z.object({ companyId: z.uuid(), periodId: z.uuid() }),
      req.params,
    );
    res.json(await service.trialBalance(actorOf(req), companyId, periodId));
  });
  return router;
}
