import { Router } from 'express';
import type { ChatService } from '../services/chat.service';
import type { NotionService } from '../services/notion.service';
import { createCustomerController } from '../controllers/customer.controller';

export function createCustomerRouter(chatService: ChatService, notionService?: NotionService): Router {
  const router = Router();
  const controller = createCustomerController(chatService, notionService);

  /**
   * POST /customer/create
   * Crear un nuevo cliente/conversación
   */
  router.post('/create', controller.createCustomer);

  /**
   * GET /customer/:customerId/coverage
   * Obtener las coberturas del seguro de un cliente
   */
  router.get('/:customerId/coverage', controller.getCoverage);

  return router;
}
