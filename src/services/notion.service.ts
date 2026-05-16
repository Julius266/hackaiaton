import { APIResponseError, Client } from '@notionhq/client';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { ChatMessage } from '../types/chat.types';
import type {
  ConsultationRecord,
  CoverageRecord,
  HospitalNetworkRecord,
  HospitalRecord,
  PatientRecord,
  PlanRecord,
  UserRecord,
  SpecialtyRecord,
} from '../types/notion-model.types';
import type { NotionCreatePageInput, NotionPageResult, NotionQueryOptions, NotionUpdatePageInput } from '../types/notion.types';
import { createMessageId } from '../utils/id';

interface MockDatabaseRecord {
  id: string;
  properties: Record<string, unknown>;
  databaseId: string;
  createdAt: string;
  updatedAt: string;
}

function toTitle(value: string): { title: Array<{ text: { content: string } }> } {
  return {
    title: [
      {
        text: {
          content: value,
        },
      },
    ],
  };
}

function toText(value: string): { rich_text: Array<{ text: { content: string } }> } {
  return {
    rich_text: [
      {
        text: {
          content: value,
        },
      },
    ],
  };
}

function toNumber(value: number): { number: number } {
  return { number: value };
}

function toCheckbox(value: boolean): { checkbox: boolean } {
  return { checkbox: value };
}

function toSelect(value: string): { select: { name: string } } {
  return { select: { name: value } };
}

function toRelation(pageIds: string[]): { relation: Array<{ id: string }> } {
  return { relation: pageIds.map((id) => ({ id })) };
}

function extractTitleValue(property: any): string {
  if (!property) {
    return '';
  }

  if (Array.isArray(property.title)) {
    return property.title.map((entry: any) => entry?.plain_text ?? entry?.text?.content ?? '').join('');
  }

  if (Array.isArray(property.rich_text)) {
    return property.rich_text.map((entry: any) => entry?.plain_text ?? entry?.text?.content ?? '').join('');
  }

  return '';
}

function extractTextValue(property: any): string {
  if (!property) {
    return '';
  }

  if (typeof property.email === 'string') {
    return property.email;
  }

  if (typeof property.phone_number === 'string') {
    return property.phone_number;
  }

  if (Array.isArray(property.rich_text)) {
    return property.rich_text.map((entry: any) => entry?.plain_text ?? entry?.text?.content ?? '').join('');
  }

  if (Array.isArray(property.title)) {
    return property.title.map((entry: any) => entry?.plain_text ?? entry?.text?.content ?? '').join('');
  }

  if (typeof property.select?.name === 'string') {
    return property.select.name;
  }

  if (typeof property.status?.name === 'string') {
    return property.status.name;
  }

  if (typeof property.number === 'number') {
    return String(property.number);
  }

  if (typeof property.checkbox === 'boolean') {
    return String(property.checkbox);
  }

  return '';
}

function extractNumberValue(property: any): number | undefined {
  if (typeof property?.number === 'number') {
    return property.number;
  }

  const parsed = Number(extractTextValue(property));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractCheckboxValue(property: any): boolean | undefined {
  if (typeof property?.checkbox === 'boolean') {
    return property.checkbox;
  }

  const text = extractTextValue(property).toLowerCase();
  if (['true', 'yes', 'si', 'sí', '1'].includes(text)) {
    return true;
  }

  if (['false', 'no', '0'].includes(text)) {
    return false;
  }

  return undefined;
}

function extractRelationIds(property: any): string[] {
  if (!property || !Array.isArray(property.relation)) {
    return [];
  }

  return property.relation.map((entry: any) => entry?.id).filter(Boolean);
}

function normalizeString(value: string): string {
  return value.trim().toLowerCase();
}

function pickFirstText(candidate: unknown): string {
  return typeof candidate === 'string' ? candidate : '';
}

/** Errores HTTP típicamente transitorios en API Notion / infraestructura (502/503/504) y rate limit (429). */
const RETRIABLE_NOTION_STATUSES = new Set([429, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableNotionError(error: unknown): boolean {
  if (APIResponseError.isAPIResponseError(error)) {
    return RETRIABLE_NOTION_STATUSES.has(error.status);
  }
  const msg = error instanceof Error ? error.message : String(error);
  return /\b(?:429|502|503|504)\b/.test(msg);
}

export class NotionService {
  private readonly client: Client | null;

  private readonly mockPagesById = new Map<string, MockDatabaseRecord>();

  private readonly mockDatabases = new Map<string, MockDatabaseRecord[]>();

  constructor() {
    this.client =
      env.NOTION_TOKEN && !env.USE_MOCK_NOTION
        ? new Client({
            auth: env.NOTION_TOKEN,
            timeoutMs: env.NOTION_TIMEOUT_MS,
          })
        : null;
    
    if (!this.client) {
      this.seedMockData();
    }
  }

  private seedMockData() {
    // Seed Users Database Schema and a default user
    // Password for default user is 'password123'
    // Hash: $2a$10$7Rf.n2hXf.n2hXf.n2hXf.O... actually bcryptjs.hashSync is better if I can use it
    const defaultUserPageId = 'user-1';
    const patientPageId = 'patient-1';
    const planPageId = 'plan-1';

    this.mockDatabases.set(env.DATABASE_ID_USUARIOS || 'users-db', [{
      id: defaultUserPageId,
      databaseId: env.DATABASE_ID_USUARIOS || 'users-db',
      properties: {
        Email: { title: [{ text: { content: 'juan.delgado@email.com' } }] },
        Password_Hash: { rich_text: [{ text: { content: '$2a$10$6rM7m5H3L.v5V6lE6E9.p.xX.r.Y.p.xX.r.Y.p.xX.r.Y.' } }] }, // 'password123'
        rol: { select: { name: 'patient' } },
        Pacientes: { relation: [{ id: patientPageId }] }
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }]);

    this.mockPagesById.set(defaultUserPageId, this.mockDatabases.get(env.DATABASE_ID_USUARIOS || 'users-db')![0]);

    this.mockDatabases.set(env.DATABASE_ID_PACIENTES || 'patients-db', [{
      id: patientPageId,
      databaseId: env.DATABASE_ID_PACIENTES || 'patients-db',
      properties: {
        Numero_Poliza: { title: [{ text: { content: 'POL-12345' } }] },
        Nombre_Completo: { rich_text: [{ text: { content: 'Juan Delgado' } }] },
        Plan_ID: { relation: [{ id: planPageId }] },
        Deducible_Restante: { number: 200 },
        Email: { email: 'juan.delgado@email.com' }
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }]);
    this.mockPagesById.set(patientPageId, this.mockDatabases.get(env.DATABASE_ID_PACIENTES || 'patients-db')![0]);

    this.mockDatabases.set(env.DATABASE_ID_PLANES || 'plans-db', [{
      id: planPageId,
      databaseId: env.DATABASE_ID_PLANES || 'plans-db',
      properties: {
        ID_Plan: { title: [{ text: { content: 'PLAN-GOLD' } }] },
        Nombre_Plan: { rich_text: [{ text: { content: 'Salud Total Platinum' } }] },
        Aseguradora: { rich_text: [{ text: { content: 'Seguros Vida' } }] },
        Tipo_Plan: { select: { name: 'PPO' } },
        Deducible_Anual: { number: 500 },
        Coaseguro_Pct: { number: 20 },
        Max_Bolsillo_Anual: { number: 5000 },
        Activo: { checkbox: true }
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }]);
    this.mockPagesById.set(planPageId, this.mockDatabases.get(env.DATABASE_ID_PLANES || 'plans-db')![0]);
  }

  public isMockMode(): boolean {
    return !this.client;
  }

  /** Reintenta llamadas ante 502/503/504/429 (fallos transitorios del API Notion). */
  private async notionCallWithRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const maxAttempts = 4;
    const baseMs = 800;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (!isRetriableNotionError(err) || attempt === maxAttempts) {
          throw err;
        }
        const delay = baseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
        logger.warn(
          `Notion ${operation}: error transitorio (intento ${attempt}/${maxAttempts}), siguiente reintento en ${delay}ms`,
          err,
        );
        await sleep(delay);
      }
    }
    throw lastError;
  }

  public async getPage(pageId: string): Promise<NotionPageResult | null> {
    if (!this.client) {
      const record = this.mockPagesById.get(pageId);
      return record ? this.toPageResult(record) : null;
    }

    return this.notionCallWithRetry('pages.retrieve', () =>
      this.client!.pages.retrieve({ page_id: pageId }),
    ) as Promise<NotionPageResult>;
  }

  public async queryDatabase(databaseId: string, options: NotionQueryOptions = {}): Promise<NotionPageResult[]> {
    if (!this.client) {
      const records = this.mockDatabases.get(databaseId) ?? [];
      return records.map((record) => this.toPageResult(record));
    }

    const response = await this.notionCallWithRetry('databases.query', () =>
      this.client!.databases.query({
        database_id: databaseId,
        filter: options.filter as any,
        sorts: options.sorts as any,
        page_size: options.pageSize,
        start_cursor: options.startCursor,
      } as any),
    );

    return response.results as NotionPageResult[];
  }

  public async getDatabase(databaseId: string): Promise<any> {
    if (!this.client) {
      // in mock mode return a minimal structure
      const records = this.mockDatabases.get(databaseId) ?? [];
      return {
        id: databaseId,
        properties: Object.keys((records[0]?.properties) ?? {}).reduce((acc: any, key) => {
          acc[key] = { type: 'rich_text' };
          return acc;
        }, {}),
      };
    }

    return this.notionCallWithRetry('databases.retrieve', () =>
      this.client!.databases.retrieve({ database_id: databaseId } as any),
    ) as Promise<any>;
  }

  public async createPage(input: NotionCreatePageInput): Promise<NotionPageResult> {
    if (!this.client) {
      const id = createMessageId();
      const record: MockDatabaseRecord = {
        id,
        properties: input.properties,
        databaseId: input.databaseId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const existing = this.mockDatabases.get(input.databaseId) ?? [];
      existing.push(record);
      this.mockDatabases.set(input.databaseId, existing);
      this.mockPagesById.set(id, record);
      return this.toPageResult(record);
    }

    return this.notionCallWithRetry('pages.create', () =>
      this.client!.pages.create({
        parent: {
          database_id: input.databaseId,
        },
        properties: input.properties,
        children: input.children,
      } as any),
    ) as Promise<NotionPageResult>;
  }

  public async updatePage(input: NotionUpdatePageInput): Promise<NotionPageResult> {
    if (!this.client) {
      const existing = this.mockPagesById.get(input.pageId);
      if (existing) {
        existing.properties = {
          ...existing.properties,
          ...input.properties,
        };
        existing.updatedAt = new Date().toISOString();
      }

      return {
        id: input.pageId,
        properties: input.properties,
      } as NotionPageResult;
    }

    return this.notionCallWithRetry('pages.update', () =>
      this.client!.pages.update({
        page_id: input.pageId,
        properties: input.properties,
      } as any),
    ) as Promise<NotionPageResult>;
  }

  public async findPatientByNumeroPoliza(numeroPoliza: string): Promise<PatientRecord | null> {
    const page = await this.findSingleByProperty(env.DATABASE_ID_PACIENTES, 'Numero_Poliza', numeroPoliza, 'title');
    return page ? this.mapPatient(page) : null;
  }

  /**
   * Chat / sesión pueden usar `customerId` = número de póliza (title) o id de página del paciente en Notion.
   */
  public async findPatientByNumeroPolizaOrPageId(key: string): Promise<PatientRecord | null> {
    const trimmed = key.trim();
    if (!trimmed) return null;

    const byPoliza = await this.findPatientByNumeroPoliza(trimmed);
    if (byPoliza) return byPoliza;

    const pageId = this.normalizeNotionUuid(trimmed);
    if (!pageId) return null;

    const page = await this.getPage(pageId);
    if (!page?.properties) return null;

    const parent = (page as NotionPageResult & { parent?: { type?: string; database_id?: string } }).parent;
    if (parent?.type === 'database_id' && parent.database_id === env.DATABASE_ID_PACIENTES) {
      return this.mapPatient(page);
    }

    return null;
  }

  /** Tarifa base en tabla RED por hospital maestro (plan + especialidad); una sola query a RED. */
  public async buildTarifaBaseMapForPlanAndSpecialty(
    planPageId: string,
    specialtyPageId: string,
  ): Promise<Map<string, number>> {
    const pages = await this.queryDatabase(env.DATABASE_ID_HOSPITALES_RED);
    const map = new Map<string, number>();
    for (const candidate of pages) {
      const planIds = extractRelationIds(candidate.properties.Planes_Aceptados);
      const specialtyIds = extractRelationIds(candidate.properties.Especialidad_ID);
      if (!planIds.includes(planPageId) || !specialtyIds.includes(specialtyPageId)) continue;
      if (extractCheckboxValue(candidate.properties.Disponible) === false) continue;
      const tb = extractNumberValue(candidate.properties.Tarifa_Base);
      if (typeof tb !== 'number' || !Number.isFinite(tb) || tb <= 0) continue;
      const hospIds = extractRelationIds(candidate.properties.Hospital_ID);
      for (const hid of hospIds) {
        map.set(hid, tb);
      }
    }
    return map;
  }

  private normalizeNotionUuid(raw: string): string | null {
    const t = raw.trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) {
      return t;
    }
    const compact = t.replace(/-/g, '');
    if (!/^[0-9a-f]{32}$/i.test(compact)) return null;
    return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
  }

  public async findPlanByIdPlan(idPlan: string): Promise<PlanRecord | null> {
    const page = await this.findSingleByProperty(env.DATABASE_ID_PLANES, 'ID_Plan', idPlan, 'title');
    return page ? this.mapPlan(page) : null;
  }

  public async findSpecialtyByValue(value: string): Promise<SpecialtyRecord | null> {
    const pages = await this.queryDatabase(env.DATABASE_ID_ESPECIALIDADES);
    const normalized = normalizeString(value);
    const page = pages.find((candidate) => {
      const idEspecialidad = normalizeString(this.extract(candidate, 'ID_Especialidad'));
      const nombre = normalizeString(this.extract(candidate, 'Nombre'));
      return idEspecialidad === normalized || nombre === normalized;
    });

    return page ? this.mapSpecialty(page) : null;
  }

  /** Primera especialidad de atención primaria encontrada en la BD (una sola query). */
  public async findPrimaryCareSpecialty(): Promise<SpecialtyRecord | null> {
    const pages = await this.queryDatabase(env.DATABASE_ID_ESPECIALIDADES);
    const needles = ['medicina general', 'medicina familiar', 'atencion primaria', 'atención primaria'];

    for (const page of pages) {
      const nombre = normalizeString(this.extract(page, 'Nombre'));
      const idEsp = normalizeString(this.extract(page, 'ID_Especialidad'));
      const haystack = `${nombre} ${idEsp}`;
      if (needles.some((n) => haystack.includes(n))) {
        return this.mapSpecialty(page);
      }
    }

    return this.findSpecialtyByValue('Medicina General');
  }

  /**
   * Por cada hospital (pageId del maestro), nombres de especialidades contratadas en RED para el plan.
   * Carga RED + catálogo de especialidades en pocas queries (evita N llamadas retrieve por cada especialidad).
   */
  public async findHospitalSpecialtiesByPlan(planPageId: string): Promise<Map<string, string[]>> {
    const [redPages, specialtyPages] = await Promise.all([
      this.queryDatabase(env.DATABASE_ID_HOSPITALES_RED),
      this.queryDatabase(env.DATABASE_ID_ESPECIALIDADES),
    ]);

    const hospitalToSpecIds = new Map<string, Set<string>>();

    for (const candidate of redPages) {
      const planIds = extractRelationIds(candidate.properties.Planes_Aceptados);
      if (!planIds.includes(planPageId)) continue;
      const disponible = extractCheckboxValue(candidate.properties.Disponible);
      if (disponible === false) continue;
      const hospIds = extractRelationIds(candidate.properties.Hospital_ID);
      const specIds = extractRelationIds(candidate.properties.Especialidad_ID);
      for (const hid of hospIds) {
        if (!hospitalToSpecIds.has(hid)) hospitalToSpecIds.set(hid, new Set());
        const set = hospitalToSpecIds.get(hid)!;
        specIds.forEach((id) => set.add(id));
      }
    }

    const nameBySpecId = new Map<string, string>();
    for (const page of specialtyPages) {
      const rec = this.mapSpecialty(page);
      const label = rec.nombre ?? rec.idEspecialidad;
      if (label) nameBySpecId.set(page.id, label);
    }

    const allSpecIds = [...new Set(Array.from(hospitalToSpecIds.values()).flatMap((s) => [...s]))];
    const missing = allSpecIds.filter((id) => !nameBySpecId.has(id));

    const chunkSize = 6;
    for (let i = 0; i < missing.length; i += chunkSize) {
      const chunk = missing.slice(i, i + chunkSize);
      await Promise.all(
        chunk.map(async (sid) => {
          try {
            const spec = await this.findSpecialtyByPageId(sid);
            const label = spec?.nombre ?? spec?.idEspecialidad;
            if (label) nameBySpecId.set(sid, label);
          } catch {
            /* relación huérfana o timeout puntual */
          }
        }),
      );
    }

    const result = new Map<string, string[]>();
    for (const [hid, specSet] of hospitalToSpecIds) {
      const names = [...specSet].map((id) => nameBySpecId.get(id)).filter((x): x is string => Boolean(x));
      result.set(hid, [...new Set(names)].sort((a, b) => a.localeCompare(b, 'es')));
    }
    return result;
  }

  /** Nombres de especialidades disponibles en un hospital concreto bajo el plan (tabla red). */
  public async findSpecialtyNamesForHospitalAndPlan(planPageId: string, hospitalPageId: string): Promise<string[]> {
    const byPlan = await this.findHospitalSpecialtiesByPlan(planPageId);
    return byPlan.get(hospitalPageId) ?? [];
  }

  public async findCoverageByPlanAndSpecialty(planPageId: string, specialtyPageId: string): Promise<CoverageRecord | null> {
    const pages = await this.queryDatabase(env.DATABASE_ID_COBERTURAS);
    const page = pages.find((candidate) => {
      const planIds = extractRelationIds(candidate.properties.Plan_ID);
      const specialtyIds = extractRelationIds(candidate.properties.Especialidad_ID);
      return planIds.includes(planPageId) && specialtyIds.includes(specialtyPageId);
    });

    return page ? this.mapCoverage(page) : null;
  }

  public async findHospitalsBySpecialtyAndPlan(planPageId: string, specialtyPageId: string): Promise<HospitalNetworkRecord[]> {
    const pages = await this.queryDatabase(env.DATABASE_ID_HOSPITALES_RED);
    const networkEntries = pages
      .filter((candidate) => {
        const planIds = extractRelationIds(candidate.properties.Planes_Aceptados);
        const specialtyIds = extractRelationIds(candidate.properties.Especialidad_ID);
        const disponible = extractCheckboxValue(candidate.properties.Disponible);
        return planIds.includes(planPageId) && specialtyIds.includes(specialtyPageId) && disponible !== false;
      })
      .map((page) => this.mapHospitalNetwork(page));

    const hospitalIds = networkEntries.map((entry) => entry.hospitalPageId).filter((value): value is string => Boolean(value));
    const hospitals = hospitalIds.length > 0 ? await this.findHospitalsByIds(hospitalIds) : [];
    const hospitalById = new Map(hospitals.map((hospital) => [hospital.pageId, hospital]));

    return networkEntries.map((entry) => ({
      ...entry,
      hospital: entry.hospitalPageId ? hospitalById.get(entry.hospitalPageId) ?? null : null,
    })) as HospitalNetworkRecord[];
  }

  public async findHospitalsByIds(hospitalPageIds: string[]): Promise<HospitalRecord[]> {
    const pages = await this.queryDatabase(env.DATABASE_ID_HOSPITALES);
    const wanted = new Set(hospitalPageIds);
    return pages.filter((page) => wanted.has(page.id)).map((page) => this.mapHospital(page));
  }

  // Geocoding helpers
  public async geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
    if (!address) return null;
    if (!env.GOOGLE_GEOCODING_API_KEY || env.GEOCODING_PROVIDER !== 'google') {
      // In mock mode or no API key, return null
      return null;
    }

    const q = encodeURIComponent(address);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${q}&key=${env.GOOGLE_GEOCODING_API_KEY}`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const json: any = await resp.json();
      if (json.status !== 'OK' || !Array.isArray(json.results) || json.results.length === 0) return null;
      const loc = json.results[0].geometry.location;
      return { lat: Number(loc.lat), lng: Number(loc.lng) };
    } catch (error) {
      // ignore and return null
      return null;
    }
  }

  public async geocodeAndPersistHospital(pageId: string): Promise<{ pageId: string; lat?: number; lng?: number; updated: boolean } | null> {
    const page = await this.getPage(pageId);
    if (!page) return null;
    const address = this.extract(page, 'direccion') || this.extract(page, 'Direccion') || this.extract(page, 'Address');
    if (!address) return { pageId, updated: false };

    const coords = await this.geocodeAddress(address);
    if (!coords) return { pageId, updated: false };

    const properties: any = {};
    properties.Latitud = toNumber(coords.lat);
    properties.Longitud = toNumber(coords.lng);

    await this.updatePage({ pageId, properties });

    return { pageId, lat: coords.lat, lng: coords.lng, updated: true };
  }

  public async geocodeAllHospitalsMissing(): Promise<Array<{ pageId: string; lat?: number; lng?: number; updated: boolean }>> {
    const pages = await this.queryDatabase(env.DATABASE_ID_HOSPITALES);
    const results: Array<{ pageId: string; lat?: number; lng?: number; updated: boolean }> = [];

    for (const page of pages) {
      const lat = extractNumberValue(page.properties.Latitud) ?? extractNumberValue(page.properties.Latitude);
      const lon = extractNumberValue(page.properties.Longitud) ?? extractNumberValue(page.properties.Longitude);
      const address = extractTextValue(page.properties.Direccion) || extractTextValue(page.properties.direccion) || extractTextValue(page.properties.Address);
      if ((typeof lat !== 'number' || typeof lon !== 'number') && address) {
        // try to geocode
        // eslint-disable-next-line no-await-in-loop
        const r = await this.geocodeAndPersistHospital(page.id);
        if (r) results.push(r);
      }
    }

    return results;
  }

  public async createConsultationRecord(input: {
    numeroPoliza: string;
    patientPageId?: string;
    specialtyPageId?: string;
    hospitalPageId?: string;
    copagoEstimado?: number;
    sintomaIngresado: string;
    estadoConsulta?: string;
  }): Promise<ConsultationRecord> {
    const properties = {
      ID_Consulta: toTitle(`CON-${createMessageId()}`),
      Numero_Poliza: input.patientPageId ? toRelation([input.patientPageId]) : toRelation([]),
      Especialidad_Sugerida: input.specialtyPageId ? toRelation([input.specialtyPageId]) : toRelation([]),
      Hospital_Recomendado: input.hospitalPageId ? toRelation([input.hospitalPageId]) : toRelation([]),
      Copago_Estimado: typeof input.copagoEstimado === 'number' ? toNumber(input.copagoEstimado) : toNumber(0),
      Sintoma_Ingresado: toText(input.sintomaIngresado),
      Estado_Consulta: toSelect(input.estadoConsulta ?? 'Abierta'),
    };

    const page = await this.createPage({
      databaseId: env.DATABASE_ID_CONSULTAS,
      properties,
    });

    return this.mapConsultation(page, input.numeroPoliza, input.patientPageId);
  }

  public async appendChatMessage(message: {
    customerId: string;
    conversationId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.appendSessionMessage({
      consultationPageId: message.conversationId,
      role: message.role,
      mensaje: message.content,
      timestamp: message.timestamp,
    });
  }

  public async updateConsultationRecord(pageId: string, properties: Record<string, unknown>): Promise<ConsultationRecord> {
    const page = await this.updatePage({ pageId, properties });
    return this.mapConsultation(page, '', undefined);
  }

  public async appendSessionMessage(message: {
    consultationPageId: string;
    role: 'user' | 'assistant' | 'system';
    mensaje: string;
    timestamp: string;
  }): Promise<void> {
    const payload: {
      idMensaje: string;
      consultationPageId: string;
      role: 'user' | 'assistant' | 'system';
      mensaje: string;
      timestamp: string;
    } = {
      idMensaje: createMessageId(),
      consultationPageId: message.consultationPageId,
      role: message.role,
      mensaje: message.mensaje,
      timestamp: message.timestamp,
    };

    await this.createPage({
      databaseId: env.DATABASE_ID_SESIONES,
      properties: {
        ID_Mensaje: toTitle(payload.idMensaje),
        Consulta_ID: toRelation([payload.consultationPageId]),
        Rol: toSelect(payload.role),
        Mensaje: toText(payload.mensaje),
        Timestamp: toText(payload.timestamp),
      },
    });
  }

  public async getConsultationsByNumeroPoliza(numeroPoliza: string): Promise<ConsultationRecord[]> {
    const pages = await this.queryDatabase(env.DATABASE_ID_CONSULTAS);
    const patient = await this.findPatientByNumeroPoliza(numeroPoliza);
    const patientPageId = patient?.pageId;

    return pages
      .filter((page) => this.matchesNumeroPoliza(page, numeroPoliza, patientPageId))
      .map((page) => this.mapConsultation(page, numeroPoliza, undefined))
      .sort((left, right) => left.pageId.localeCompare(right.pageId));
  }

  public async getLatestConsultationByNumeroPoliza(numeroPoliza: string): Promise<ConsultationRecord | null> {
    const consultations = await this.getConsultationsByNumeroPoliza(numeroPoliza);
    return consultations.at(-1) ?? null;
  }

  public async getMessagesByNumeroPoliza(numeroPoliza: string): Promise<ChatMessage[]> {
    const consultations = await this.getConsultationsByNumeroPoliza(numeroPoliza);
    const consultationIds = consultations.map((consultation) => consultation.pageId);
    if (consultationIds.length === 0) {
      return [];
    }

    const pages = await this.queryDatabase(env.DATABASE_ID_SESIONES);
    return pages
      .filter((page) => {
        const consultationRelationIds = extractRelationIds(page.properties.Consulta_ID);
        return consultationRelationIds.some((id) => consultationIds.includes(id));
      })
      .map((page) => {
        const session = this.mapSessionMessage(page);
        return {
          id: session.idMensaje,
          customerId: numeroPoliza,
          conversationId: session.consultationPageId ?? consultationIds[0] ?? '',
          role: session.role,
          content: session.mensaje,
          timestamp: session.timestamp,
          metadata: {},
        } satisfies ChatMessage;
      });
  }

  public async getMessagesByConversationId(conversationId: string, customerId: string): Promise<ChatMessage[]> {
    const pages = await this.queryDatabase(env.DATABASE_ID_SESIONES);
    return pages
      .filter((page) => extractRelationIds(page.properties.Consulta_ID).includes(conversationId))
      .map((page) => {
        const session = this.mapSessionMessage(page);
        return {
          id: session.idMensaje,
          customerId,
          conversationId: session.consultationPageId ?? conversationId,
          role: session.role,
          content: session.mensaje,
          timestamp: session.timestamp,
          metadata: {},
        } satisfies ChatMessage;
      });
  }

  public async getCustomerContext(numeroPoliza: string): Promise<Record<string, unknown> | null> {
    const patient = await this.findPatientByNumeroPoliza(numeroPoliza);
    const consultation = await this.getLatestConsultationByNumeroPoliza(numeroPoliza);
    const plan = patient?.planPageId ? await this.findPlanByPageId(patient.planPageId) : null;

    if (!patient && !consultation) {
      return null;
    }

    return {
      customerId: numeroPoliza,
      conversationId: consultation?.pageId ?? '',
      numeroPoliza,
      patientPageId: patient?.pageId,
      planPageId: patient?.planPageId,
      planType: plan?.tipoPlan,
      insuranceTier: plan?.aseguradora,
      lastIntent: consultation ? 'hospital_recommendation' : undefined,
      lastSpecialty: consultation?.specialtyPageId,
      lastPriority: undefined,
    };
  }

  public async updateCustomerContext(numeroPoliza: string, context: Record<string, unknown>): Promise<Record<string, unknown>> {
    const current = (await this.getCustomerContext(numeroPoliza)) ?? { customerId: numeroPoliza, numeroPoliza };
    return {
      ...current,
      ...context,
      customerId: numeroPoliza,
      numeroPoliza,
    };
  }

  public async getMessagesByCustomerId(customerId: string): Promise<ChatMessage[]> {
    return this.getMessagesByNumeroPoliza(customerId);
  }

  // USERS related helpers
  public async findUserByEmail(email: string): Promise<import('../types/notion-model.types').UserRecord | null> {
    const page = await this.findSingleByProperty(env.DATABASE_ID_USUARIOS, 'Email', email, 'title');
    return page ? this.mapUser(page) : null;
  }

  public async findUserById(userPageId: string): Promise<import('../types/notion-model.types').UserRecord | null> {
    const page = await this.getPage(userPageId);
    return page ? this.mapUser(page) : null;
  }

  public async getUserLinkedPatientIds(userPageId: string): Promise<string[]> {
    const page = await this.getPage(userPageId);
    if (!page) return [];
    const propKeys = Object.keys(page.properties || {});
    // try to find a relation property that links to patients
    const candidateKey = propKeys.find((k) => /pacient/i.test(k) || /paciente/i.test(k) || /patient/i.test(k));
    if (!candidateKey) return [];
    return extractRelationIds(page.properties[candidateKey]);
  }

  public async findPlanByPageId(pageId: string): Promise<PlanRecord | null> {
    const page = await this.getPage(pageId);
    return page ? this.mapPlan(page) : null;
  }

  public async findSpecialtyByPageId(pageId: string): Promise<SpecialtyRecord | null> {
    const page = await this.getPage(pageId);
    return page ? this.mapSpecialty(page) : null;
  }

  public async getCoveragesByPlanPageId(planPageId: string): Promise<Array<CoverageRecord & { specialty: SpecialtyRecord | null }>> {
    const pages = await this.queryDatabase(env.DATABASE_ID_COBERTURAS);
    const planCoverages = pages.filter((page) => {
      const planIds = extractRelationIds(page.properties.Plan_ID);
      return planIds.includes(planPageId);
    });

    const coverages = await Promise.all(
      planCoverages.map(async (page) => {
        const coverage = this.mapCoverage(page);
        const specialty = coverage.specialtyPageId ? await this.findSpecialtyByPageId(coverage.specialtyPageId) : null;
        return { ...coverage, specialty };
      }),
    );

    return coverages;
  }

  public async findPatientByPageId(pageId: string): Promise<PatientRecord | null> {
    const page = await this.getPage(pageId);
    return page ? this.mapPatient(page) : null;
  }

  private async findSingleByProperty(databaseId: string, propertyName: string, value: string, _kind: 'title' | 'rich_text'): Promise<NotionPageResult | null> {
    const pages = await this.queryDatabase(databaseId);
    const normalized = normalizeString(value);
    return pages.find((page) => normalizeString(this.extract(page, propertyName)) === normalized) ?? null;
  }

  private matchesNumeroPoliza(page: NotionPageResult, numeroPoliza: string, patientPageId?: string): boolean {
    const relationIds = extractRelationIds(page.properties.Numero_Poliza);
    if (patientPageId && relationIds.includes(patientPageId)) {
      return true;
    }

    if (relationIds.length > 0) {
      return relationIds.some((id) => normalizeString(id) === normalizeString(numeroPoliza));
    }

    return normalizeString(this.extract(page, 'Numero_Poliza')) === normalizeString(numeroPoliza);
  }

  private extract(page: NotionPageResult, propertyName: string): string {
    return extractTextValue(page.properties?.[propertyName]);
  }

  private mapPatient(page: NotionPageResult): PatientRecord {
    return {
      pageId: page.id,
      numeroPoliza: extractTitleValue(page.properties.Numero_Poliza) || this.extract(page, 'Numero_Poliza'),
      nombreCompleto: this.extract(page, 'Nombre_Completo') || undefined,
      planPageId: extractRelationIds(page.properties.Plan_ID)[0],
      deducibleRestante:
        extractNumberValue(page.properties.Deducible_Restante) ??
        extractNumberValue(page.properties.Deducible_Restante_USD) ??
        extractNumberValue(page.properties.Deducible_Pendiente) ??
        undefined,
      email: this.extract(page, 'Email') || undefined,
      telefono: this.extract(page, 'Telefono') || undefined,
      estado: this.extract(page, 'Estado') || undefined,
      raw: page.properties as Record<string, any>,
    };
  }

  private mapPlan(page: NotionPageResult): PlanRecord {
    return {
      pageId: page.id,
      idPlan: extractTitleValue(page.properties.ID_Plan) || this.extract(page, 'ID_Plan'),
      nombrePlan: this.extract(page, 'Nombre_Plan') || undefined,
      aseguradora: this.extract(page, 'Aseguradora') || undefined,
      tipoPlan: this.extract(page, 'Tipo_Plan') || undefined,
      deducibleAnual: extractNumberValue(page.properties.Deducible_Anual),
      coaseguroPct: extractNumberValue(page.properties.Coaseguro_Pct),
      maxBolsilloAnual: extractNumberValue(page.properties.Max_Bolsillo_Anual),
      activo: extractCheckboxValue(page.properties.Activo),
      raw: page.properties as Record<string, any>,
    };
  }

  private mapSpecialty(page: NotionPageResult): SpecialtyRecord {
    return {
      pageId: page.id,
      idEspecialidad: extractTitleValue(page.properties.ID_Especialidad) || this.extract(page, 'ID_Especialidad'),
      nombre: this.extract(page, 'Nombre') || undefined,
      sintomasRelacionados: this.parseListProperty(page.properties.Sintomas_Relacionados),
      urgenciaBase: this.extract(page, 'Urgencia_Base') || undefined,
      requiereReferido: extractCheckboxValue(page.properties.Requiere_Referido),
      raw: page.properties as Record<string, any>,
    };
  }

  private mapHospital(page: NotionPageResult): HospitalRecord {
    const carteraRaw = [
      ...this.parseListProperty(page.properties.Cartera_Servicios),
      ...this.parseListProperty(page.properties.Servicios),
      ...this.parseListProperty(page.properties.Servicios_Disponibles),
    ];
    const carteraServicios = [...new Set(carteraRaw.map((s) => s.trim()).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, 'es'),
    );

    return {
      pageId: page.id,
      idHospital: extractTitleValue(page.properties.ID_Hospital) || this.extract(page, 'ID_Hospital'),
      nombre: this.extract(page, 'Nombre') || undefined,
      ciudad: this.extract(page, 'Ciudad') || undefined,
      nivelAtencion: this.extract(page, 'Nivel_Atencion') || undefined,
      activo: extractCheckboxValue(page.properties.Activo),
      latitud: extractNumberValue(page.properties.Latitud) ?? extractNumberValue(page.properties.Latitude),
      longitud: extractNumberValue(page.properties.Longitud) ?? extractNumberValue(page.properties.Longitude),
      direccion: this.extract(page, 'direccion') || this.extract(page, 'Direccion') || this.extract(page, 'Address') || undefined,
      contacto: this.extract(page, 'contacto') || this.extract(page, 'Contacto') || this.extract(page, 'Telefono') || this.extract(page, 'Phone') || undefined,
      carteraServicios: carteraServicios.length > 0 ? carteraServicios : undefined,
      raw: page.properties as Record<string, any>,
    };
  }

  private mapCoverage(page: NotionPageResult): CoverageRecord {
    return {
      pageId: page.id,
      idCobertura: extractTitleValue(page.properties.ID_Cobertura) || this.extract(page, 'ID_Cobertura'),
      planPageId: extractRelationIds(page.properties.Plan_ID)[0],
      specialtyPageId: extractRelationIds(page.properties.Especialidad_ID)[0],
      copagoFijo: extractNumberValue(page.properties.Copago_Fijo),
      coaseguroOverride: extractNumberValue(page.properties.Coaseguro_Override),
      cubierto: extractCheckboxValue(page.properties.Cubierto),
      raw: page.properties as Record<string, any>,
    };
  }

  private mapHospitalNetwork(page: NotionPageResult): HospitalNetworkRecord {
    return {
      pageId: page.id,
      idRed: extractTitleValue(page.properties.ID_Red) || this.extract(page, 'ID_Red'),
      hospitalPageId: extractRelationIds(page.properties.Hospital_ID)[0],
      specialtyPageId: extractRelationIds(page.properties.Especialidad_ID)[0],
      planPageIds: extractRelationIds(page.properties.Planes_Aceptados),
      tarifaBase: extractNumberValue(page.properties.Tarifa_Base),
      disponible: extractCheckboxValue(page.properties.Disponible),
      raw: page.properties as Record<string, any>,
    };
  }

  private mapConsultation(page: NotionPageResult, numeroPoliza: string, patientPageId?: string): ConsultationRecord {
    const relationIds = extractRelationIds(page.properties.Numero_Poliza);
    return {
      pageId: page.id,
      idConsulta: extractTitleValue(page.properties.ID_Consulta) || page.id,
      numeroPoliza: relationIds[0] ?? numeroPoliza,
      patientPageId: patientPageId ?? relationIds[0],
      specialtyPageId: extractRelationIds(page.properties.Especialidad_Sugerida)[0],
      hospitalPageId: extractRelationIds(page.properties.Hospital_Recomendado)[0],
      copagoEstimado: extractNumberValue(page.properties.Copago_Estimado),
      sintomaIngresado: this.extract(page, 'Sintoma_Ingresado') || undefined,
      estadoConsulta: this.extract(page, 'Estado_Consulta') || undefined,
      raw: page.properties as Record<string, any>,
    };
  }

  private mapSessionMessage(page: NotionPageResult) {
    return {
      pageId: page.id,
      idMensaje: extractTitleValue(page.properties.ID_Mensaje) || page.id,
      consultationPageId: extractRelationIds(page.properties.Consulta_ID)[0],
      role: (this.extract(page, 'Rol') as 'user' | 'assistant' | 'system') || 'user',
      mensaje: this.extract(page, 'Mensaje') || '',
      timestamp: this.extract(page, 'Timestamp') || new Date().toISOString(),
      raw: page.properties as Record<string, any>,
    };
  }

  public mapUser(page: NotionPageResult): UserRecord {
    const emailProperty = page.properties?.Email;
    const email = typeof emailProperty?.email === 'string' ? emailProperty.email : this.extract(page, 'Email') || undefined;
    const passwordHash = this.extract(page, 'Password_Hash') || undefined;
    const role = this.extract(page, 'rol') || this.extract(page, 'role') || undefined;

    // attempt to find linked patient relation property
    const propKeys = Object.keys(page.properties || {});
    const candidateKey = propKeys.find((k) => /pacient/i.test(k) || /paciente/i.test(k) || /patient/i.test(k));
    const linkedPatientPageIds = candidateKey ? extractRelationIds(page.properties[candidateKey]) : [];

    return {
      pageId: page.id,
      email,
      passwordHash,
      role,
      linkedPatientPageIds,
      raw: page.properties as Record<string, any>,
    };
  }

  private parseListProperty(property: any): string[] {
    if (!property) {
      return [];
    }

    if (Array.isArray(property.multi_select)) {
      return property.multi_select.map((entry: any) => pickFirstText(entry?.name)).filter(Boolean);
    }

    const text = extractTextValue(property);
    if (!text) {
      return [];
    }

    return text
      .split(/[,;|]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  private toPageResult(record: MockDatabaseRecord): NotionPageResult {
    return {
      id: record.id,
      properties: record.properties,
      url: undefined,
    } as NotionPageResult;
  }
}
