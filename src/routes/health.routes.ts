import { Router } from 'express';
import { healthController } from '../controllers/health.controller';

export function createHealthRouter(): Router {
  const router = Router();
  router.get('/', healthController);
  return router;
}
