/**
 * Vercel + Express: default export must be a function or Connect-style server.
 * Avoid naming the factory module `app.ts` — Vercel auto-detects it as the Express entry.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createApp } from '../src/express-factory';

let cached: ReturnType<typeof createApp> | undefined;

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (!cached) {
    cached = createApp();
  }
  cached(req as never, res as never);
}
