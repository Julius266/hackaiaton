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
  nombre: z.string().min(1),
  activo: z.boolean().optional(),
  linkedPatientPageIds: z.array(z.string()).optional(),
});

export function createAuthController(deps: { userService: UserService }): {
  login: RequestHandler;
  register: RequestHandler;
  updateProfile: RequestHandler;
  updatePassword: RequestHandler;
  requestCode: RequestHandler;
  verifyAndChangePassword: RequestHandler;
  deleteAccount: RequestHandler;
  listUsers: RequestHandler;
} {
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
      
      // Enviamos el primer patientId vinculado como ID principal para el historial de chat
      const patientId = user.linkedPatientPageIds?.[0] || user.pageId;
      
      res.json({ 
        success: true, 
        data: { 
          accessToken: token, 
          user: {
            id: user.pageId,
            patientId,
            email: user.email,
            role: user.role,
            nombre: user.nombre,
          }
        } 
      });
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
          userId: user.userId,
          email: user.email,
          role: user.role,
          nombre: user.nombre,
          activo: user.activo,
          linkedPatientPageIds: user.linkedPatientPageIds,
        },
      });
    }),

    listUsers: wrapAsync(async (req, res) => {
      const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

      const { users, hasMore, nextCursor } = await deps.userService.listUsers(pageSize, cursor);

      res.json({
        success: true,
        data: users.map((u) => ({
          id: u.userId,
          email: u.email,
          nombre: u.nombre,
          rol: u.role,
          activo: u.activo,
          pacientes: u.linkedPatientPageIds,
        })),
        pagination: {
          hasMore,
          nextCursor,
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

    requestCode: wrapAsync(async (req, res) => {
      const authUser = (req as any).user;
      if (!authUser) {
        res.status(401).json({ success: false, message: 'Unauthorized' });
        return;
      }
      const code = await deps.userService.generateVerificationCode(authUser.sub);
      logger.info(`Verification code generated for user ${authUser.sub}: ${code} (Simulation)`);
      res.json({ success: true, message: 'Verification code sent', code }); // In real app, don't return code
    }),

    verifyAndChangePassword: wrapAsync(async (req, res) => {
      const authUser = (req as any).user;
      const { code, password } = req.body;
      if (!authUser) {
        res.status(401).json({ success: false, message: 'Unauthorized' });
        return;
      }
      
      const isValid = await deps.userService.verifyCode(authUser.sub, code);
      if (!isValid) {
        res.status(400).json({ success: false, message: 'Invalid or expired code' });
        return;
      }

      const success = await deps.userService.updatePassword(authUser.sub, password);
      res.json({ success });
    }),

    deleteAccount: wrapAsync(async (req, res) => {
      const authUser = (req as any).user;
      if (!authUser) {
        res.status(401).json({ success: false, message: 'Unauthorized' });
        return;
      }
      
      await deps.userService.deleteAccount(authUser.sub);
      
      res.json({
        success: true,
        message: 'Account and all related data deleted successfully'
      });
    }),
  };
}
