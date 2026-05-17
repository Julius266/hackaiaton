import { Router } from 'express';
import type { NotionService } from '../services/notion.service';
import type { UserService } from '../services/user.service';
import { createPlanController } from '../controllers/plan.controller';
import { createAuthMiddleware } from '../middlewares/auth.middleware';

export function createPlanRouter(deps: {
  notionService: NotionService;
  userService: UserService;
}): Router {
  const router = Router();
  const controller = createPlanController(deps);
  const auth = createAuthMiddleware(deps.userService);

  router.get('/', auth, controller.listPlans);

  return router;
}
