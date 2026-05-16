import { Router } from 'express';
import type { AiService } from '../services/ai.service';
import type { BusinessService } from '../services/business.service';
import type { ChatService } from '../services/chat.service';
import type { UserService } from '../services/user.service';
import { createChatHistoryController, createChatMessageController, createChatDeleteController } from '../controllers/chat.controller';
import { createAuthMiddleware } from '../middlewares/auth.middleware';

export function createChatRouter(deps: {
  aiService: AiService;
  businessService: BusinessService;
  chatService: ChatService;
  userService?: UserService;
}): Router {
  const router = Router();
  const auth = deps.userService ? createAuthMiddleware(deps.userService) : (_: any, __: any, next: any) => next();

  router.post('/message', auth, createChatMessageController(deps));
  router.get('/history/:customerId', auth, createChatHistoryController(deps.chatService));
  router.delete('/history/:customerId/:conversationId', auth, createChatDeleteController(deps.chatService));

  return router;
}
