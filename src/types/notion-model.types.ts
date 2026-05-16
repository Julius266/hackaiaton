export interface NotionBaseRecord {
  pageId: string;
  raw: Record<string, any>;
}

export interface PlanRecord extends NotionBaseRecord {
  idPlan: string;
  nombrePlan?: string;
  aseguradora?: string;
  tipoPlan?: string;
  deducibleAnual?: number;
  coaseguroPct?: number;
  maxBolsilloAnual?: number;
  activo?: boolean;
}

export interface SpecialtyRecord extends NotionBaseRecord {
  idEspecialidad: string;
  nombre?: string;
  sintomasRelacionados: string[];
  urgenciaBase?: string;
  requiereReferido?: boolean;
}

export interface HospitalRecord extends NotionBaseRecord {
  idHospital: string;
  nombre?: string;
  ciudad?: string;
  nivelAtencion?: string;
  activo?: boolean;
  latitud?: number;
  longitud?: number;
  direccion?: string;
  contacto?: string;
}

export interface PatientRecord extends NotionBaseRecord {
  numeroPoliza: string;
  nombreCompleto?: string;
  planPageId?: string;
  email?: string;
  telefono?: string;
  estado?: string;
}

export interface CoverageRecord extends NotionBaseRecord {
  idCobertura: string;
  planPageId?: string;
  specialtyPageId?: string;
  copagoFijo?: number;
  coaseguroOverride?: number;
  cubierto?: boolean;
}

export interface HospitalNetworkRecord extends NotionBaseRecord {
  idRed: string;
  hospitalPageId?: string;
  specialtyPageId?: string;
  planPageIds: string[];
  tarifaBase?: number;
  disponible?: boolean;
  hospital?: HospitalRecord;
}

export interface ConsultationRecord extends NotionBaseRecord {
  idConsulta: string;
  numeroPoliza?: string;
  patientPageId?: string;
  specialtyPageId?: string;
  hospitalPageId?: string;
  copagoEstimado?: number;
  sintomaIngresado?: string;
  estadoConsulta?: string;
}

export interface SessionMessageRecord extends NotionBaseRecord {
  idMensaje: string;
  consultationPageId?: string;
  role: 'user' | 'assistant' | 'system';
  mensaje: string;
  timestamp: string;
}

export interface UserRecord extends NotionBaseRecord {
  email?: string;
  passwordHash?: string;
  role?: string;
  linkedPatientPageIds?: string[];
}

export interface ConsultationContext {
  numeroPoliza: string;
  patient: PatientRecord | null;
  plan: PlanRecord | null;
  specialty: SpecialtyRecord | null;
  coverage: CoverageRecord | null;
  hospitals: HospitalNetworkRecord[];
  consultation: ConsultationRecord | null;
}
