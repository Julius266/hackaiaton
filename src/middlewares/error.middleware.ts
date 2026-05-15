import type { ErrorRequestHandler, RequestHandler } from 'express';
import { logger } from '../utils/logger';

export class ApiError extends Error {
  public readonly statusCode: number;

  public readonly details?: unknown;

  constructor(message: string, statusCode = 500, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const notFoundHandler: RequestHandler = (req, res) => {
  logger.warn(`404 - Not Found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    success: false,
    error: 'Ruta no encontrada',
  });
};

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const statusCode = error instanceof ApiError ? error.statusCode : 500;
  const message = error instanceof Error ? error.message : 'Error interno del servidor';

  if (statusCode >= 500) {
    logger.error(`Server Error: ${message}`, error);
  } else {
    logger.warn(`Client Error (${statusCode}): ${message}`);
  }

  res.status(statusCode).json({
    success: false,
    error: message,
    details: error instanceof ApiError ? error.details : undefined,
  });
};
