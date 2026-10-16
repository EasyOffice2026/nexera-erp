import { createUserSchema, updateUserSchema } from '@nexera/shared';
import { Router } from 'express';
import { z } from 'zod';
import { parseWith } from '../../lib/validate';
import { actorOf, requirePermission } from '../../middleware/authenticate';
import type { UsersService } from './users.service';

const idSchema = z.string().uuid();

export function createUsersRouter(service: UsersService): Router {
  const router = Router();
  router.use(requirePermission('users.manage'));

  router.get('/', async (req, res) => {
    res.json(await service.list(actorOf(req)));
  });

  router.post('/', async (req, res) => {
    res.status(201).json(await service.create(actorOf(req), parseWith(createUserSchema, req.body)));
  });

  router.patch('/:id', async (req, res) => {
    const id = parseWith(idSchema, req.params.id);
    res.json(await service.update(actorOf(req), id, parseWith(updateUserSchema, req.body)));
  });

  return router;
}
