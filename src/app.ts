import cors from 'cors';
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

function parseCorsOrigin(origin: string): string | string[] | boolean {
  if (origin.trim() === '*') {
    return true;
  }

  const values = origin
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return values.length === 1 ? values[0] : values;
}

export function createApp() {
  const notionService = new NotionService();
  const chatService = new ChatService(notionService);
  const businessService = new BusinessService(notionService);
  const aiService = new AiService();
  const userService = new UserService(notionService, chatService);

  const app = express();

  // Request logging middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`);
    });
    next();
  });

  app.use(
    cors({
      origin: parseCorsOrigin(env.CORS_ORIGIN),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use('/api', createApiRouter({ aiService, businessService, chatService, notionService, userService }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
