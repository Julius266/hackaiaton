import cors, { type CorsOptions } from 'cors';
import express, { Request, Response, NextFunction } from 'express';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';
import { AiService } from './services/ai.service';
import { BusinessService } from './services/business.service';
import { ChatService } from './services/chat.service';
import { NotionService } from './services/notion.service';
import { UserService } from './services/user.service';
import { createApiRouter } from './routes';
import { logger } from './utils/logger';

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/$/, '');
}

/**
 * El front usa JWT en `Authorization` pero fetch sin `credentials: 'include'`.
 * Con `credentials: false`, `Access-Control-Allow-Origin: *` es válido en preflight y evita
 * combinaciones frágiles `Allow-Credentials: true` + reflejo de Origin.
 */
function buildCorsOptions(): CorsOptions {
  const raw = normalizeOrigin(env.CORS_ORIGIN);

  if (raw === '' || raw === '*') {
    return {
      origin: '*',
      credentials: false,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      optionsSuccessStatus: 204,
      maxAge: 86_400,
    };
  }

  const allowed = raw
    .split(',')
    .map((entry) => normalizeOrigin(entry))
    .filter(Boolean);

  return {
    origin: (requestOrigin, callback) => {
      if (!requestOrigin) {
        callback(null, allowed[0] ?? true);
        return;
      }
      const n = normalizeOrigin(requestOrigin);
      if (allowed.includes(n)) {
        callback(null, requestOrigin);
        return;
      }
      callback(new Error(`CORS: origin no permitido (${requestOrigin})`));
    },
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
    maxAge: 86_400,
  };
}

export function createApp() {
  const notionService = new NotionService();
  const chatService = new ChatService(notionService);
  const businessService = new BusinessService(notionService);
  const aiService = new AiService();
  const userService = new UserService(notionService, chatService);

  const app = express();

  app.use(cors(buildCorsOptions()));

  // Request logging middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`);
    });
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use('/api', createApiRouter({ aiService, businessService, chatService, notionService, userService }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
