import type { RequestHandler } from 'express';
import { z } from 'zod';
import { wrapAsync } from '../utils/async-handler';
import type { UserService } from '../services/user.service';

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

export function createAuthController(deps: { userService: UserService }): { login: RequestHandler; register: RequestHandler } {
  return {
    login: wrapAsync(async (req, res) => {
      const payload = loginSchema.parse(req.body);
      const user = await deps.userService.authenticate(payload.email, payload.password);
      if (!user) {
        res.status(401).json({ success: false, message: 'Invalid credentials' });
        return;
      }

      const token = deps.userService.createAccessToken(user);
      res.json({ success: true, data: { accessToken: token, user: { id: user.pageId, email: user.email, role: user.role } } });
      return;
    }),

    register: wrapAsync(async (req, res) => {
      const payload = registerSchema.parse(req.body);
      const user = await deps.userService.registerUser(payload);

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
  };
}
