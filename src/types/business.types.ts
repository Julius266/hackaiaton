import type { ChatProgressPayload } from './chat-progress.types';

export interface CoverageEstimate {
  coveragePercent: number;
  coverageLabel: string;
  estimatedServiceCost: number;
  estimatedCopay: number;
  currency: 'USD' | 'MXN' | 'COP' | 'EUR' | 'ARS';
  notes: string;
  /** Deducible restante del paciente usado en el cálculo (si existía en datos). */
  patientDeductibleRemaining?: number;
}

export interface HospitalWebEnrichment {
  fuente: 'web_search';
  /** Tavily primario; Serper refuerza cuando hay clave; `tavily_serper` si aportaron ambos. */
  proveedor: 'tavily' | 'serper' | 'tavily_serper';
  consulta: string;
  fragmentos: { titulo?: string; url: string; texto: string }[];
  avisoLegal: string;
}

export interface HospitalCandidate {
  pageId: string;
  idHospital: string;
  nombre?: string;
  ciudad?: string;
  nivelAtencion?: string;
  activo?: boolean;
  tarifaBase?: number;
  score?: number;
  raw?: Record<string, unknown>;
  latitud?: number;
  longitud?: number;
  direccion?: string;
  contacto?: string;
  /** Copago estimado para este centro según tarifa de red + reglas del plan (orden económico). */
  estimatedCopay?: number;
  /** Distancia al usuario si hubo coordenadas (km). */
  distanceKm?: number;
  /** Cartera declarada en maestro del hospital (Notion). */
  carteraServicios?: string[];
  /** Especialidades en tabla RED para el plan del paciente (solo chat / negocio). */
  especialidadesRed?: string[];
  /** Especialidades RED + cartera maestro, unificado (solo chat / negocio). */
  portfolioForPlan?: string[];
  /** Fragmentos Tavily por centro (p. ej. mapa OSM sin cartera en Notion). */
  webEnrichment?: HospitalWebEnrichment | null;

  /** Si el centro forma parte de la red del plan para la especialidad consultada (tabla RED). */
  inNetwork?: boolean;
}

export interface BusinessData {
  numeroPoliza: string;
  patient: {
    pageId: string;
    numeroPoliza: string;
    nombreCompleto?: string;
    planPageId?: string;
    deducibleRestante?: number;
  } | null;
  plan: {
    pageId: string;
    idPlan: string;
    nombrePlan?: string;
    aseguradora?: string;
    tipoPlan?: string;
    deducibleAnual?: number;
    coaseguroPct?: number;
    maxBolsilloAnual?: number;
    activo?: boolean;
  } | null;
  specialty: {
    pageId: string;
    idEspecialidad: string;
    nombre?: string;
    sintomasRelacionados: string[];
    urgenciaBase?: string;
    requiereReferido?: boolean;
  } | null;
  coverageRecord: {
    pageId: string;
    idCobertura: string;
    copagoFijo?: number;
    coaseguroOverride?: number;
    cubierto?: boolean;
  } | null;
  hospitals: HospitalCandidate[];
  recommendedHospital: HospitalCandidate | null;
  /** true si el recomendado está en red y en datos coincide con la especialidad pedida por el usuario. */
  recommendedMatchesUserSpecialtyRequest?: boolean;
  /** Distancia aproximada al hospital recomendado si hay coordenadas del usuario (km). */
  recommendedHospitalDistanceKm?: number;
  /** Especialidad inferida por síntomas (posible canalización futura). */
  symptomSuggestedSpecialty: {
    pageId: string;
    idEspecialidad: string;
    nombre?: string;
  } | null;
  /** Si es true, la red/cobertura se calculó pensando en medicina general primero. */
  primaryCareFirst: boolean;
  /** Especialidades listadas en red para el hospital recomendado y el plan del paciente. */
  recommendedHospitalSpecialties: string[];
  /** Servicios/cartera del maestro del hospital recomendado (Notion). */
  recommendedHospitalServicios: string[];
  /** Unión ordenada: especialidades en red + servicios maestro (para contexto de IA). */
  recommendedHospitalPortfolio: string[];
  /** Si no había cartera en sistema, fragmentos de búsqueda web (Tavily/Serper); null si no aplica o falló. */
  hospitalWebEnrichment: HospitalWebEnrichment | null;
  coverage: CoverageEstimate;
  /** Aviso legal breve para mostrar junto a montos (estimación, no garantía). */
  estimationLegalNotice: string;
  /**
   * Con ubicación del paciente y coordenadas en hospitales, la lista se ordena por distancia (luego copago).
   * Sin ubicación o sin coords en maestro, se ordena por copago estimado.
   */
  hospitalsSortedBy: 'distance' | 'copay';
  /** Lista ampliada con OSM u otros cercanos; el chat solo muestra un subconjunto. */
  mixedNearbyWithOsm?: boolean;
  decisionNotes: string[];
  consultation: {
    pageId: string;
    idConsulta: string;
    estadoConsulta?: string;
  };
}

export interface BusinessInput {
  numeroPoliza: string;
  symptomText: string;
  customerContext: Record<string, unknown>;
  consultationPageId?: string;
  analysis: {
    specialty: string;
    priority: string;
    intent: string;
    requiredData: string[];
  };
  /** Solo streaming del chat: avisos de lo que está haciendo el backend (Notion, web, etc.). */
  onChatProgress?: (payload: ChatProgressPayload) => void;
}
