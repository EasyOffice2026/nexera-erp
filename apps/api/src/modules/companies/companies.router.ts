import {
  createBranchSchema,
  createBrandSchema,
  createCompanySchema,
  updateCompanySchema,
} from '@nexera/shared';
import { Router } from 'express';
import { z } from 'zod';
import { parseWith } from '../../lib/validate';
import { actorOf, requirePermission } from '../../middleware/authenticate';
import type { CompaniesService } from './companies.service';

const idSchema = z.string().uuid();

export function createCompaniesRouter(service: CompaniesService): Router {
  const router = Router();
  const read = requirePermission('reports.view');
  const manage = requirePermission('companies.manage');

  router.get('/', read, async (req, res) => {
    res.json(await service.list(actorOf(req)));
  });

  router.post('/', manage, async (req, res) => {
    res
      .status(201)
      .json(await service.create(actorOf(req), parseWith(createCompanySchema, req.body)));
  });

  router.get('/:companyId', read, async (req, res) => {
    res.json(await service.get(actorOf(req), parseWith(idSchema, req.params.companyId)));
  });

  router.patch('/:companyId', manage, async (req, res) => {
    const id = parseWith(idSchema, req.params.companyId);
    res.json(await service.update(actorOf(req), id, parseWith(updateCompanySchema, req.body)));
  });

  router.get('/:companyId/brands', read, async (req, res) => {
    res.json(await service.listBrands(actorOf(req), parseWith(idSchema, req.params.companyId)));
  });

  router.post('/:companyId/brands', manage, async (req, res) => {
    const id = parseWith(idSchema, req.params.companyId);
    res
      .status(201)
      .json(await service.createBrand(actorOf(req), id, parseWith(createBrandSchema, req.body)));
  });

  router.get('/:companyId/branches', read, async (req, res) => {
    res.json(await service.listBranches(actorOf(req), parseWith(idSchema, req.params.companyId)));
  });

  router.post('/:companyId/branches', manage, async (req, res) => {
    const id = parseWith(idSchema, req.params.companyId);
    res
      .status(201)
      .json(await service.createBranch(actorOf(req), id, parseWith(createBranchSchema, req.body)));
  });

  return router;
}
