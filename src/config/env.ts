import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const booleanFromEnv = z
  .string()
  .optional()
  .default('false')
  .transform((value) => ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  CORS_ORIGIN: z.string().default('*'),
  AI_PROVIDER: z.enum(['mock', 'openrouter', 'openai', 'gemini']).default('mock'),
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
  ACCESS_TOKEN_TTL: z.string().optional().default('15m'),
  USE_MOCK_NOTION: booleanFromEnv,
});

export const env = envSchema.parse(process.env);

export type AppEnv = typeof env;
