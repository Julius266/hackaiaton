import { Router } from 'express';
import type { UserService } from '../services/user.service';
import { createAuthController } from '../controllers/auth.controller';
import { createAuthMiddleware } from '../middlewares/auth.middleware';

export function createAuthRouter(deps: { userService: UserService }): Router {
  const router = Router();
  const controller = createAuthController(deps);
  const auth = createAuthMiddleware(deps.userService);

  router.post('/login', controller.login);
  router.post('/register', controller.register);
  router.put('/profile', auth, controller.updateProfile);
  router.put('/password', auth, controller.updatePassword);
  router.post('/request-code', auth, controller.requestCode);
  router.post('/verify-password', auth, controller.verifyAndChangePassword);
  router.delete('/account', auth, controller.deleteAccount);

  return router;
}
