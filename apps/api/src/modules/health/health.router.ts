import { Router } from 'express';
import type { PrismaClient } from '../../lib/prisma';

export function createHealthRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Ready when the database answers.
  router.get('/ready', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  return router;
}
