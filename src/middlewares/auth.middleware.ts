import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import type { UserService } from '../services/user.service';

export function createAuthMiddleware(userService: UserService): RequestHandler {
  return async (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return next();
    const token = auth.split(' ')[1];
    try {
      const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET || 'changeme') as any;
      const userId = decoded?.sub;
      if (!userId) return next();
      const user = await userService.getUserById(userId);
      if (!user) return next();
      (req as any).user = { id: user.pageId, email: user.email, role: user.role, linkedPatientPageIds: user.linkedPatientPageIds };
      return next();
    } catch (err) {
      return next();
    }
  };
}
