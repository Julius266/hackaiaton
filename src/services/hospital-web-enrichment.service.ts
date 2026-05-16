import { env } from '../config/env';
import type { HospitalWebEnrichment } from '../types/business.types';
import { logger } from '../utils/logger';

const AVISO_LEGAL_ENRIQUECIMIENTO_WEB =
  'Estos fragmentos provienen de búsqueda web automática (una o dos fuentes: Tavily y/o Google vía Serper), orientada a la cartera de servicios o especialidades públicas del hospital; pueden estar incompletos, ser genéricos o desactualizados. No confirman cobertura de tu plan ni disponibilidad real; verifica siempre con el hospital y tu aseguradora.';

const MAX_FRAGMENTOS = 5;
const MAX_TEXTO_POR_FRAGMENTO = 420;
const FETCH_MS = 14_000;
/** Límite de búsquedas por enriquecimiento (cada una consume cuota API; advanced cuesta más). */
const MAX_QUERIES_PER_ENRICHMENT = 3;

function trunc(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function mergeFragmentosUnique(
  batches: HospitalWebEnrichment['fragmentos'][],
  max: number,
): HospitalWebEnrichment['fragmentos'] {
  const seen = new Set<string>();
  const out: HospitalWebEnrichment['fragmentos'] = [];
  for (const batch of batches) {
    for (const f of batch) {
      if (seen.has(f.url)) continue;
      seen.add(f.url);
      out.push(f);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * Varias consultas orientadas a encontrar la cartera / catálogo de servicios del hospital recomendado
 * (términos habituales en sitios de hospitales en español).
 */
function buildPortfolioWebQueries(input: {
  nombre: string;
  ciudad?: string;
  direccion?: string;
  especialidadInteres?: string;
}): string[] {
  const nombre = input.nombre.trim();
  const ciudad = input.ciudad?.trim();
  const baseLoc = [nombre, ciudad].filter(Boolean).join(' ');

  const queries: string[] = [
    `${baseLoc} cartera de servicios hospital especialidades médicas`,
    `${baseLoc} servicios hospitalarios lista especialidades consultorio`,
    `${baseLoc} hospital directorio médico especialidades servicios`,
  ];

  const esp = input.especialidadInteres?.trim();
  if (esp && esp.length >= 2) {
    queries.unshift(`${baseLoc} hospital servicios "${esp}" especialidad cartera`);
  }

  if (input.direccion?.trim()) {
    queries.push(`${nombre} ${input.direccion.trim()} servicios médicos hospital`);
  }

  return [...new Set(queries.map((q) => q.replace(/\s+/g, ' ').trim()).filter((q) => q.length > 3))];
}

async function tavilySearch(
  query: string,
  apiKey: string,
  opts?: { search_depth?: 'basic' | 'advanced'; max_results?: number },
): Promise<HospitalWebEnrichment['fragmentos'] | null> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: opts?.search_depth ?? 'advanced',
      max_results: opts?.max_results ?? MAX_FRAGMENTOS,
      include_answer: false,
    }),
    signal: AbortSignal.timeout(FETCH_MS),
  });
  if (!res.ok) {
    logger.warn(`Tavily HTTP ${res.status}`);
    return null;
  }
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const rows = data.results ?? [];
  const fragmentos = rows
    .map((r) => ({
      titulo: typeof r.title === 'string' ? r.title : undefined,
      url: typeof r.url === 'string' ? r.url : '',
      texto: trunc(typeof r.content === 'string' ? r.content : '', MAX_TEXTO_POR_FRAGMENTO),
    }))
    .filter((f) => f.url.length > 0 && f.texto.length > 0);
  return fragmentos.length > 0 ? fragmentos : null;
}

function mergeTavilyThenSerper(
  tavily: HospitalWebEnrichment['fragmentos'] | null | undefined,
  serper: HospitalWebEnrichment['fragmentos'] | null | undefined,
  max: number,
): HospitalWebEnrichment['fragmentos'] {
  const batches: HospitalWebEnrichment['fragmentos'][] = [];
  if (tavily?.length) batches.push(tavily);
  if (serper?.length) batches.push(serper);
  return mergeFragmentosUnique(batches, max);
}

function resolveProveedor(
  tavily: HospitalWebEnrichment['fragmentos'] | null | undefined,
  serper: HospitalWebEnrichment['fragmentos'] | null | undefined,
): HospitalWebEnrichment['proveedor'] | null {
  const hasT = Boolean(tavily?.length);
  const hasS = Boolean(serper?.length);
  if (hasT && hasS) return 'tavily_serper';
  if (hasT) return 'tavily';
  if (hasS) return 'serper';
  return null;
}

async function tavilyPortfolioSearch(queries: string[], apiKey: string): Promise<HospitalWebEnrichment['fragmentos'] | null> {
  const batches: HospitalWebEnrichment['fragmentos'][] = [];
  for (const query of queries) {
    const mergedSoFar = mergeFragmentosUnique(batches, MAX_FRAGMENTOS);
    if (mergedSoFar.length >= MAX_FRAGMENTOS) break;
    const fragmentos = await tavilySearch(query, apiKey, {
      search_depth: 'advanced',
      max_results: MAX_FRAGMENTOS,
    });
    if (fragmentos?.length) batches.push(fragmentos);
  }
  const merged = mergeFragmentosUnique(batches, MAX_FRAGMENTOS);
  return merged.length > 0 ? merged : null;
}

async function serperSearch(query: string, apiKey: string): Promise<HospitalWebEnrichment['fragmentos'] | null> {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify({ q: query, num: MAX_FRAGMENTOS }),
    signal: AbortSignal.timeout(FETCH_MS),
  });
  if (!res.ok) {
    logger.warn(`Serper HTTP ${res.status}`);
    return null;
  }
  const data = (await res.json()) as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>;
  };
  const rows = data.organic ?? [];
  const fragmentos = rows
    .map((r) => ({
      titulo: typeof r.title === 'string' ? r.title : undefined,
      url: typeof r.link === 'string' ? r.link : '',
      texto: trunc(typeof r.snippet === 'string' ? r.snippet : '', MAX_TEXTO_POR_FRAGMENTO),
    }))
    .filter((f) => f.url.length > 0 && f.texto.length > 0);
  return fragmentos.length > 0 ? fragmentos : null;
}

async function serperPortfolioSearch(queries: string[], apiKey: string): Promise<HospitalWebEnrichment['fragmentos'] | null> {
  const batches: HospitalWebEnrichment['fragmentos'][] = [];
  for (const query of queries) {
    const mergedSoFar = mergeFragmentosUnique(batches, MAX_FRAGMENTOS);
    if (mergedSoFar.length >= MAX_FRAGMENTOS) break;
    const fragmentos = await serperSearch(query, apiKey);
    if (fragmentos?.length) batches.push(fragmentos);
  }
  const merged = mergeFragmentosUnique(batches, MAX_FRAGMENTOS);
  return merged.length > 0 ? merged : null;
}

/**
 * Tavily como motor principal; **Serper** (Google) refuerza con resultados adicionales deduplicados por URL.
 * Requiere al menos una de `TAVILY_API_KEY` o `SERPER_API_KEY`.
 */
export async function enrichHospitalFromWeb(input: {
  nombre: string;
  ciudad?: string;
  direccion?: string;
  /** Especialidad pedida o inferida (opcional); refina la búsqueda de cartera en web. */
  especialidadInteres?: string;
}): Promise<HospitalWebEnrichment | null> {
  const nombre = input.nombre?.trim();
  if (!nombre) return null;

  const queries = buildPortfolioWebQueries({
    nombre,
    ciudad: input.ciudad,
    direccion: input.direccion,
    especialidadInteres: input.especialidadInteres,
  }).slice(0, MAX_QUERIES_PER_ENRICHMENT);
  const consulta = queries.join(' · ');

  const tavilyKey = env.TAVILY_API_KEY?.trim();
  const serperKey = env.SERPER_API_KEY?.trim();
  if (!tavilyKey && !serperKey) {
    logger.warn('enrichHospitalFromWeb: falta TAVILY_API_KEY y SERPER_API_KEY');
    return null;
  }

  try {
    let tFrag: HospitalWebEnrichment['fragmentos'] | null = null;
    let sFrag: HospitalWebEnrichment['fragmentos'] | null = null;

    if (tavilyKey) {
      tFrag = await tavilyPortfolioSearch(queries, tavilyKey);
    }
    if (serperKey) {
      sFrag = await serperPortfolioSearch(queries, serperKey);
    }

    const fragmentos = mergeTavilyThenSerper(tFrag, sFrag, MAX_FRAGMENTOS);
    const proveedor = resolveProveedor(tFrag, sFrag);
    if (fragmentos.length > 0 && proveedor) {
      return {
        fuente: 'web_search',
        proveedor,
        consulta,
        fragmentos,
        avisoLegal: AVISO_LEGAL_ENRIQUECIMIENTO_WEB,
      };
    }
  } catch (err) {
    logger.warn('enrichHospitalFromWeb falló', err);
  }

  return null;
}
