import type { RequestHandler } from 'express';
import { z } from 'zod';
import { wrapAsync } from '../utils/async-handler';
import type { UserService } from '../services/user.service';
import { logger } from '../utils/logger';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  role: z.string().min(1),
  linkedPatientPageIds: z.array(z.string()).optional(),
});

export function createAuthController(deps: { userService: UserService }): { login: RequestHandler; register: RequestHandler; updateProfile: RequestHandler; updatePassword: RequestHandler } {
  return {
    login: wrapAsync(async (req, res) => {
      const payload = loginSchema.parse(req.body);
      logger.info(`Login attempt for email: ${payload.email}`);
      
      const user = await deps.userService.authenticate(payload.email, payload.password);
      if (!user) {
        logger.warn(`Failed login attempt for email: ${payload.email}`);
        res.status(401).json({ success: false, message: 'Invalid credentials' });
        return;
      }

      logger.info(`Successful login for user: ${user.pageId}`);
      const token = deps.userService.createAccessToken(user);
      res.json({ success: true, data: { accessToken: token, user: { id: user.pageId, email: user.email, role: user.role } } });
      return;
    }),

    register: wrapAsync(async (req, res) => {
      const payload = registerSchema.parse(req.body);
      logger.info(`Registering new user with email: ${payload.email}`);
      
      const user = await deps.userService.registerUser(payload);

      logger.info(`User registered successfully: ${user.pageId}`);
      res.status(201).json({
        success: true,
        data: {
          id: user.pageId,
          email: user.email,
          role: user.role,
          linkedPatientPageIds: user.linkedPatientPageIds,
        },
      });
    }),

    updateProfile: wrapAsync(async (req, res) => {
      const authUser = (req as any).user;
      if (!authUser) {
        res.status(401).json({ success: false, message: 'Unauthorized' });
        return;
      }
      const user = await deps.userService.updateProfile(authUser.sub, req.body);
      res.json({ success: true, data: user });
    }),

    updatePassword: wrapAsync(async (req, res) => {
      const authUser = (req as any).user;
      if (!authUser) {
        res.status(401).json({ success: false, message: 'Unauthorized' });
        return;
      }
      const success = await deps.userService.updatePassword(authUser.sub, req.body.password);
      res.json({ success });
    }),
  };
}
