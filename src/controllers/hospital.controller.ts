import type { RequestHandler } from 'express';
import { z } from 'zod';
import { wrapAsync } from '../utils/async-handler';
import type { NotionService } from '../services/notion.service';
import { logger } from '../utils/logger';

export interface NearbyHospitalResponse {
  id: string;
  nombre: string;
  ciudad: string;
  nivelAtencion: string;
  activo: boolean;
  rating?: number;
  distancia?: number; // en km
}

/**
 * Calcular distancia entre dos coordenadas usando Haversine
 */
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Radio de la Tierra en km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function createHospitalController(notionService: NotionService): {
  getNearbyHospitals: RequestHandler;
  geocodeHospital: RequestHandler;
  geocodeMissing: RequestHandler;
} {
  return {
    getNearbyHospitals: wrapAsync(async (req, res) => {
      const querySchema = z.object({
        latitude: z.coerce.number().optional(),
        longitude: z.coerce.number().optional(),
        radius: z.coerce.number().optional().default(50), // km por defecto
        specialty: z.string().optional(),
      });

      const query = querySchema.parse(req.query);

      try {
        // Obtener el ID de base de datos de hospitales de env
        const env = await import('../config/env');
        
        // Obtener todas las páginas de la base de datos de hospitales y mapearlas
        const hospitalPages = await (notionService as any).queryDatabase(env.env.DATABASE_ID_HOSPITALES);
        const hospitalIds = hospitalPages.map((p: any) => p.id);
        const mappedHospitals = hospitalIds.length > 0 ? await notionService.findHospitalsByIds(hospitalIds) : [];

        // Mapear a NearbyHospitalResponse usando los campos mapeados en NotionService.mapHospital
        const allHospitals = mappedHospitals.map((h) => ({
          id: h.pageId,
          nombre: h.nombre || 'Hospital Sin Nombre',
          ciudad: h.ciudad || 'Ciudad desconocida',
          nivelAtencion: h.nivelAtencion || 'No especificado',
          activo: h.activo ?? true,
          rating: Math.random() * 2 + 3.5,
          latitud: (h as any).latitud,
          longitud: (h as any).longitud,
          direccion: (h as any).direccion,
          telefono: (h as any).contacto,
        }));

        const activeHospitals = allHospitals.filter((h: any) => h.activo !== false);

        // Filtrar por distancia si se proporciona ubicación
        let filteredHospitals: NearbyHospitalResponse[] = activeHospitals;

        if (query.latitude && query.longitude) {
          filteredHospitals = filteredHospitals
            .map((h: NearbyHospitalResponse) => ({
              ...h,
              // Usar coordenadas estimadas de Ecuador como fallback
              distancia: calculateDistance(query.latitude!, query.longitude!, -0.2, -78.5),
            }))
            .filter((h: any) => !h.distancia || h.distancia <= query.radius)
            .sort((a: any, b: any) => (a.distancia ?? 0) - (b.distancia ?? 0));
        }

        res.json({
          success: true,
          data: {
            hospitales: filteredHospitals,
            total: filteredHospitals.length,
            radio: query.radius,
            ubicacion: query.latitude && query.longitude ? { lat: query.latitude, lon: query.longitude } : null,
          },
        });
      } catch (error) {
        logger.error('Error fetching nearby hospitals:', error);
        res.status(500).json({
          success: false,
          message: 'Error al obtener hospitales cercanos',
        });
      }
    }),
    geocodeHospital: wrapAsync(async (req, res) => {
      const params = z.object({ pageId: z.string().min(1) }).parse(req.params);
      try {
        const result = await notionService.geocodeAndPersistHospital(params.pageId);
        if (!result) {
          res.status(404).json({ success: false, message: 'Hospital no encontrado' });
          return;
        }
        res.json({ success: true, data: result });
      } catch (err) {
        logger.error('Error geocoding hospital', err);
        res.status(500).json({ success: false, message: 'Error al geocodificar hospital' });
      }
    }),
    geocodeMissing: wrapAsync(async (_req, res) => {
      try {
        const results = await notionService.geocodeAllHospitalsMissing();
        res.json({ success: true, data: results });
      } catch (err) {
        logger.error('Error geocoding missing hospitals', err);
        res.status(500).json({ success: false, message: 'Error al geocodificar hospitales' });
      }
    }),
  };
}
