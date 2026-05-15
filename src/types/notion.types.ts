export interface NotionQueryOptions {
  filter?: Record<string, unknown>;
  sorts?: Array<Record<string, unknown>>;
  pageSize?: number;
  startCursor?: string;
}

export interface NotionCreatePageInput {
  databaseId: string;
  properties: Record<string, unknown>;
  children?: Array<Record<string, unknown>>;
}

export interface NotionUpdatePageInput {
  pageId: string;
  properties: Record<string, unknown>;
}

export interface NotionPageResult {
  id: string;
  properties: Record<string, any>;
  url?: string;
  [key: string]: unknown;
}
