import type { RequestHandler } from 'express';
import { z } from 'zod';
import { wrapAsync } from '../utils/async-handler';
import type { NotionService } from '../services/notion.service';
import type { BusinessService } from '../services/business.service';
import { logger } from '../utils/logger';
import {
  fetchNearbyHealthFacilitiesFromOsm,
  isNearAnyNotionHospital,
  osmPoiToHospitalRow,
} from '../services/osm-nearby-health.service';

export interface NearbyHospitalResponse {
  id: string;
  nombre: string;
  ciudad: string;
  nivelAtencion: string;
  activo: boolean;
  rating?: number;
  distancia?: number; // en km
  /** Registros devueltos desde la BD maestra HOSPITALES (Notion) = incluidos en el modelo con cobertura de red. */
  tieneCobertura?: boolean;
  /** Cartera/servicios cargados en maestro Notion (vacío si no existe la propiedad). */
  carteraServicios?: string[];
  /** Copago estimado si se envió `numeroPoliza` y el paciente existe en Notion. */
  copay?: number;
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

export function createHospitalController(
  notionService: NotionService,
  businessService: BusinessService,
): {
  getNearbyHospitals: RequestHandler;
  geocodeHospital: RequestHandler;
  geocodeMissing: RequestHandler;
} {
  return {
    getNearbyHospitals: wrapAsync(async (req, res) => {
      const querySchema = z.object({
        latitude: z.coerce.number().optional(),
        longitude: z.coerce.number().optional(),
        radius: z.coerce.number().optional().default(50), // km por defecto (solo si catalog=false)
        specialty: z.string().optional(),
        /** Póliza del paciente (mismo valor que customerId en chat) para estimar copago en el mapa. */
        numeroPoliza: z.string().optional(),
        /** true = todos los hospitales activos del maestro Notion (con cobertura); ordenados por distancia si hay GPS, sin filtro de radio */
        catalog: z.preprocess(
          (val) => val === true || val === 'true' || val === '1' || val === 'yes',
          z.boolean(),
        ),
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
          tieneCobertura: true as const,
          carteraServicios: Array.isArray(h.carteraServicios) ? h.carteraServicios : [],
        }));

        const activeHospitals = allHospitals.filter((h: any) => h.activo !== false);

        const userLat = query.latitude;
        const userLon = query.longitude;
        const hasUserGeo =
          typeof userLat === 'number' &&
          typeof userLon === 'number' &&
          Number.isFinite(userLat) &&
          Number.isFinite(userLon);

        const radiusKm = query.radius;
        const catalogMode = query.catalog === true;

        let filteredHospitals: NearbyHospitalResponse[] = [];

        const withDistance = (list: typeof activeHospitals) =>
          list.map((h: any) => {
            const hl = h.latitud;
            const ho = h.longitud;
            const hospitalGeoOk =
              typeof hl === 'number' &&
              typeof ho === 'number' &&
              Number.isFinite(hl) &&
              Number.isFinite(ho) &&
              !(Math.abs(hl) <= 1e-5 && Math.abs(ho) <= 1e-5);

            return {
              ...h,
              tieneCobertura: true,
              distancia:
                hasUserGeo && hospitalGeoOk ? calculateDistance(userLat, userLon, hl, ho) : undefined,
            };
          });

        if (catalogMode) {
          filteredHospitals = withDistance(activeHospitals).sort((a: any, b: any) => {
            const da = a.distancia ?? Number.POSITIVE_INFINITY;
            const db = b.distancia ?? Number.POSITIVE_INFINITY;
            return da - db;
          }) as NearbyHospitalResponse[];
        } else if (hasUserGeo) {
          const notionInRadius = withDistance(activeHospitals).filter(
            (h: any) =>
              typeof h.distancia === 'number' &&
              Number.isFinite(h.distancia) &&
              h.distancia <= radiusKm,
          );

          const notionCoordsForDedup = notionInRadius
            .filter(
              (h: any) =>
                typeof h.latitud === 'number' &&
                typeof h.longitud === 'number' &&
                Number.isFinite(h.latitud) &&
                Number.isFinite(h.longitud),
            )
            .map((h: any) => ({ lat: h.latitud as number, lon: h.longitud as number }));

          let extras: Record<string, unknown>[] = [];
          try {
            const osmPois = await fetchNearbyHealthFacilitiesFromOsm(userLat!, userLon!, radiusKm);
            for (const poi of osmPois) {
              if (isNearAnyNotionHospital(poi.lat, poi.lon, notionCoordsForDedup)) continue;
              extras.push(osmPoiToHospitalRow(poi, userLat!, userLon!));
            }
          } catch (osmErr) {
            logger.warn('OpenStreetMap (Overpass) no disponible; solo hospitales Notion en radio.', osmErr);
          }

          filteredHospitals = [...notionInRadius, ...(extras as unknown as NearbyHospitalResponse[])].sort(
            (a: any, b: any) => (a.distancia ?? 0) - (b.distancia ?? 0),
          ) as NearbyHospitalResponse[];
        } else {
          filteredHospitals = activeHospitals
            .map((h: any) => ({
              ...h,
              tieneCobertura: true,
              distancia: undefined,
            }))
            .sort((a: any, b: any) =>
              String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es'),
            ) as NearbyHospitalResponse[];
        }

        const polizaMap = query.numeroPoliza?.trim();
        if (polizaMap && filteredHospitals.length > 0) {
          filteredHospitals = (await businessService.enrichNearbyRowsWithEstimatedCopay(
            polizaMap,
            filteredHospitals as unknown as Record<string, unknown>[],
          )) as unknown as NearbyHospitalResponse[];
        }

        res.json({
          success: true,
          data: {
            hospitales: filteredHospitals,
            total: filteredHospitals.length,
            radio: catalogMode ? null : radiusKm,
            catalog: catalogMode,
            /** Lista mixta: Notion (con cobertura) + OSM en radio (sin cobertura del plan). */
            mixedNearby: !catalogMode && hasUserGeo,
            ubicacion: hasUserGeo ? { lat: userLat, lon: userLon } : null,
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
