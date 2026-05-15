import { Router } from 'express';
import type { ChatService } from '../services/chat.service';
import { createCustomerController } from '../controllers/customer.controller';

export function createCustomerRouter(chatService: ChatService): Router {
  const router = Router();
  router.post('/create', createCustomerController(chatService));
  return router;
}
