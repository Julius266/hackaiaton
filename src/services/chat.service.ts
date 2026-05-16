import { env } from '../config/env';
import type { ChatMessage, ConversationState, CustomerContext } from '../types/chat.types';
import { createConversationId, createCustomerId, createMessageId } from '../utils/id';
import type { NotionService } from './notion.service';
import { logger } from '../utils/logger';

export class ChatService {
  private readonly conversationsById = new Map<string, ConversationState>();

  private readonly latestConversationByCustomerId = new Map<string, string>();

  constructor(private readonly notionService: NotionService) {}

  public async createConversation(customerId?: string, context: Partial<CustomerContext> = {}): Promise<ConversationState> {
    const resolvedCustomerId = customerId ?? createCustomerId();
    const conversationId = context.conversationId ?? createConversationId();
    const existing = this.conversationsById.get(conversationId);

    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const nextState: ConversationState = {
      customerId: resolvedCustomerId,
      conversationId,
      createdAt: now,
      updatedAt: now,
      messages: [],
      context: {
        ...context,
        customerId: resolvedCustomerId,
        conversationId,
      },
    };

    this.conversationsById.set(conversationId, nextState);
    this.latestConversationByCustomerId.set(resolvedCustomerId, conversationId);
    await this.persistContext(nextState.context);
    return nextState;
  }

  public async ensureConversation(customerId?: string, context: Partial<CustomerContext> = {}): Promise<ConversationState> {
    const resolvedCustomerId = customerId ?? context.customerId ?? createCustomerId();
    const requestedConversationId = context.conversationId;

    if (requestedConversationId) {
      const existing = this.conversationsById.get(requestedConversationId);
      if (existing) {
        const mergedContext = {
          ...existing.context,
          ...context,
          customerId: resolvedCustomerId,
          conversationId: requestedConversationId,
        };
        existing.customerId = resolvedCustomerId;
        existing.context = mergedContext;
        existing.updatedAt = new Date().toISOString();
        this.latestConversationByCustomerId.set(resolvedCustomerId, requestedConversationId);
        await this.persistContext(mergedContext);
        return existing;
      }

      const persistedContext = await this.notionService.getCustomerContext(resolvedCustomerId);
      return this.createConversation(resolvedCustomerId, {
        ...persistedContext,
        ...context,
        conversationId: requestedConversationId,
      });
    }

    const latestConversationId = this.latestConversationByCustomerId.get(resolvedCustomerId);
    if (latestConversationId) {
      const existing = this.conversationsById.get(latestConversationId);
      if (existing) {
        const mergedContext = {
          ...existing.context,
          ...context,
          customerId: resolvedCustomerId,
          conversationId: existing.conversationId,
        };
        existing.context = mergedContext;
        existing.updatedAt = new Date().toISOString();
        await this.persistContext(mergedContext);
        return existing;
      }
    }

    const existing = this.conversationsById.get(resolvedCustomerId);
    if (existing) {
      const mergedContext = {
        ...existing.context,
        ...context,
        customerId: resolvedCustomerId,
      };
      existing.context = mergedContext;
      existing.updatedAt = new Date().toISOString();
      await this.persistContext(mergedContext);
      return existing;
    }

    const persistedContext = await this.notionService.getCustomerContext(resolvedCustomerId);
    return this.createConversation(resolvedCustomerId, {
      ...persistedContext,
      ...context,
    });
  }

  public async saveMessage(message: Omit<ChatMessage, 'id'> & { id?: string }): Promise<ChatMessage> {
    const conversation = await this.ensureConversation(message.customerId, {
      conversationId: message.conversationId,
    });

    const storedMessage: ChatMessage = {
      id: message.id ?? createMessageId(),
      customerId: message.customerId,
      conversationId: message.conversationId,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      metadata: message.metadata ?? {},
    };

    conversation.messages.push(storedMessage);
    conversation.updatedAt = storedMessage.timestamp;
    conversation.conversationId = storedMessage.conversationId;
    this.latestConversationByCustomerId.set(message.customerId, storedMessage.conversationId);

    await this.notionService.appendChatMessage(storedMessage);
    return storedMessage;
  }

  public async getConversationHistory(customerId: string, conversationId?: string): Promise<ChatMessage[]> {
    const resolvedConversationId = conversationId ?? this.latestConversationByCustomerId.get(customerId);
    if (resolvedConversationId) {
      const existing = this.conversationsById.get(resolvedConversationId);
      if (existing) {
        return existing.messages.slice();
      }

      return this.notionService.getMessagesByConversationId(resolvedConversationId, customerId);
    }

    const messages = await this.notionService.getMessagesByCustomerId(customerId);
    const loadedConversationId = messages[0]?.conversationId ?? createConversationId();
    const state: ConversationState = {
      customerId,
      conversationId: loadedConversationId,
      createdAt: messages[0]?.timestamp ?? new Date().toISOString(),
      updatedAt: messages[messages.length - 1]?.timestamp ?? new Date().toISOString(),
      messages: messages.slice(),
      context: {
        customerId,
        conversationId: loadedConversationId,
      },
    };

    this.conversationsById.set(loadedConversationId, state);
    this.latestConversationByCustomerId.set(customerId, loadedConversationId);
    return messages;
  }

  public async getConversationState(customerId: string, conversationId?: string): Promise<ConversationState> {
    const resolvedConversationId = conversationId ?? this.latestConversationByCustomerId.get(customerId);
    if (resolvedConversationId) {
      const existing = this.conversationsById.get(resolvedConversationId);
      if (existing) {
        return existing;
      }

      const messages = await this.notionService.getMessagesByConversationId(resolvedConversationId, customerId);
      const context = (await this.notionService.getCustomerContext(customerId)) ?? {
        customerId,
        conversationId: resolvedConversationId,
      };

      const state: ConversationState = {
        customerId,
        conversationId: resolvedConversationId,
        createdAt: messages[0]?.timestamp ?? new Date().toISOString(),
        updatedAt: messages[messages.length - 1]?.timestamp ?? new Date().toISOString(),
        messages,
        context: {
          ...context,
          customerId,
          conversationId: resolvedConversationId,
        },
      };

      this.conversationsById.set(resolvedConversationId, state);
      this.latestConversationByCustomerId.set(customerId, resolvedConversationId);
      return state;
    }

    const messages = await this.notionService.getMessagesByCustomerId(customerId);
    const loadedConversationId = messages[0]?.conversationId ?? createConversationId();
    const context = (await this.notionService.getCustomerContext(customerId)) ?? {
      customerId,
      conversationId: loadedConversationId,
    };

    const state: ConversationState = {
      customerId,
      conversationId: loadedConversationId,
      createdAt: messages[0]?.timestamp ?? new Date().toISOString(),
      updatedAt: messages[messages.length - 1]?.timestamp ?? new Date().toISOString(),
      messages,
      context: {
        ...context,
        customerId,
        conversationId: loadedConversationId,
      },
    };

    this.conversationsById.set(loadedConversationId, state);
    this.latestConversationByCustomerId.set(customerId, loadedConversationId);
    return state;
  }

  public async updateCustomerContext(customerId: string, context: Partial<CustomerContext>): Promise<CustomerContext> {
    const conversation = await this.ensureConversation(customerId, context);
    const mergedContext: CustomerContext = {
      ...conversation.context,
      ...context,
      customerId,
      conversationId: conversation.conversationId,
    };

    conversation.context = mergedContext;
    await this.persistContext(mergedContext);
    return mergedContext;
  }

  public async getUserSessions(customerId: string): Promise<Array<{ id: string; title: string; lastUpdated: string }>> {
    // Buscamos todas las consultas (sesiones) en Notion para este número de póliza / ID
    const consultations = await this.notionService.getConsultationsByNumeroPoliza(customerId);
    
    return consultations.map(c => ({
      id: c.pageId,
      title: c.sintomaIngresado ? (c.sintomaIngresado.slice(0, 40) + (c.sintomaIngresado.length > 40 ? '...' : '')) : 'Nueva Consulta',
      lastUpdated: new Date().toISOString() // Notion no siempre da la fecha de update por query simple, usamos actual por ahora
    })).reverse(); // Mas recientes primero
  }

  public async deleteSession(customerId: string, conversationId: string): Promise<void> {
    // 1. Buscamos los mensajes asociados a esta consulta para borrarlos también
    const messages = await this.notionService.getMessagesByConversationId(conversationId, customerId);
    
    // 2. Archivamos todos los mensajes en Notion (solo si son IDs reales de Notion)
    await Promise.all(messages.map(m => {
      // Solo intentamos archivar si parece un ID real de Notion (UUID)
      if (this.notionService.isRealNotionId(m.id)) {
        return this.notionService.archivePage(m.id);
      }
      return Promise.resolve();
    }));
    
    // 3. Archivamos la consulta principal (solo si es ID real)
    if (this.notionService.isRealNotionId(conversationId)) {
      await this.notionService.archivePage(conversationId);
    }
    
    logger.info(`Session ${conversationId} and its messages deleted for customer ${customerId}`);
  }

  private async persistContext(context: CustomerContext): Promise<void> {
    if (!env.NOTION_TOKEN && this.notionService.isMockMode()) {
      await this.notionService.updateCustomerContext(context.customerId, context as unknown as Record<string, unknown>);
      return;
    }

    await this.notionService.updateCustomerContext(context.customerId, context as unknown as Record<string, unknown>);
  }
}
