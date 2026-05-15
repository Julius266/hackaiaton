export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  customerId: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface ConversationState {
  customerId: string;
  conversationId: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  context: CustomerContext;
}

export interface CustomerContext {
  customerId: string;
  conversationId: string;
  numeroPoliza?: string;
  patientPageId?: string;
  planPageId?: string;
  specialtyPageId?: string;
  hospitalPageId?: string;
  consultationId?: string;
  planType?: string;
  insuranceTier?: string;
  age?: number;
  city?: string;
  language?: string;
  lastIntent?: string;
  lastSpecialty?: string;
  lastPriority?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
}
