import { Router } from 'express';
import type { NotionService } from '../services/notion.service';
import type { BusinessService } from '../services/business.service';
import { createHospitalController } from '../controllers/hospital.controller';

export function createHospitalRouter(notionService: NotionService, businessService: BusinessService): Router {
  const router = Router();
  const controller = createHospitalController(notionService, businessService);

  /**
   * GET /hospital/nearby?latitude=X&longitude=Y&radius=50
   * Obtiene hospitales cercanos a una ubicación
   */
  router.get('/nearby', controller.getNearbyHospitals);

  /** POST /hospital/:pageId/geocode -> Geocodifica y guarda coords en Notion */
  router.post('/:pageId/geocode', controller.geocodeHospital);

  /** POST /hospital/geocode/missing -> Geocodifica hospitales sin coords */
  router.post('/geocode/missing', controller.geocodeMissing);

  return router;
}
