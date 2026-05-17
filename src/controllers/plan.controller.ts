import type { RequestHandler } from 'express';
import { wrapAsync } from '../utils/async-handler';
import type { NotionService } from '../services/notion.service';

export function createPlanController(deps: { notionService: NotionService }): {
  listPlans: RequestHandler;
} {
  return {
    listPlans: wrapAsync(async (_req, res) => {
      const plans = await deps.notionService.getAllPlans();

      res.json({
        success: true,
        data: plans.map((p) => ({
          pageId: p.pageId,
          idPlan: p.idPlan,
          nombre: p.nombrePlan,
          aseguradora: p.aseguradora,
          tipoPlan: p.tipoPlan,
          deducibleAnual: p.deducibleAnual,
          coaseguroPct: p.coaseguroPct,
          maxBolsilloAnual: p.maxBolsilloAnual,
          activo: p.activo,
        })),
      });
    }),
  };
}
