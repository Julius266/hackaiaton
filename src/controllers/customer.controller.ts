import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ChatService } from '../services/chat.service';
import type { NotionService } from '../services/notion.service';
import { wrapAsync } from '../utils/async-handler';
import { logger } from '../utils/logger';

interface CoverageDetailRow {
  idCobertura: string;
  especialidad: string;
  copagoFijo?: number;
  coaseguroOverride?: number;
  cubierto: boolean;
}

interface CoverageResponse {
  customerId: string;
  numeroPoliza: string;
  nombreCompleto?: string;
  plan: {
    nombrePlan: string;
    aseguradora: string;
    tipoPlan: string;
    deducibleAnual?: number;
    coaseguroPct?: number;
    maxBolsilloAnual?: number;
  };
  coberturas: CoverageDetailRow[];
}

export function createCustomerController(chatService: ChatService, notionService?: NotionService) {
  const createCustomer: RequestHandler = wrapAsync(async (_req, res) => {
    const conversation = await chatService.createConversation();

    res.status(201).json({
      success: true,
      data: {
        customerId: conversation.customerId,
        conversationId: conversation.conversationId,
        createdAt: conversation.createdAt,
      },
    });
  });

  const getCoverage: RequestHandler = wrapAsync(async (req, res) => {
    if (!notionService) {
      res.status(503).json({
        success: false,
        message: 'Notion service not available',
      });
      return;
    }

    const paramsSchema = z.object({
      customerId: z.string().min(1),
    });

    const { customerId } = paramsSchema.parse(req.params);

    try {
      logger.info(`[COVERAGE] Buscando paciente con Numero_Poliza (User_ID): "${customerId}"`);

      const patient = await notionService.findPatientByNumeroPoliza(customerId);
      logger.info(`[COVERAGE] Paciente: ${patient ? 'ENCONTRADO ✓' : 'NO ENCONTRADO ✗'}`);

      if (!patient) {
        res.status(404).json({
          success: false,
          message: `Paciente no encontrado con Numero_Poliza: "${customerId}"`,
        });
        return;
      }

      // Obtener el plan del paciente
      const plan = patient.planPageId ? await notionService.findPlanByPageId(patient.planPageId) : null;

      if (!plan) {
        res.status(404).json({
          success: false,
          message: 'Plan de seguro no encontrado',
        });
        return;
      }

      // Obtener todas las coberturas del plan
      const coveragesWithSpecialties = await notionService.getCoveragesByPlanPageId(plan.pageId);

      const coverageDetails: CoverageDetailRow[] = coveragesWithSpecialties.map((item) => ({
        idCobertura: item.idCobertura,
        especialidad: item.specialty?.nombre || 'General',
        copagoFijo: item.copagoFijo,
        coaseguroOverride: item.coaseguroOverride,
        cubierto: item.cubierto ?? true,
      }));

      const response: CoverageResponse = {
        customerId,
        numeroPoliza: customerId,
        nombreCompleto: patient.nombreCompleto,
        plan: {
          nombrePlan: plan.nombrePlan || 'Plan desconocido',
          aseguradora: plan.aseguradora || 'Aseguradora desconocida',
          tipoPlan: plan.tipoPlan || 'No especificado',
          deducibleAnual: plan.deducibleAnual,
          coaseguroPct: plan.coaseguroPct,
          maxBolsilloAnual: plan.maxBolsilloAnual,
        },
        coberturas: coverageDetails,
      };

      res.json({
        success: true,
        data: response,
      });
    } catch (error) {
      logger.error('Error fetching coverage:', error);
      res.status(500).json({
        success: false,
        message: 'Error al obtener coberturas del seguro',
      });
    }
  });

  return { createCustomer, getCoverage };
}
