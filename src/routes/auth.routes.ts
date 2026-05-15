import { Router } from 'express';
import type { UserService } from '../services/user.service';
import { createAuthController } from '../controllers/auth.controller';

export function createAuthRouter(deps: { userService: UserService }): Router {
  const router = Router();
  const controller = createAuthController(deps);

  router.post('/login', controller.login);
  router.post('/register', controller.register);

  return router;
}
