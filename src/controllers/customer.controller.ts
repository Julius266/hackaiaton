import type { RequestHandler } from 'express';
import type { ChatService } from '../services/chat.service';
import { wrapAsync } from '../utils/async-handler';

export function createCustomerController(chatService: ChatService): RequestHandler {
  return wrapAsync(async (_req, res) => {
    const conversation = await chatService.createConversation();

    res.status(201).json({
      success: true,
      data: {
        customerId: conversation.customerId,
        conversationId: conversation.conversationId,
        createdAt: conversation.createdAt,
      },
    });
  });
}
