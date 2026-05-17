import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const booleanFromEnv = z
  .string()
  .optional()
  .default('false')
  .transform((value) => ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()));

const envSchema = z.object({
  /** Vercel u otros hosts pueden enviar valores no listados; normalizamos para no tumbar el arranque. */
  NODE_ENV: z.enum(['development', 'test', 'production']).catch('production'),
  /** En serverless `PORT` suele ir vacío o a 0; un valor inválido antes rompía zod.parse al cargar el módulo. */
  PORT: z.coerce.number().int().positive().catch(3000),
  CORS_ORIGIN: z.string().default('*'),
  AI_PROVIDER: z.enum(['mock', 'openrouter', 'openai', 'gemini']).catch('mock'),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  OPENROUTER_API_KEY: z.string().optional().default(''),
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
  OPENROUTER_MODEL: z.string().default('openai/gpt-4o-mini'),
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_MODEL: z.string().default('gemini-1.5-flash'),
  NOTION_TOKEN: z.string().optional().default(''),
  /** Timeout por petición al API de Notion (ms). Por defecto 120s para workspaces lentos o consultas grandes. */
  NOTION_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  DATABASE_ID_PLANES: z.string().optional().default(''),
  DATABASE_ID_ESPECIALIDADES: z.string().optional().default(''),
  DATABASE_ID_HOSPITALES: z.string().optional().default(''),
  DATABASE_ID_PACIENTES: z.string().optional().default(''),
  DATABASE_ID_COBERTURAS: z.string().optional().default(''),
  DATABASE_ID_HOSPITALES_RED: z.string().optional().default(''),
  DATABASE_ID_CONSULTAS: z.string().optional().default(''),
  DATABASE_ID_SESIONES: z.string().optional().default(''),
  DATABASE_ID_USUARIOS: z.string().optional().default(''),
  GEOCODING_PROVIDER: z.string().optional().default('google'),
  GOOGLE_GEOCODING_API_KEY: z.string().optional().default(''),
  JWT_ACCESS_SECRET: z.string().optional().default(''),
  ACCESS_TOKEN_TTL: z.string().optional().default('24h'),
  USE_MOCK_NOTION: booleanFromEnv,
  /**
   * Obligatoria para enriquecer el hospital recomendado vía Tavily en cada consulta de chat que tenga recomendación.
   * @see https://tavily.com
   */
  TAVILY_API_KEY: z.string().optional().default(''),
  /**
   * Si es true y existe hospital recomendado pero falta TAVILY_API_KEY, falla fetchBusinessData con error claro.
   * Por defecto false para no romper entornos sin Tavily.
   */
  CHAT_STRICT_TAVILY: booleanFromEnv,
  /** Refuerzo opcional (Google vía Serper); los fragmentos se fusionan con Tavily deduplicando URLs. https://serper.dev */
  SERPER_API_KEY: z.string().optional().default(''),
});

export const env = envSchema.parse(process.env);

export type AppEnv = typeof env;
