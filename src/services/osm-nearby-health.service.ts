/** Separación máx. entre punto OSM y coords Notion para considerar el mismo lugar (evitar duplicados). */
export const OSM_NOTION_DEDUP_KM = 0.45;

/** Máximo de POIs OSM extra tras filtrar por radio (protege respuesta y Overpass). */
export const OSM_MAX_RESULTS = 120;

export interface OsmHealthPoi {
  osmType: 'node' | 'way' | 'relation';
  osmId: number;
  lat: number;
  lon: number;
  name: string;
  tags: Record<string, string>;
}

function bboxFromRadiusKm(lat: number, lon: number, radiusKm: number) {
  const R = 6371;
  const latRad = (lat * Math.PI) / 180;
  const deltaLat = ((radiusKm / R) * 180) / Math.PI;
  const cosLat = Math.cos(latRad);
  const deltaLon = cosLat > 1e-6 ? ((radiusKm / (R * cosLat)) * 180) / Math.PI : deltaLat * 2;
  return {
    south: lat - deltaLat,
    north: lat + deltaLat,
    west: lon - deltaLon,
    east: lon + deltaLon,
  };
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Hospitales / clínicas cercanos según OpenStreetMap (sin cobertura del plan por sí mismo).
 * Usa API pública Overpass; puede fallar por rate limit — el caller debe hacer fallback.
 */
export async function fetchNearbyHealthFacilitiesFromOsm(
  lat: number,
  lon: number,
  radiusKm: number,
  overpassUrl = 'https://overpass-api.de/api/interpreter',
): Promise<OsmHealthPoi[]> {
  const { south, west, north, east } = bboxFromRadiusKm(lat, lon, radiusKm);

  const query = `
[out:json][timeout:25];
(
  node["amenity"="hospital"](${south},${west},${north},${east});
  node["amenity"="clinic"](${south},${west},${north},${east});
  way["amenity"="hospital"](${south},${west},${north},${east});
  way["amenity"="clinic"](${south},${west},${north},${east});
  node["healthcare"="hospital"](${south},${west},${north},${east});
  node["healthcare"="clinic"](${south},${west},${north},${east});
  way["healthcare"="hospital"](${south},${west},${north},${east});
  way["healthcare"="clinic"](${south},${west},${north},${east});
);
out center;
`.trim();

  const res = await fetch(overpassUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Hackiathon-HealthNearby/1.0',
    },
    body: `data=${encodeURIComponent(query)}`,
  });

  if (!res.ok) {
    throw new Error(`Overpass HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    elements?: Array<{
      type: string;
      id: number;
      lat?: number;
      lon?: number;
      center?: { lat: number; lon: number };
      tags?: Record<string, string>;
    }>;
  };

  const out: OsmHealthPoi[] = [];

  for (const el of data.elements ?? []) {
    let plat: number | undefined;
    let plon: number | undefined;
    if (el.type === 'node' && typeof el.lat === 'number' && typeof el.lon === 'number') {
      plat = el.lat;
      plon = el.lon;
    } else if (el.center && typeof el.center.lat === 'number' && typeof el.center.lon === 'number') {
      plat = el.center.lat;
      plon = el.center.lon;
    }
    if (plat === undefined || plon === undefined) continue;

    const d = haversineKm(lat, lon, plat, plon);
    if (d > radiusKm) continue;

    const tags = el.tags ?? {};
    const name =
      tags.name ||
      tags['name:es'] ||
      tags['official_name'] ||
      tags.operator ||
      'Centro de salud';

    out.push({
      osmType: el.type as 'node' | 'way' | 'relation',
      osmId: el.id,
      lat: plat,
      lon: plon,
      name: String(name).trim(),
      tags,
    });
  }

  out.sort((a, b) => haversineKm(lat, lon, a.lat, a.lon) - haversineKm(lat, lon, b.lat, b.lon));
  return out.slice(0, OSM_MAX_RESULTS);
}

export function osmPoiToHospitalRow(
  poi: OsmHealthPoi,
  userLat: number,
  userLon: number,
): Record<string, unknown> {
  const t = poi.tags;
  const street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ').trim();
  const direccion = street || t['addr:full'] || t['addr:place'] || '';
  const ciudad = t['addr:city'] || t['addr:town'] || t['addr:district'] || t['addr:state'] || '';

  return {
    id: `osm-${poi.osmType}-${poi.osmId}`,
    nombre: poi.name,
    ciudad: ciudad || '—',
    nivelAtencion: 'OSM / consulta externa',
    activo: true,
    rating: Math.random() * 2 + 3.2,
    latitud: poi.lat,
    longitud: poi.lon,
    direccion: direccion || undefined,
    telefono: t.phone || t['contact:phone'] || undefined,
    tieneCobertura: false,
    distancia: haversineKm(userLat, userLon, poi.lat, poi.lon),
    fuente: 'openstreetmap',
    carteraServicios: [] as string[],
  };
}

export function isNearAnyNotionHospital(
  poiLat: number,
  poiLon: number,
  notionCoords: Array<{ lat: number; lon: number }>,
  maxKm = OSM_NOTION_DEDUP_KM,
): boolean {
  for (const p of notionCoords) {
    if (haversineKm(poiLat, poiLon, p.lat, p.lon) <= maxKm) return true;
  }
  return false;
}
