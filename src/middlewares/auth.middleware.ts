import type { RequestHandler } from 'express';
import * as jwt from 'jsonwebtoken';
import { env } from '../config/env';
import type { UserService } from '../services/user.service';
import { logger } from '../utils/logger';

export function createAuthMiddleware(userService: UserService): RequestHandler {
  return async (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const token = auth.split(' ')[1];
    try {
      const secret = env.JWT_ACCESS_SECRET || 'changeme';
      const decoded = jwt.verify(token, secret) as any;
      const userId = decoded?.sub;
      
      if (!userId) {
        logger.warn('Auth Middleware: Token decoded but sub (userId) is missing');
        return res.status(401).json({ success: false, message: 'Invalid token structure' });
      }

      const user = await userService.getUserById(userId);
      if (!user) {
        logger.warn(`Auth Middleware: User not found for ID: ${userId}`);
        return res.status(401).json({ success: false, message: 'User not found' });
      }

      // Aligned with controllers expecting authUser.sub
      (req as any).user = { 
        sub: user.pageId, 
        email: user.email, 
        role: user.role, 
        linkedPatientPageIds: user.linkedPatientPageIds 
      };
      
      return next();
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        logger.warn('Auth Middleware: JWT expired');
        return res.status(401).json({ success: false, message: 'Session expired', code: 'TOKEN_EXPIRED' });
      }
      logger.error('Auth Middleware: JWT verification failed', err);
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
  };
}
