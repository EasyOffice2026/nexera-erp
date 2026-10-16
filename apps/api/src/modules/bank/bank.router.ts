import {
  bankAccountInputSchema,
  bankLineJournalSchema,
  bankRuleInputSchema,
  importStatementSchema,
  listBankLinesQuerySchema,
  lockReconciliationSchema,
  matchBankLineSchema,
  reconciliationQuerySchema,
} from '@nexera/shared';
import { Router } from 'express';
import { z } from 'zod';
import { parseWith } from '../../lib/validate';
import { actorOf, requirePermission } from '../../middleware/authenticate';
import type { BankService } from './bank.service';

const idSchema = z.string().uuid();

// Mounted under /companies/:companyId/bank. Reading needs reports.view; importing, matching and
// rules need journals.post; linking bank accounts and locking a reconciliation need periods.manage.
export function createBankRouter(service: BankService): Router {
  const router = Router({ mergeParams: true });
  const read = requirePermission('reports.view');
  const work = requirePermission('journals.post');
  const manage = requirePermission('periods.manage');
  const company = (params: Record<string, unknown>) => parseWith(idSchema, params.companyId);
  const id = (value: unknown) => parseWith(idSchema, value);

  router.get('/accounts', read, async (req, res) => {
    res.json(await service.listAccounts(actorOf(req), company(req.params)));
  });
  router.post('/accounts', manage, async (req, res) => {
    const input = parseWith(bankAccountInputSchema, req.body);
    res.status(201).json(await service.createAccount(actorOf(req), company(req.params), input));
  });
  router.put('/accounts/:bankId', manage, async (req, res) => {
    const input = parseWith(bankAccountInputSchema, req.body);
    res.json(
      await service.updateAccount(actorOf(req), company(req.params), id(req.params.bankId), input),
    );
  });
  router.post('/accounts/:bankId/statements', work, async (req, res) => {
    const input = parseWith(importStatementSchema, req.body);
    res
      .status(201)
      .json(
        await service.importStatement(
          actorOf(req),
          company(req.params),
          id(req.params.bankId),
          input,
        ),
      );
  });
  router.get('/accounts/:bankId/lines', read, async (req, res) => {
    const query = parseWith(listBankLinesQuerySchema, req.query);
    res.json(
      await service.listLines(actorOf(req), company(req.params), id(req.params.bankId), query),
    );
  });
  router.get('/accounts/:bankId/lines/:lineId/candidates', read, async (req, res) => {
    res.json(
      await service.candidates(
        actorOf(req),
        company(req.params),
        id(req.params.bankId),
        id(req.params.lineId),
      ),
    );
  });
  router.post('/accounts/:bankId/lines/:lineId/match', work, async (req, res) => {
    const input = parseWith(matchBankLineSchema, req.body);
    res.json(
      await service.match(
        actorOf(req),
        company(req.params),
        id(req.params.bankId),
        id(req.params.lineId),
        input.journalLineId,
      ),
    );
  });
  router.post('/accounts/:bankId/lines/:lineId/unmatch', work, async (req, res) => {
    res.json(
      await service.unmatch(
        actorOf(req),
        company(req.params),
        id(req.params.bankId),
        id(req.params.lineId),
      ),
    );
  });
  router.post('/accounts/:bankId/lines/:lineId/journal', work, async (req, res) => {
    const input = parseWith(bankLineJournalSchema, req.body);
    res
      .status(201)
      .json(
        await service.createJournal(
          actorOf(req),
          company(req.params),
          id(req.params.bankId),
          id(req.params.lineId),
          input,
        ),
      );
  });
  router.post('/accounts/:bankId/auto-match', work, async (req, res) => {
    res.json(await service.autoMatch(actorOf(req), company(req.params), id(req.params.bankId)));
  });
  router.post('/accounts/:bankId/apply-rules', work, async (req, res) => {
    res.json(await service.applyRules(actorOf(req), company(req.params), id(req.params.bankId)));
  });
  router.get('/accounts/:bankId/reconciliation', read, async (req, res) => {
    const { asOf } = parseWith(reconciliationQuerySchema, req.query);
    res.json(
      await service.reconciliation(actorOf(req), company(req.params), id(req.params.bankId), asOf),
    );
  });
  router.post('/accounts/:bankId/reconciliations', manage, async (req, res) => {
    const { asOf } = parseWith(lockReconciliationSchema, req.body);
    res
      .status(201)
      .json(await service.lock(actorOf(req), company(req.params), id(req.params.bankId), asOf));
  });

  router.get('/rules', read, async (req, res) => {
    res.json(await service.listRules(actorOf(req), company(req.params)));
  });
  router.post('/rules', work, async (req, res) => {
    const input = parseWith(bankRuleInputSchema, req.body);
    res.status(201).json(await service.createRule(actorOf(req), company(req.params), input));
  });
  router.put('/rules/:ruleId', work, async (req, res) => {
    const input = parseWith(bankRuleInputSchema, req.body);
    res.json(
      await service.updateRule(actorOf(req), company(req.params), id(req.params.ruleId), input),
    );
  });
  router.delete('/rules/:ruleId', work, async (req, res) => {
    await service.deleteRule(actorOf(req), company(req.params), id(req.params.ruleId));
    res.status(204).end();
  });

  return router;
}
