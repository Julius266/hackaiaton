import { randomUUID } from 'crypto';

export function createCustomerId(): string {
  return `cust_${randomUUID().slice(0, 12)}`;
}

export function createConversationId(): string {
  return `conv_${randomUUID().slice(0, 12)}`;
}

export function createMessageId(): string {
  return `msg_${randomUUID().slice(0, 12)}`;
}
