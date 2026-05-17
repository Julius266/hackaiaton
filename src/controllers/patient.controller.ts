import type { RequestHandler } from 'express';
import { z } from 'zod';
import { wrapAsync } from '../utils/async-handler';
import type { NotionService } from '../services/notion.service';

const createPatientSchema = z.object({
  numeroPoliza: z.string().min(1),
  email: z.string().email(),
  nombreCompleto: z.string().min(1),
  planPageId: z.string().optional(),
  deducibleRestante: z.number().nonnegative().optional(),
  estado: z.enum(['Activo', 'Inactivo']).optional(),
});

export function createPatientController(deps: { notionService: NotionService }): {
  createPatient: RequestHandler;
} {
  return {
    createPatient: wrapAsync(async (req, res) => {
      const payload = createPatientSchema.parse(req.body);

      const patient = await deps.notionService.createPatient({
        numeroPoliza: payload.numeroPoliza,
        email: payload.email,
        nombreCompleto: payload.nombreCompleto,
        planPageId: payload.planPageId,
        deducibleRestante: payload.deducibleRestante,
        estado: payload.estado ?? 'Activo',
      });

      res.status(201).json({
        success: true,
        data: {
          pageId: patient.pageId,
          numeroPoliza: patient.numeroPoliza,
          nombreCompleto: patient.nombreCompleto,
          email: patient.email,
          estado: patient.estado,
          planPageId: patient.planPageId,
          deducibleRestante: patient.deducibleRestante,
        },
      });
    }),
  };
}
