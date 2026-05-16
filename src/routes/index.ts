import { Router } from 'express';
import type { AiService } from '../services/ai.service';
import type { BusinessService } from '../services/business.service';
import type { ChatService } from '../services/chat.service';
import type { NotionService } from '../services/notion.service';
import { createChatRouter } from './chat.routes';
import { createCustomerRouter } from './customer.routes';
import { createHealthRouter } from './health.routes';
import { createAuthRouter } from './auth.routes';
import { createHospitalRouter } from './hospital.routes';
import type { UserService } from '../services/user.service';

export function createApiRouter(deps: {
  aiService: AiService;
  businessService: BusinessService;
  chatService: ChatService;
  notionService: NotionService;
  userService?: UserService;
}): Router {
  const router = Router();

  router.use('/health', createHealthRouter());
  if (deps.userService) router.use('/auth', createAuthRouter({ userService: deps.userService }));
  router.use('/customer', createCustomerRouter(deps.chatService, deps.notionService));
  router.use('/chat', createChatRouter(deps));
  router.use('/hospital', createHospitalRouter(deps.notionService));

  return router;
}
