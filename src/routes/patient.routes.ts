import { Router } from 'express';
import type { NotionService } from '../services/notion.service';
import type { UserService } from '../services/user.service';
import { createPatientController } from '../controllers/patient.controller';
import { createAuthMiddleware } from '../middlewares/auth.middleware';

export function createPatientRouter(deps: {
  notionService: NotionService;
  userService: UserService;
}): Router {
  const router = Router();
  const controller = createPatientController(deps);
  const auth = createAuthMiddleware(deps.userService);

  router.post('/', auth, controller.createPatient);

  return router;
}
