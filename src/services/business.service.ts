import type { ChatProgressPhase } from '../types/chat-progress.types';
import type { BusinessData, BusinessInput, CoverageEstimate, HospitalCandidate, HospitalWebEnrichment } from '../types/business.types';
import type { CoverageRecord, HospitalNetworkRecord, PatientRecord, PlanRecord, SpecialtyRecord } from '../types/notion-model.types';
import { haversineKm } from '../utils/geo';
import { clampNumber, roundCurrency } from '../utils/json';
import { enrichHospitalFromWeb } from './hospital-web-enrichment.service';
import {
  fetchNearbyHealthFacilitiesFromOsm,
  isNearAnyNotionHospital,
  osmPoiToHospitalRow,
} from './osm-nearby-health.service';
import type { NotionService } from './notion.service';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/** Radio coherente con GET /hospital/nearby sin modo catálogo. */
const NEARBY_RADIUS_KM_CHAT = 50;
/** Tope de centros enviados al cliente (el chat muestra solo los primeros). */
const MAX_HOSPITALS_IN_RESPONSE = 40;

function osmRowToHospitalCandidate(row: Record<string, unknown>): HospitalCandidate {
  const id = String(row.id ?? 'osm-unknown');
  const dist = typeof row.distancia === 'number' ? row.distancia : undefined;
  return {
    pageId: id,
    idHospital: id,
    nombre: typeof row.nombre === 'string' ? row.nombre : 'Centro de salud',
    ciudad: typeof row.ciudad === 'string' ? row.ciudad : '—',
    nivelAtencion: typeof row.nivelAtencion === 'string' ? row.nivelAtencion : 'Mapa abierto (OSM)',
    latitud: typeof row.latitud === 'number' ? row.latitud : undefined,
    longitud: typeof row.longitud === 'number' ? row.longitud : undefined,
    direccion: typeof row.direccion === 'string' ? row.direccion : undefined,
    contacto: typeof row.telefono === 'string' ? row.telefono : undefined,
    distanceKm: dist,
    inNetwork: false,
    estimatedCopay: undefined,
    portfolioForPlan: [],
    especialidadesRed: [],
    score: typeof row.rating === 'number' ? row.rating : 45,
    activo: true,
    raw: { fuente: 'openstreetmap' },
  };
}

export const ESTIMATION_LEGAL_NOTICE_ES =
  'Los montos son estimaciones informativas según los datos del plan en el sistema; no constituyen garantía de cobro. El copago y la cobertura definitivos los confirman la aseguradora y el prestador al momento del servicio.';

function normalizeSpecialtyName(value: string): string {
  return value.trim().toLowerCase();
}

function mapHospitalNetwork(record: HospitalNetworkRecord): HospitalCandidate {
  const nombre = typeof record.raw.Nombre === 'string' ? record.raw.Nombre : undefined;
  const ciudad = typeof record.raw.Ciudad === 'string' ? record.raw.Ciudad : undefined;
  const nivelAtencion = typeof record.raw.Nivel_Atencion === 'string' ? record.raw.Nivel_Atencion : undefined;

  return {
    pageId: record.hospital?.pageId ?? record.hospitalPageId ?? record.pageId,
    idHospital: record.hospital?.idHospital ?? record.hospitalPageId ?? record.idRed,
    nombre: record.hospital?.nombre ?? nombre,
    ciudad: record.hospital?.ciudad ?? ciudad,
    nivelAtencion: record.hospital?.nivelAtencion ?? nivelAtencion,
    activo: record.hospital?.activo,
    tarifaBase: record.tarifaBase,
    latitud: record.hospital?.latitud as number | undefined,
    longitud: record.hospital?.longitud as number | undefined,
    direccion: record.hospital?.direccion as string | undefined,
    contacto: record.hospital?.contacto as string | undefined,
    carteraServicios: record.hospital?.carteraServicios,
    score: typeof record.tarifaBase === 'number' ? 100 - Math.min(record.tarifaBase / 10, 45) : 50,
    raw: record.raw,
  };
}

function readLocationHints(customerContext: Record<string, unknown>): {
  userLatitude?: number;
  userLongitude?: number;
  userCity?: string;
} {
  const latRaw = customerContext.latitude ?? customerContext.latitud;
  const lonRaw = customerContext.longitude ?? customerContext.longitud;
  const lat = typeof latRaw === 'number' ? latRaw : typeof latRaw === 'string' ? Number(latRaw) : NaN;
  const lon = typeof lonRaw === 'number' ? lonRaw : typeof lonRaw === 'string' ? Number(lonRaw) : NaN;
  const city = customerContext.city;
  return {
    userLatitude: Number.isFinite(lat) ? lat : undefined,
    userLongitude: Number.isFinite(lon) ? lon : undefined,
    userCity: typeof city === 'string' && city.trim() ? city.trim() : undefined,
  };
}

function normEspHospital(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

/** Variantes ES/EN alineadas con la detección del frontend en tarjetas de chat. */
function specialtyNeedleVariantsHospital(needle: string): string[] {
  const n = normEspHospital(needle);
  const out = new Set<string>();
  if (n.length >= 3) out.add(n);
  const groups = [
    ['neurology', 'neurologia', 'neuro'],
    ['cardiology', 'cardiologia', 'cardio'],
    ['dermatology', 'dermatologia'],
    ['gynecology', 'ginecologia', 'obstetricia'],
    ['pediatrics', 'pediatria'],
    ['orthopedics', 'ortopedia', 'traumatologia'],
    ['psychiatry', 'psiquiatria'],
    ['ophthalmology', 'oftalmologia'],
    ['urology', 'urologia'],
    ['endocrinology', 'endocrinologia'],
    ['gastroenterology', 'gastroenterologia'],
    ['pulmonology', 'neumologia', 'pulmonologia'],
    ['nephrology', 'nefrologia'],
    ['rheumatology', 'reumatologia'],
    ['oncology', 'oncologia'],
    ['general', 'medicina general', 'medicina familiar'],
  ];
  for (const g of groups) {
    const gn = g.map(normEspHospital).filter((x) => x.length >= 3);
    if (gn.some((x) => n.includes(x) || x.includes(n))) gn.forEach((x) => out.add(x));
  }
  return [...out];
}

function hospitalDeclaresUserSpecialtyCandidate(h: HospitalCandidate, needle: string): boolean {
  const needles = specialtyNeedleVariantsHospital(needle);
  if (needles.length === 0) return false;
  const merged = [
    ...new Set([...(h.especialidadesRed ?? []), ...(h.portfolioForPlan ?? []), ...(h.carteraServicios ?? [])]),
  ];
  return merged.some((p) => {
    const x = normEspHospital(p);
    if (x.length < 3) return false;
    return needles.some((nn) => x.includes(nn) || nn.includes(x));
  });
}

function hospitalCandidateKey(h: Pick<HospitalCandidate, 'pageId' | 'idHospital'>): string {
  return String(h.pageId || h.idHospital || '');
}

/** Prioriza el hospital recomendado como primera fila en chat/listas mixtas. */
function promoteHospitalToFront(list: HospitalCandidate[], hospital: HospitalCandidate | null): HospitalCandidate[] {
  if (!hospital || list.length < 2) return list;
  const hk = hospitalCandidateKey(hospital);
  if (!hk) return list;
  const idx = list.findIndex((h) => hospitalCandidateKey(h) === hk);
  if (idx <= 0) return list;
  const copy = [...list];
  const [row] = copy.splice(idx, 1);
  copy.unshift(row);
  return copy;
}

export class BusinessService {
  constructor(private readonly notionService: NotionService) {}

  public async fetchBusinessData(input: BusinessInput): Promise<BusinessData> {
    const report = (phase: ChatProgressPhase, label: string, detail?: string) => {
      input.onChatProgress?.({ phase, label, detail });
    };

    report('patient_plan', 'Buscando tu póliza y plan en el sistema…');
    const patient = await this.notionService.findPatientByNumeroPolizaOrPageId(input.numeroPoliza);
    const plan = patient?.planPageId ? await this.notionService.findPlanByPageId(patient.planPageId) : null;
    report(
      'patient_plan',
      patient ? `Paciente y plan localizados${plan?.nombrePlan ? `: ${plan.nombrePlan}` : ''}.` : 'No hay ficha de paciente para esa póliza; seguimos con reglas generales.',
    );

    report('specialty_coverage', 'Relacionando especialidad con tablas de cobertura…');
    const symptomSpecialty = await this.notionService.findSpecialtyByValue(input.analysis.specialty);
    const priority = input.analysis.priority;
    const primaryCareFirst = priority !== 'urgent' && priority !== 'high';

    let specialtyForLookup: SpecialtyRecord | null = symptomSpecialty;
    if (primaryCareFirst) {
      const primary = await this.notionService.findPrimaryCareSpecialty();
      if (primary) specialtyForLookup = primary;
    }

    const coverageRecord =
      plan && specialtyForLookup ? await this.notionService.findCoverageByPlanAndSpecialty(plan.pageId, specialtyForLookup.pageId) : null;
    report(
      'specialty_coverage',
      specialtyForLookup
        ? `Cobertura en red para «${specialtyForLookup.nombre ?? specialtyForLookup.idEspecialidad}»${coverageRecord ? ' encontrada.' : ': sin fila específica; usamos defaults del plan.'}`
        : 'Sin especialidad enlazada en base; no hay cobertura por especialidad.',
    );

    report('hospital_network', 'Consultando hospitales de la red para tu plan…');
    const hospitalsNetwork =
      plan && specialtyForLookup ? await this.notionService.findHospitalsBySpecialtyAndPlan(plan.pageId, specialtyForLookup.pageId) : [];
    const hospitalsRaw = hospitalsNetwork.map(mapHospitalNetwork);
    report(
      'hospital_network',
      hospitalsRaw.length ? `${hospitalsRaw.length} centro(s) en red para esta especialidad.` : 'Ningún hospital en red para esta combinación plan + especialidad.',
    );

    const loc = readLocationHints(input.customerContext);
    const deductibleRestante = patient?.deducibleRestante;
    const coveragePercent = this.computeCoveragePercent(plan, coverageRecord);
    const copagoFijo = coverageRecord?.copagoFijo ?? 0;

    report('economics', 'Calculando copagos estimados y distancia (si hay ubicación)…');
    const hospitalsEconomicosBase = this.enrichHospitalsWithEconomics(
      hospitalsRaw,
      specialtyForLookup,
      priority,
      coveragePercent,
      copagoFijo,
      deductibleRestante,
      coverageRecord,
      loc,
    );

    report('hospital_portfolio', 'Cargando cartera de servicios por hospital (red + maestro)…');
    const specialtiesByHospital =
      plan?.pageId ? await this.notionService.findHospitalSpecialtiesByPlan(plan.pageId) : new Map<string, string[]>();

    const hospitalsEconomicos = hospitalsEconomicosBase.map((h) => {
      const redList = h.pageId ? specialtiesByHospital.get(h.pageId) ?? [] : [];
      const master = h.carteraServicios ?? [];
      const portfolioForPlan = [...new Set([...redList, ...master])].sort((a, b) => a.localeCompare(b, 'es'));
      return { ...h, especialidadesRed: redList, portfolioForPlan };
    });

    const userSpecialtyNeedle = (
      symptomSpecialty?.nombre ??
      symptomSpecialty?.idEspecialidad ??
      input.analysis.specialty ??
      ''
    ).trim();

    const inNetworkMatchingUserSpecialty =
      userSpecialtyNeedle.length >= 3
        ? hospitalsEconomicos.filter((h) => hospitalDeclaresUserSpecialtyCandidate(h, userSpecialtyNeedle))
        : [];

    const recommendedHospital =
      inNetworkMatchingUserSpecialty.length > 0 ? inNetworkMatchingUserSpecialty[0] : hospitalsEconomicos[0] ?? null;

    const recommendedMatchesUserSpecialtyRequest =
      inNetworkMatchingUserSpecialty.length > 0 && recommendedHospital != null;

    const networkTagged = hospitalsEconomicos.map((h) => ({ ...h, inNetwork: true as boolean }));
    let hospitalsForResponse: HospitalCandidate[] = networkTagged;
    let mixedNearbyWithOsm = false;

    if (
      loc.userLatitude != null &&
      loc.userLongitude != null &&
      Number.isFinite(loc.userLatitude) &&
      Number.isFinite(loc.userLongitude)
    ) {
      report('nearby_osm', 'Incluyendo centros cercanos fuera de tu red (OpenStreetMap)…');
      const notionCoords = hospitalsEconomicos
        .filter((h) => typeof h.latitud === 'number' && typeof h.longitud === 'number')
        .map((h) => ({ lat: h.latitud as number, lon: h.longitud as number }));

      const extras: HospitalCandidate[] = [];
      try {
        const osmPois = await fetchNearbyHealthFacilitiesFromOsm(loc.userLatitude, loc.userLongitude, NEARBY_RADIUS_KM_CHAT);
        for (const poi of osmPois) {
          if (isNearAnyNotionHospital(poi.lat, poi.lon, notionCoords)) continue;
          extras.push(osmRowToHospitalCandidate(osmPoiToHospitalRow(poi, loc.userLatitude, loc.userLongitude)));
        }
      } catch (err) {
        logger.warn(`OpenStreetMap no disponible para el chat: ${(err as Error).message}`);
      }

      if (extras.length > 0) {
        mixedNearbyWithOsm = true;
        hospitalsForResponse = [...networkTagged, ...extras];
        hospitalsForResponse.sort((a, b) => {
          const da = a.distanceKm ?? Number.POSITIVE_INFINITY;
          const db = b.distanceKm ?? Number.POSITIVE_INFINITY;
          if (Math.abs(da - db) > 0.08) return da - db;
          if (Boolean(a.inNetwork) !== Boolean(b.inNetwork)) return a.inNetwork ? -1 : 1;
          const ca = a.estimatedCopay ?? Number.POSITIVE_INFINITY;
          const cb = b.estimatedCopay ?? Number.POSITIVE_INFINITY;
          return ca - cb;
        });
      }
    }

    hospitalsForResponse = promoteHospitalToFront(hospitalsForResponse, recommendedHospital);
    if (mixedNearbyWithOsm) {
      hospitalsForResponse = hospitalsForResponse.slice(0, MAX_HOSPITALS_IN_RESPONSE);
    }

    const coverage = this.buildCoverageEstimateForRecommendation({
      patient,
      plan,
      specialty: specialtyForLookup,
      coverageRecord,
      priority,
      customerContext: input.customerContext,
      coveragePercent,
      recommendedHospital,
      deductibleRestante,
    });

    const symptomSuggestedSpecialty =
      symptomSpecialty != null
        ? {
            pageId: symptomSpecialty.pageId,
            idEspecialidad: symptomSpecialty.idEspecialidad,
            nombre: symptomSpecialty.nombre,
          }
        : input.analysis.specialty
          ? { pageId: '', idEspecialidad: '', nombre: input.analysis.specialty }
          : null;

    const recommendedHospitalSpecialties =
      recommendedHospital?.pageId != null ? specialtiesByHospital.get(recommendedHospital.pageId) ?? [] : [];
    const recommendedHospitalServicios = recommendedHospital?.carteraServicios ?? [];
    const recommendedHospitalPortfolio = recommendedHospital?.portfolioForPlan ?? [];

    const enrichmentSpecialty = (
      userSpecialtyNeedle.length >= 3
        ? userSpecialtyNeedle
        : (specialtyForLookup?.nombre ?? specialtyForLookup?.idEspecialidad ?? input.analysis.specialty ?? '')
    ).trim();

    let hospitalWebEnrichment: HospitalWebEnrichment | null = null;
    const tavilyConfigured = Boolean(env.TAVILY_API_KEY?.trim());
    const serperConfigured = Boolean(env.SERPER_API_KEY?.trim());
    const webSearchConfigured = tavilyConfigured || serperConfigured;
    const debeConsultarWeb = Boolean(recommendedHospital) && webSearchConfigured;

    if (recommendedHospital && env.CHAT_STRICT_TAVILY && !tavilyConfigured) {
      throw new Error(
        'TAVILY_API_KEY es obligatoria cuando CHAT_STRICT_TAVILY está activo. Añade la clave o desactiva CHAT_STRICT_TAVILY.',
      );
    }

    if (recommendedHospital && !webSearchConfigured) {
      const msg =
        'Ni TAVILY_API_KEY ni SERPER_API_KEY están configuradas: no habrá enriquecimiento web para el hospital recomendado.';
      logger.warn(msg);
      report('web_enrichment', msg, recommendedHospital.nombre ?? recommendedHospital.idHospital);
    }

    if (recommendedHospital && !tavilyConfigured && webSearchConfigured) {
      const msg =
        'TAVILY_API_KEY no configurada: el enriquecimiento web usará solo Serper (Google). Se recomienda definir también Tavily como fuente principal.';
      logger.warn(msg);
      report('web_enrichment', msg, recommendedHospital.nombre ?? recommendedHospital.idHospital);
    }

    if (debeConsultarWeb && recommendedHospital) {
      const enginesLabel = [tavilyConfigured && 'Tavily', serperConfigured && 'Serper'].filter(Boolean).join(' + ');
      report(
        'web_enrichment',
        `Consultando búsqueda web (${enginesLabel}) — cartera/servicios públicos del recomendado…`,
        recommendedHospital.nombre ?? recommendedHospital.idHospital,
      );
      hospitalWebEnrichment = await enrichHospitalFromWeb({
        nombre: recommendedHospital.nombre ?? recommendedHospital.idHospital,
        ciudad: recommendedHospital.ciudad,
        direccion: recommendedHospital.direccion,
        especialidadInteres: enrichmentSpecialty.length >= 2 ? enrichmentSpecialty : undefined,
      });
      report(
        'web_enrichment',
        hospitalWebEnrichment
          ? `Web (${hospitalWebEnrichment.proveedor}): ${hospitalWebEnrichment.fragmentos.length} fragmento(s).`
          : 'La búsqueda web no devolvió fragmentos útiles.',
      );
    }

    /** OSM / mapa sin cartera en sistema: búsqueda web por centro (tope acotado por coste API). */
    const OSM_WEB_ENRICH_MAX = 4;
    if (webSearchConfigured) {
      let osmWebCount = 0;
      const enrichedList: HospitalCandidate[] = [];
      const enginesLabel = [tavilyConfigured && 'Tavily', serperConfigured && 'Serper'].filter(Boolean).join(' + ');
      for (const h of hospitalsForResponse) {
        const rawFuente = (h.raw as Record<string, unknown> | undefined)?.fuente;
        const isOsm = rawFuente === 'openstreetmap';
        const emptyLists =
          (h.portfolioForPlan?.length ?? 0) === 0 &&
          (h.especialidadesRed?.length ?? 0) === 0 &&
          (h.carteraServicios?.length ?? 0) === 0;
        if (isOsm && emptyLists && osmWebCount < OSM_WEB_ENRICH_MAX) {
          osmWebCount++;
          report(
            'web_enrichment',
            `Consultando búsqueda web (${enginesLabel}), centro del mapa sin cartera en sistema…`,
            `${h.nombre ?? h.idHospital} (${osmWebCount}/${OSM_WEB_ENRICH_MAX})`,
          );
          try {
            const web = await enrichHospitalFromWeb({
              nombre: h.nombre ?? h.idHospital,
              ciudad: h.ciudad && h.ciudad !== '—' ? h.ciudad : undefined,
              direccion: h.direccion,
              especialidadInteres: enrichmentSpecialty.length >= 2 ? enrichmentSpecialty : undefined,
            });
            enrichedList.push(web ? { ...h, webEnrichment: web } : { ...h });
            report(
              'web_enrichment',
              web
                ? `Web/map (${web.proveedor}): ${web.fragmentos.length} fragmento(s) para «${h.nombre ?? h.idHospital}».`
                : `Web/map: sin fragmentos útiles para «${h.nombre ?? h.idHospital}».`,
            );
          } catch (err) {
            logger.warn(`Enriquecimiento web OSM falló para ${h.idHospital}`, err);
            enrichedList.push({ ...h });
          }
        } else {
          enrichedList.push(h);
        }
      }
      hospitalsForResponse = enrichedList;
    }

    report('consultation', input.consultationPageId ? 'Vinculando con tu consulta abierta…' : 'Creando registro de consulta…');
    const consultation = input.consultationPageId
      ? {
          pageId: input.consultationPageId,
          idConsulta: input.consultationPageId,
          estadoConsulta: 'Abierta',
        }
      : await this.notionService.createConsultationRecord({
          numeroPoliza: input.numeroPoliza,
          patientPageId: patient?.pageId,
          specialtyPageId: specialtyForLookup?.pageId,
          hospitalPageId: recommendedHospital?.pageId,
          copagoEstimado: coverage.estimatedCopay,
          sintomaIngresado: input.symptomText,
          estadoConsulta: 'Abierta',
        });

    const lookupLabel = specialtyForLookup ? `${specialtyForLookup.nombre ?? specialtyForLookup.idEspecialidad}` : 'sin especialidad en BD';
    const bestCopay = recommendedHospital?.estimatedCopay;

    const hospitalsSortedBy: 'distance' | 'copay' =
      loc.userLatitude != null &&
      loc.userLongitude != null &&
      hospitalsForResponse.some((h) => typeof h.distanceKm === 'number')
        ? 'distance'
        : 'copay';

    return {
      numeroPoliza: input.numeroPoliza,
      patient: patient
        ? {
            pageId: patient.pageId,
            numeroPoliza: patient.numeroPoliza,
            nombreCompleto: patient.nombreCompleto,
            planPageId: patient.planPageId,
            deducibleRestante: patient.deducibleRestante,
          }
        : null,
      plan: plan
        ? {
            pageId: plan.pageId,
            idPlan: plan.idPlan,
            nombrePlan: plan.nombrePlan,
            aseguradora: plan.aseguradora,
            tipoPlan: plan.tipoPlan,
            deducibleAnual: plan.deducibleAnual,
            coaseguroPct: plan.coaseguroPct,
            maxBolsilloAnual: plan.maxBolsilloAnual,
            activo: plan.activo,
          }
        : null,
      specialty: specialtyForLookup
        ? {
            pageId: specialtyForLookup.pageId,
            idEspecialidad: specialtyForLookup.idEspecialidad,
            nombre: specialtyForLookup.nombre,
            sintomasRelacionados: specialtyForLookup.sintomasRelacionados,
            urgenciaBase: specialtyForLookup.urgenciaBase,
            requiereReferido: specialtyForLookup.requiereReferido,
          }
        : null,
      coverageRecord: coverageRecord
        ? {
            pageId: coverageRecord.pageId,
            idCobertura: coverageRecord.idCobertura,
            copagoFijo: coverageRecord.copagoFijo,
            coaseguroOverride: coverageRecord.coaseguroOverride,
            cubierto: coverageRecord.cubierto,
          }
        : null,
      hospitals: hospitalsForResponse,
      recommendedHospital,
      recommendedMatchesUserSpecialtyRequest,
      recommendedHospitalDistanceKm: recommendedHospital?.distanceKm,
      symptomSuggestedSpecialty,
      primaryCareFirst,
      recommendedHospitalSpecialties,
      recommendedHospitalServicios,
      recommendedHospitalPortfolio,
      hospitalWebEnrichment,
      coverage,
      estimationLegalNotice: ESTIMATION_LEGAL_NOTICE_ES,
      hospitalsSortedBy,
      mixedNearbyWithOsm,
      decisionNotes: [
        `Poliza procesada: ${input.numeroPoliza}`,
        patient ? `Paciente encontrado: ${patient.nombreCompleto ?? patient.numeroPoliza}` : 'Paciente no encontrado en PACIENTES',
        typeof deductibleRestante === 'number' && deductibleRestante > 0
          ? `Deducible restante declarado (paciente): ${deductibleRestante}`
          : 'Sin deducible restante en ficha de paciente',
        plan ? `Plan detectado: ${plan.idPlan}` : 'No se encontró un plan asociado al paciente',
        primaryCareFirst
          ? `Enrutamiento: primero ${lookupLabel} (síntomas sugirieron: ${symptomSuggestedSpecialty?.nombre ?? input.analysis.specialty})`
          : `Especialidad para red/cobertura: ${lookupLabel}`,
        coverageRecord ? `Cobertura encontrada: ${coverageRecord.idCobertura}` : 'No hay cobertura específica para plan + especialidad',
        recommendedHospital
          ? recommendedMatchesUserSpecialtyRequest
            ? `Recomendación prioritaria: «${recommendedHospital.nombre ?? recommendedHospital.idHospital}» — en tu red y en datos coincide con lo que buscabamos («${userSpecialtyNeedle}»); copago estimado ~${bestCopay ?? coverage.estimatedCopay}.`
            : `Mejor opción en red (${hospitalsSortedBy === 'distance' ? 'prioridad: cercanía con tu ubicación' : 'prioridad: menor copago estimado'}): ${recommendedHospital.nombre ?? recommendedHospital.idHospital}; copago estimado ~${bestCopay ?? coverage.estimatedCopay}; cartera en datos: ${recommendedHospitalPortfolio.length} ítems (red + maestro)${
                hospitalWebEnrichment ? `; enriquecimiento web (${hospitalWebEnrichment.proveedor}): ${hospitalWebEnrichment.fragmentos.length} fragmentos` : ''
              }`
          : 'No hay hospital de red disponible',
        mixedNearbyWithOsm
          ? `Lista para el usuario: red del plan + centros cercanos (OSM, fuera de red), ordenados por distancia; tope ${MAX_HOSPITALS_IN_RESPONSE} resultados — el chat muestra solo unos pocos; el resto en el mapa.`
          : 'Lista basada solo en red del plan (sin GPS o sin resultados OSM).',
      ],
      consultation: {
        pageId: consultation.pageId,
        idConsulta: consultation.idConsulta,
        estadoConsulta: consultation.estadoConsulta,
      },
    };
  }

  public calculateCoverage(input: {
    patient: PatientRecord | null;
    plan: PlanRecord | null;
    specialty: SpecialtyRecord | null;
    coverageRecord: CoverageRecord | null;
    priority: string;
    customerContext: Record<string, unknown>;
  }): CoverageEstimate {
    const coveragePercent = this.computeCoveragePercent(input.plan, input.coverageRecord);
    const priorityAdjustment = input.priority === 'urgent' ? 1.1 : input.priority === 'high' ? 1.05 : 1;
    const estimatedServiceCost = roundCurrency(
      this.estimateServiceCost(input.specialty?.nombre ?? input.specialty?.idEspecialidad ?? 'Medicina General') * priorityAdjustment,
    );
    const copagoFijo = input.coverageRecord?.copagoFijo ?? 0;
    const ded = input.patient?.deducibleRestante;
    const estimatedCopay = this.computePatientCopay(estimatedServiceCost, coveragePercent, copagoFijo, ded);

    let notes = input.coverageRecord?.cubierto === false
      ? 'La cobertura específica indica que el caso no está cubierto por ese plan.'
      : 'Cobertura calculada usando PLANES_SEGURO + COBERTURAS_ESPECIALIDAD.';
    if (typeof ded === 'number' && ded > 0) {
      notes += ` Se ponderó deducible restante declarado en paciente (${ded}).`;
    }

    return {
      coveragePercent,
      coverageLabel: `${Math.round(coveragePercent * 100)}% estimado`,
      estimatedServiceCost,
      estimatedCopay: Math.max(0, estimatedCopay),
      currency: 'USD',
      notes,
      patientDeductibleRemaining: typeof ded === 'number' && ded > 0 ? ded : undefined,
    };
  }

  private buildCoverageEstimateForRecommendation(input: {
    patient: PatientRecord | null;
    plan: PlanRecord | null;
    specialty: SpecialtyRecord | null;
    coverageRecord: CoverageRecord | null;
    priority: string;
    customerContext: Record<string, unknown>;
    coveragePercent: number;
    recommendedHospital: HospitalCandidate | null;
    deductibleRestante?: number;
  }): CoverageEstimate {
    const copagoFijo = input.coverageRecord?.copagoFijo ?? 0;
    const ded = input.deductibleRestante;

    if (input.recommendedHospital) {
      const visitCost = this.estimateVisitCostForHospital(input.specialty, input.priority, input.recommendedHospital);
      const estimatedCopay =
        input.recommendedHospital.estimatedCopay ??
        this.computePatientCopay(visitCost, input.coveragePercent, copagoFijo, ded);

      let notes = input.coverageRecord?.cubierto === false
        ? 'La cobertura específica indica que el caso no está cubierto por ese plan.'
        : 'Copago estimado para el hospital más conveniente en red (tarifa base del centro + reglas del plan).';
      if (typeof ded === 'number' && ded > 0) {
        notes += ` Deducible restante en paciente: ${ded}.`;
      }

      return {
        coveragePercent: input.coveragePercent,
        coverageLabel: `${Math.round(input.coveragePercent * 100)}% estimado`,
        estimatedServiceCost: visitCost,
        estimatedCopay: Math.max(0, estimatedCopay),
        currency: 'USD',
        notes,
        patientDeductibleRemaining: typeof ded === 'number' && ded > 0 ? ded : undefined,
      };
    }

    return this.calculateCoverage({
      patient: input.patient,
      plan: input.plan,
      specialty: input.specialty,
      coverageRecord: input.coverageRecord,
      priority: input.priority,
      customerContext: input.customerContext,
    });
  }

  /**
   * Copago orientativo para el mapa de cercanos: misma heurística que el chat (plan + cobertura por especialidad base).
   * Sin póliza o paciente no encontrado → sin cambios. OSM (`tieneCobertura === false`) no recibe copago del plan.
   */
  public async enrichNearbyRowsWithEstimatedCopay<T extends Record<string, unknown>>(
    numeroPoliza: string | undefined,
    rows: T[],
  ): Promise<Array<T & { copay?: number }>> {
    const poliza = numeroPoliza?.trim();
    if (!poliza || rows.length === 0) return rows;

    const patient = await this.notionService.findPatientByNumeroPolizaOrPageId(poliza);
    if (!patient) return rows;

    const plan = patient.planPageId ? await this.notionService.findPlanByPageId(patient.planPageId) : null;
    const specialtyForLookup = await this.notionService.findPrimaryCareSpecialty();

    const coverageRecord =
      plan && specialtyForLookup
        ? await this.notionService.findCoverageByPlanAndSpecialty(plan.pageId, specialtyForLookup.pageId)
        : null;

    const coveragePercent = this.computeCoveragePercent(plan, coverageRecord);
    const copagoFijo = coverageRecord?.copagoFijo ?? 0;
    const deductibleRestante = patient.deducibleRestante;
    const priority = 'normal';

    const tarifaMap =
      plan && specialtyForLookup
        ? await this.notionService.buildTarifaBaseMapForPlanAndSpecialty(plan.pageId, specialtyForLookup.pageId)
        : new Map<string, number>();

    return rows.map((row) => {
      if (row.tieneCobertura === false) return row as T & { copay?: number };

      const id = typeof row.id === 'string' ? row.id : '';
      if (!id) return row as T & { copay?: number };

      const tbRaw = row.tarifaBase;
      const tarifaFromRow = typeof tbRaw === 'number' && Number.isFinite(tbRaw) ? tbRaw : undefined;
      const tarifaBase = tarifaMap.get(id) ?? tarifaFromRow;

      const candidate: HospitalCandidate = {
        pageId: id,
        idHospital: id,
        nombre: typeof row.nombre === 'string' ? row.nombre : undefined,
        tarifaBase,
        latitud: typeof row.latitud === 'number' ? row.latitud : undefined,
        longitud: typeof row.longitud === 'number' ? row.longitud : undefined,
      };

      const visitCost = this.estimateVisitCostForHospital(specialtyForLookup, priority, candidate);
      const estimatedCopay = Math.max(0, this.computePatientCopay(visitCost, coveragePercent, copagoFijo, deductibleRestante));

      return { ...row, copay: estimatedCopay };
    });
  }

  private computeCoveragePercent(plan: PlanRecord | null, coverageRecord: CoverageRecord | null): number {
    const deductibleFactor = plan?.deducibleAnual ? clampNumber(1 - plan.deducibleAnual / 20000, 0.25, 1) : 1;
    const planCoinsurance = typeof plan?.coaseguroPct === 'number' ? plan.coaseguroPct / 100 : 0.2;
    const overrideCoinsurance = typeof coverageRecord?.coaseguroOverride === 'number' ? coverageRecord.coaseguroOverride / 100 : null;
    const coveragePercentFromPlan = clampNumber(1 - planCoinsurance * deductibleFactor, 0.3, 0.98);
    return coverageRecord?.cubierto === false
      ? 0.2
      : clampNumber(overrideCoinsurance ? 1 - overrideCoinsurance : coveragePercentFromPlan, 0.3, 0.98);
  }

  private computePatientCopay(
    estimatedServiceCost: number,
    coveragePercent: number,
    copagoFijo: number,
    deductibleRestante?: number,
  ): number {
    const coinsuranceCopay = roundCurrency(estimatedServiceCost * (1 - coveragePercent) + copagoFijo);
    let total = coinsuranceCopay;
    if (typeof deductibleRestante === 'number' && deductibleRestante > 0) {
      const deductibleHit = Math.min(deductibleRestante, estimatedServiceCost * 0.42);
      total = roundCurrency(total + deductibleHit);
    }
    return Math.min(roundCurrency(estimatedServiceCost + copagoFijo), Math.max(0, total));
  }

  private estimateVisitCostForHospital(specialty: SpecialtyRecord | null, priority: string, hospital: HospitalCandidate): number {
    const priorityAdjustment = priority === 'urgent' ? 1.1 : priority === 'high' ? 1.05 : 1;
    let cost =
      this.estimateServiceCost(specialty?.nombre ?? specialty?.idEspecialidad ?? 'Medicina General') * priorityAdjustment;
    const tb = hospital.tarifaBase;
    if (typeof tb === 'number' && tb > 0 && tb <= 2500) {
      cost *= clampNumber(tb / 175, 0.82, 1.42);
    }
    return roundCurrency(cost);
  }

  private enrichHospitalsWithEconomics(
    hospitals: HospitalCandidate[],
    specialty: SpecialtyRecord | null,
    priority: string,
    coveragePercent: number,
    copagoFijo: number,
    deductibleRestante: number | undefined,
    coverageRecord: CoverageRecord | null,
    loc: { userLatitude?: number; userLongitude?: number; userCity?: string },
  ): HospitalCandidate[] {
    const userCityNorm = loc.userCity ? normalizeSpecialtyName(loc.userCity) : '';

    const enriched = hospitals.map((h) => {
      let distanceKm: number | undefined;
      if (
        loc.userLatitude != null &&
        loc.userLongitude != null &&
        typeof h.latitud === 'number' &&
        typeof h.longitud === 'number'
      ) {
        distanceKm = haversineKm(loc.userLatitude, loc.userLongitude, h.latitud, h.longitud);
      }

      const visitCost = this.estimateVisitCostForHospital(specialty, priority, h);
      const estimatedCopay = this.computePatientCopay(visitCost, coveragePercent, copagoFijo, deductibleRestante);

      let score = h.score ?? 50;
      if ((h.nivelAtencion ?? '').toLowerCase().includes('alta')) score += 8;
      if (priority === 'urgent') score += 10;
      if (coverageRecord?.cubierto === false) {
        score -= 15;
      }
      if (userCityNorm && h.ciudad && normalizeSpecialtyName(h.ciudad) === userCityNorm) {
        score += 25;
      }

      return { ...h, estimatedCopay, distanceKm, score };
    });

    enriched.sort((a, b) => {
      const da = a.distanceKm;
      const db = b.distanceKm;
      const aGeo = da != null && Number.isFinite(da);
      const bGeo = db != null && Number.isFinite(db);

      // Con coordenadas en ambos centros: primero cercanía, luego copago.
      if (aGeo && bGeo) {
        if (Math.abs(da - db) > 0.05) return da - db;
        const ca = a.estimatedCopay ?? Number.POSITIVE_INFINITY;
        const cb = b.estimatedCopay ?? Number.POSITIVE_INFINITY;
        if (Math.abs(ca - cb) > 0.005) return ca - cb;
        return (b.score ?? 0) - (a.score ?? 0);
      }

      if (aGeo && !bGeo) return -1;
      if (!aGeo && bGeo) return 1;

      const ca = a.estimatedCopay ?? Number.POSITIVE_INFINITY;
      const cb = b.estimatedCopay ?? Number.POSITIVE_INFINITY;
      if (Math.abs(ca - cb) > 0.005) return ca - cb;
      return (b.score ?? 0) - (a.score ?? 0);
    });

    return enriched;
  }

  private estimateServiceCost(specialty: string): number {
    const normalized = normalizeSpecialtyName(specialty);

    if (normalized.includes('cardio')) return 320;
    if (normalized.includes('neuro')) return 350;
    if (normalized.includes('trauma') || normalized.includes('ortho')) return 280;
    if (normalized.includes('gastro')) return 230;
    if (normalized.includes('pulmo') || normalized.includes('respir')) return 210;
    if (normalized.includes('derma')) return 140;
    if (normalized.includes('pedi')) return 120;
    if (normalized.includes('gine') || normalized.includes('obst')) return 180;
    if (normalized.includes('urg')) return 500;
    return 180;
  }
}
