/**
 * Vercel + Express: default export must be a function or Connect-style server.
 * Avoid naming the factory module `app.ts` — Vercel auto-detects it as the Express entry.
 *
 * Vercel's Express builder requires a direct `express` import on this file (it does not
 * trace imports into `express-factory.ts`).
 */
import express from 'express';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createApp } from '../src/express-factory';

void express;

let cached: ReturnType<typeof createApp> | undefined;

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (!cached) {
    cached = createApp();
  }
  cached(req as never, res as never);
}
