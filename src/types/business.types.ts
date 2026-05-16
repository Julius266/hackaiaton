export interface CoverageEstimate {
  coveragePercent: number;
  coverageLabel: string;
  estimatedServiceCost: number;
  estimatedCopay: number;
  currency: 'USD' | 'MXN' | 'COP' | 'EUR' | 'ARS';
  notes: string;
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
}

export interface BusinessData {
  numeroPoliza: string;
  patient: {
    pageId: string;
    numeroPoliza: string;
    nombreCompleto?: string;
    planPageId?: string;
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
  coverage: CoverageEstimate;
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
}
