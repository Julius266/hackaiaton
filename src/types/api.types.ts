import type { BusinessData } from './business.types';
import type { SymptomAnalysis } from './ai.types';
import type { ChatMessage, CustomerContext } from './chat.types';

export interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export interface ErrorResponse {
  success: false;
  error: string;
  details?: unknown;
}

export interface CreateCustomerResponseData {
  customerId: string;
  conversationId: string;
  createdAt: string;
}

export interface ChatMessageRequestBody {
  customerId?: string;
  numeroPoliza?: string;
  conversationId?: string;
  message: string;
  metadata?: Record<string, unknown>;
  customerContext?: Partial<CustomerContext>;
}

export interface ChatMessageResponseData {
  customerId: string;
  conversationId: string;
  analysis: SymptomAnalysis;
  businessData: BusinessData;
  assistantMessage: string;
  history: ChatMessage[];
  customerContext: CustomerContext;
}

export interface ChatHistoryResponseData {
  customerId: string;
  conversationId: string;
  customerContext: CustomerContext;
  messages: ChatMessage[];
}
