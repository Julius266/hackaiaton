import { env } from '../config/env';
import type { ChatMessage, ConversationState, CustomerContext } from '../types/chat.types';
import { createConversationId, createCustomerId, createMessageId } from '../utils/id';
import type { NotionService } from './notion.service';

export class ChatService {
  private readonly conversations = new Map<string, ConversationState>();

  constructor(private readonly notionService: NotionService) {}

  public async createConversation(customerId?: string, context: Partial<CustomerContext> = {}): Promise<ConversationState> {
    const resolvedCustomerId = customerId ?? createCustomerId();
    const existing = this.conversations.get(resolvedCustomerId);

    if (existing) {
      return existing;
    }

    const conversationId = createConversationId();
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

    this.conversations.set(resolvedCustomerId, nextState);
    await this.persistContext(nextState.context);
    return nextState;
  }

  public async ensureConversation(customerId?: string, context: Partial<CustomerContext> = {}): Promise<ConversationState> {
    if (!customerId) {
      return this.createConversation(undefined, context);
    }

    const existing = this.conversations.get(customerId);
    if (existing) {
      const mergedContext = {
        ...existing.context,
        ...context,
      };
      existing.context = mergedContext;
      if (typeof mergedContext.conversationId === 'string' && mergedContext.conversationId.length > 0) {
        existing.conversationId = mergedContext.conversationId;
      }
      existing.updatedAt = new Date().toISOString();
      await this.persistContext(mergedContext);
      return existing;
    }

    const persistedContext = await this.notionService.getCustomerContext(customerId);
    return this.createConversation(customerId, {
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

    await this.notionService.appendChatMessage(storedMessage);
    return storedMessage;
  }

  public async getConversationHistory(customerId: string): Promise<ChatMessage[]> {
    const existing = this.conversations.get(customerId);
    if (existing) {
      return existing.messages.slice();
    }

    const messages = await this.notionService.getMessagesByCustomerId(customerId);
    const conversationId = messages[0]?.conversationId ?? createConversationId();
    const state: ConversationState = {
      customerId,
      conversationId,
      createdAt: messages[0]?.timestamp ?? new Date().toISOString(),
      updatedAt: messages[messages.length - 1]?.timestamp ?? new Date().toISOString(),
      messages: messages.slice(),
      context: {
        customerId,
        conversationId,
      },
    };

    this.conversations.set(customerId, state);
    return messages;
  }

  public async getConversationState(customerId: string): Promise<ConversationState> {
    const existing = this.conversations.get(customerId);
    if (existing) {
      return existing;
    }

    const messages = await this.notionService.getMessagesByCustomerId(customerId);
    const conversationId = messages[0]?.conversationId ?? createConversationId();
    const context = (await this.notionService.getCustomerContext(customerId)) ?? {
      customerId,
      conversationId,
    };

    const state: ConversationState = {
      customerId,
      conversationId,
      createdAt: messages[0]?.timestamp ?? new Date().toISOString(),
      updatedAt: messages[messages.length - 1]?.timestamp ?? new Date().toISOString(),
      messages,
      context: {
        ...context,
        customerId,
        conversationId,
      },
    };

    this.conversations.set(customerId, state);
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

  private async persistContext(context: CustomerContext): Promise<void> {
    if (!env.NOTION_TOKEN && this.notionService.isMockMode()) {
      await this.notionService.updateCustomerContext(context.customerId, context as unknown as Record<string, unknown>);
      return;
    }

    await this.notionService.updateCustomerContext(context.customerId, context as unknown as Record<string, unknown>);
  }
}
