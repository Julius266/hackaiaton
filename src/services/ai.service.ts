import { env } from '../config/env';
import { FINAL_RESPONSE_PROMPT, SYSTEM_PROMPT } from '../config/systemPrompt';
import type { FinalResponseInput, RequiredDataResult, SymptomAnalysis } from '../types/ai.types';
import type { BusinessData } from '../types/business.types';
import type { ChatMessage, CustomerContext } from '../types/chat.types';
import { extractJsonCandidate, safeJsonParse } from '../utils/json';

interface CompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface CompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

const DEFAULT_ANALYSIS: SymptomAnalysis = {
  intent: 'general_information',
  specialty: 'Medicina General',
  priority: 'medium',
  requiredData: ['symptoms'],
  needsBusinessData: false,
  summary: 'Descripción general de síntomas sin señales agudas.',
  followUpQuestions: ['¿Desde cuánto tiempo lo tienes o qué lo empeora?'],
  structuredSignal: 'fallback',
};

function buildHeuristicAnalysis(message: string, customerContext: CustomerContext): SymptomAnalysis {
  const normalized = message.toLowerCase();
  const specialty = detectSpecialty(normalized);
  const priority = detectPriority(normalized);
  const intent = detectIntent(normalized, specialty, priority);
  const requiredData = buildRequiredData(intent, specialty, priority);
  const summary = `Síntomas interpretados para ${specialty.toLowerCase()} con prioridad ${priority}.`;
  const followUpQuestions = buildFollowUpQuestions(intent, specialty, priority);

  return {
    intent,
    specialty,
    priority,
    requiredData,
    needsBusinessData: requiredData.some((item) => ['hospitals', 'coverage', 'copay'].includes(item)),
    summary,
    followUpQuestions,
    structuredSignal: customerContext.planType ? `plan:${customerContext.planType}` : 'heuristic',
  };
}

function detectSpecialty(message: string): string {
  if (message.includes('pecho') || message.includes('corazón') || message.includes('cardi')) return 'Cardiología';
  if (message.includes('fract') || message.includes('hues') || message.includes('rodilla') || message.includes('espalda')) return 'Traumatología';
  if (message.includes('tos') || message.includes('respirar') || message.includes('pulm')) return 'Neumología';
  if (message.includes('vientre') || message.includes('estómago') || message.includes('náuse') || message.includes('vomit')) return 'Gastroenterología';
  if (message.includes('piel') || message.includes('rash') || message.includes('erup')) return 'Dermatología';
  if (message.includes('niño') || message.includes('bebé') || message.includes('pedi')) return 'Pediatría';
  if (message.includes('cabeza') || message.includes('neurol')) return 'Neurología';
  return 'Medicina General';
}

function detectPriority(message: string): SymptomAnalysis['priority'] {
  if (message.includes('urgente') || message.includes('desmayo') || message.includes('sangre') || message.includes('ahogo') || message.includes('dolor de pecho')) {
    return 'urgent';
  }

  if (message.includes('fuerte') || message.includes('intenso') || message.includes('mucho dolor') || message.includes('no puedo respirar')) {
    return 'high';
  }

  if (message.includes('molesto') || message.includes('persistente') || message.includes('varios días')) {
    return 'medium';
  }

  return 'low';
}

function detectIntent(message: string, specialty: string, priority: SymptomAnalysis['priority']): string {
  if (message.includes('cobertura') || message.includes('copago') || message.includes('seguro') || message.includes('aseguradora')) {
    return 'coverage_check';
  }

  if (priority === 'urgent' || specialty !== 'Medicina General') {
    return 'hospital_recommendation';
  }

  return 'triage';
}

function buildRequiredData(intent: string, specialty: string, priority: SymptomAnalysis['priority']): string[] {
  const required = new Set<string>(['symptoms']);

  if (intent === 'coverage_check') {
    required.add('coverage');
    required.add('planType');
  }

  if (intent === 'hospital_recommendation' || priority === 'urgent') {
    required.add('hospitals');
    required.add('copay');
    required.add('coverage');
  }

  if (specialty !== 'Medicina General') {
    required.add('specialty');
  }

  return Array.from(required);
}

/** Una sola pregunta de seguimiento; evita insistir en “más síntomas” cuando ya hay un motivo claro. */
function buildFollowUpQuestions(intent: string, _specialty: string, priority: SymptomAnalysis['priority']): string[] {
  if (priority === 'urgent') {
    return ['¿Hay ahora mismo dificultad para respirar, desmayo o dolor muy intenso?'];
  }
  if (intent === 'coverage_check') {
    return ['¿Qué plan o aseguradora tienes contratada?'];
  }
  return ['¿Desde cuánto tiempo lo tienes o qué lo empeora?'];
}

const MORE_SYMPTOMS_RE =
  /otros\s+síntom|más\s+síntom|síntomas\s+adicional|alguna\s+otra\s+molestia|tienes\s+más|más\s+molestias/i;

function messageSuggestsTimingAlready(message: string): boolean {
  if (
    /\b(esta\s+mañana|esta\s+tarde|esta\s+noche|desde\s+esta|desde\s+hoy|desde\s+ayer|toda\s+la\s+mañana|todo\s+el\s+d[ií]a)\b/i.test(
      message,
    )
  ) {
    return true;
  }
  return (
    /\b(hace|desde)\s+(\d+|unos?|varias?|varios?|mucho|poco|media|medias|ayer|hoy|esta)/i.test(message) ||
    /\b\d+\s*(h|hr|horas?|d[ií]as?|semanas?)\b/i.test(message)
  );
}

/** Limita y filtra preguntas del modelo para no repetir insistencia en síntomas extra. */
function capFollowUpQuestions(
  questions: string[],
  message: string,
  history: Array<Pick<ChatMessage, 'role' | 'content'>>,
): string[] {
  if (messageSuggestsTimingAlready(message)) {
    return [];
  }

  const msg = message.trim();
  const userAlreadyDescribedComplaint = msg.length >= 12;

  const cleaned = [...new Set(questions.map((q) => q.trim()).filter(Boolean))];

  const filtered = cleaned.filter((q) => {
    if (!userAlreadyDescribedComplaint) return true;
    return !MORE_SYMPTOMS_RE.test(q);
  });

  const durationFirst =
    filtered.find((q) => /cuánto\s+tiempo|cuándo|desde\s+cuándo|hace\s+cuánto|desde\s+hace/i.test(q)) ?? filtered[0];

  const recentAssistantTexts = history
    .filter((m) => m.role === 'assistant')
    .slice(-2)
    .map((m) => m.content?.toLowerCase() ?? '')
    .join(' ');
  if (durationFirst && MORE_SYMPTOMS_RE.test(recentAssistantTexts) && MORE_SYMPTOMS_RE.test(durationFirst)) {
    return [];
  }

  return durationFirst ? [durationFirst] : [];
}

function compactCustomerContext(customerContext: CustomerContext): Record<string, unknown> {
  return {
    customerId: customerContext.customerId,
    conversationId: customerContext.conversationId,
    numeroPoliza: customerContext.numeroPoliza,
    planType: customerContext.planType,
    insuranceTier: customerContext.insuranceTier,
    city: customerContext.city,
    latitude: customerContext.latitude,
    longitude: customerContext.longitude,
    language: customerContext.language,
    lastIntent: customerContext.lastIntent,
    lastSpecialty: customerContext.lastSpecialty,
    lastPriority: customerContext.lastPriority,
    notes: customerContext.notes,
  };
}

function policySummaryLikelyRedundant(history: ChatMessage[]): boolean {
  const assistantMsgs = history.filter((m) => m.role === 'assistant').slice(-2);
  if (assistantMsgs.length === 0) return false;
  const text = assistantMsgs.map((m) => m.content.toLowerCase()).join('\n');
  const mentionsInsurance =
    text.includes('póliza') || text.includes('poliza') || text.includes('plan') || text.includes('seguro');
  const mentionsMoney = text.includes('cobertura') || text.includes('copago') || text.includes('%');
  return mentionsInsurance && mentionsMoney;
}

function compactHistory(history: ChatMessage[]): Array<Pick<ChatMessage, 'role' | 'content' | 'timestamp'>> {
  return history.slice(-4).map((message) => ({
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
  }));
}

function buildBusinessFacts(businessData: BusinessData): Record<string, unknown> {
  return {
    estimationLegalNotice: businessData.estimationLegalNotice,
    patient: businessData.patient
      ? {
          numeroPoliza: businessData.patient.numeroPoliza,
          nombreCompleto: businessData.patient.nombreCompleto,
          deducibleRestante: businessData.patient.deducibleRestante,
        }
      : null,
    plan: businessData.plan
      ? {
          idPlan: businessData.plan.idPlan,
          nombrePlan: businessData.plan.nombrePlan,
          aseguradora: businessData.plan.aseguradora,
          tipoPlan: businessData.plan.tipoPlan,
        }
      : null,
    specialtyUsedForCoverage: businessData.specialty
      ? {
          idEspecialidad: businessData.specialty.idEspecialidad,
          nombre: businessData.specialty.nombre,
        }
      : null,
    symptomSuggestedSpecialty: businessData.symptomSuggestedSpecialty,
    primaryCareFirst: businessData.primaryCareFirst,
    coverage: {
      coveragePercent: businessData.coverage.coveragePercent,
      coverageLabel: businessData.coverage.coverageLabel,
      estimatedCopay: businessData.coverage.estimatedCopay,
      currency: businessData.coverage.currency,
      patientDeductibleRemaining: businessData.coverage.patientDeductibleRemaining,
    },
    hospitalsRankedByCopay: businessData.hospitals.slice(0, 8).map((h) => ({
      nombre: h.nombre,
      ciudad: h.ciudad,
      estimatedCopay: h.estimatedCopay,
      distanceKm: h.distanceKm,
      enRed: h.inNetwork !== false,
      portfolioFromSystem: (h.portfolioForPlan ?? []).slice(0, 15),
    })),
    recommendedHospital: businessData.recommendedHospital
      ? {
          idHospital: businessData.recommendedHospital.idHospital,
          nombre: businessData.recommendedHospital.nombre,
          ciudad: businessData.recommendedHospital.ciudad,
          nivelAtencion: businessData.recommendedHospital.nivelAtencion,
          direccion: businessData.recommendedHospital.direccion,
        }
      : null,
    recommendedMatchesUserSpecialtyRequest: businessData.recommendedMatchesUserSpecialtyRequest ?? false,
    recommendedHospitalDistanceKm: businessData.recommendedHospitalDistanceKm,
    recommendedHospitalSpecialties: businessData.recommendedHospitalSpecialties,
    recommendedHospitalServicios: businessData.recommendedHospitalServicios,
    recommendedHospitalPortfolio: businessData.recommendedHospitalPortfolio,
    hospitalsSortedBy: businessData.hospitalsSortedBy,
    mixedNearbyWithOsm: businessData.mixedNearbyWithOsm ?? false,
    hospitalWebEnrichment: businessData.hospitalWebEnrichment
      ? {
          fuente: businessData.hospitalWebEnrichment.fuente,
          proveedor: businessData.hospitalWebEnrichment.proveedor,
          consulta: businessData.hospitalWebEnrichment.consulta,
          avisoLegal: businessData.hospitalWebEnrichment.avisoLegal,
          fragmentos: businessData.hospitalWebEnrichment.fragmentos.map((f) => ({
            titulo: f.titulo,
            url: f.url,
            texto: f.texto.length > 450 ? `${f.texto.slice(0, 449)}…` : f.texto,
          })),
          instruccionModelo:
            'OBLIGATORIO si hay al menos un fragmento: en tu respuesta al paciente incluye 1–2 frases en lenguaje natural que digan QUÉ información concreta aportan estos fragmentos (servicios, especialidades o páginas citadas). Si mencionan la especialidad que busca el usuario, dilo con cautela; si NO la mencionan o son ambiguos, dilo explícitamente. No afirmes cobertura del seguro ni disponibilidad real. Indica que puede estar desactualizado y que debe confirmar con el hospital. Los fragmentos vienen de búsqueda web (proveedor en JSON: tavily, serper o ambos); no inventes nada fuera de estos textos.',
        }
      : null,
    /** Centros del mapa (p. ej. OSM) con búsqueda web por hospital; mismo uso que hospitalWebEnrichment. */
    centrosMapaEnriquecimientoWeb: businessData.hospitals
      .filter((h) => (h.webEnrichment?.fragmentos?.length ?? 0) > 0)
      .slice(0, 5)
      .map((h) => ({
        nombre: h.nombre,
        ciudad: h.ciudad,
        fueraDeRed: h.inNetwork === false,
        proveedor: h.webEnrichment!.proveedor,
        fragmentos: h.webEnrichment!.fragmentos.slice(0, 3).map((f) => ({
          titulo: f.titulo,
          url: f.url,
          texto: f.texto.length > 380 ? `${f.texto.slice(0, 379)}…` : f.texto,
        })),
        instruccionModelo:
          'Resume en una frase qué sugieren estos fragmentos sobre ese centro (servicios/especialidades). Si no aclaran la especialidad pedida, dilo. Solo orientación pública; confirmar con el hospital.',
      })),
    decisionNotes: businessData.decisionNotes.slice(0, 4),
  };
}

export class AiService {
  public async analyzeSymptoms(message: string, customerContext: CustomerContext, history: ChatMessage[]): Promise<SymptomAnalysis> {
    const fallbackAnalysis = buildHeuristicAnalysis(message, customerContext);
    const recentHistory = compactHistory(history);

    if (env.AI_PROVIDER === 'mock') {
      return {
        ...fallbackAnalysis,
        followUpQuestions: capFollowUpQuestions(fallbackAnalysis.followUpQuestions, message, history),
      };
    }

    try {
      const prompt = [
        SYSTEM_PROMPT,
        '',
        'Devuelve un JSON válido con esta estructura:',
        '{',
        '  "intent": "hospital_recommendation|coverage_check|triage|appointment_guidance|follow_up|general_information",',
        '  "specialty": "string",',
        '  "priority": "low|medium|high|urgent",',
        '  "requiredData": ["string"],',
        '  "needsBusinessData": true,',
        '  "summary": "string",',
        '  "followUpQuestions": ["string"],',
        '  "structuredSignal": "string"',
        '}',
        '',
        'Importante: "followUpQuestions" debe tener como máximo 1 elemento (o []). No pidas varias veces otros síntomas si el usuario ya dio el motivo.',
        '',
        `Contexto de cliente: ${JSON.stringify(compactCustomerContext(customerContext))}`,
        `Historial reciente: ${JSON.stringify(recentHistory)}`,
        `Mensaje actual: ${message}`,
      ].join('\n');

      const responseText = await this.callModelJson(prompt, message);
      const parsed = safeJsonParse<Partial<SymptomAnalysis>>(extractJsonCandidate(responseText), {});

      const rawFollowUps = Array.isArray(parsed.followUpQuestions)
        ? parsed.followUpQuestions
        : fallbackAnalysis.followUpQuestions;
      const mergedFollowUps = capFollowUpQuestions(rawFollowUps, message, recentHistory);

      return {
        ...fallbackAnalysis,
        ...parsed,
        requiredData: parsed.requiredData ?? fallbackAnalysis.requiredData,
        followUpQuestions: mergedFollowUps,
        needsBusinessData: typeof parsed.needsBusinessData === 'boolean' ? parsed.needsBusinessData : fallbackAnalysis.needsBusinessData,
      };
    } catch {
      return {
        ...fallbackAnalysis,
        followUpQuestions: capFollowUpQuestions(fallbackAnalysis.followUpQuestions, message, history),
      };
    }
  }

  public determineRequiredData(analysis: SymptomAnalysis): RequiredDataResult {
    const requiredData = new Set<string>(analysis.requiredData);

    if (analysis.intent === 'hospital_recommendation') {
      requiredData.add('hospitals');
      requiredData.add('coverage');
      requiredData.add('copay');
    }

    if (analysis.intent === 'coverage_check') {
      requiredData.add('coverage');
      requiredData.add('planType');
    }

    return {
      requiredData: Array.from(requiredData),
      needsBusinessData: analysis.needsBusinessData || requiredData.has('hospitals') || requiredData.has('coverage') || requiredData.has('copay'),
    };
  }

  public async generateFinalResponse(input: FinalResponseInput): Promise<string> {
    const fallback = this.buildFallbackFinalResponse(input.analysis, input.businessData, input.history);
    const recentHistory = compactHistory(input.history);
    const compactContext = compactCustomerContext(input.customerContext);
    const businessFacts = buildBusinessFacts(input.businessData);

    if (env.AI_PROVIDER === 'mock') {
      return fallback;
    }

    try {
      const omitInsuranceRecap = policySummaryLikelyRedundant(input.history);

      const prompt = [
        FINAL_RESPONSE_PROMPT,
        '',
        `Análisis estructurado: ${JSON.stringify(input.analysis)}`,
        `Datos requeridos detectados: ${JSON.stringify(input.analysis.requiredData)}`,
        `Pregunta sugerida (como máximo una; puede estar vacío): ${JSON.stringify(input.analysis.followUpQuestions.slice(0, 1))}`,
        `Datos útiles desde Notion: ${JSON.stringify(businessFacts)}`,
        `Contexto de cliente: ${JSON.stringify(compactContext)}`,
        `Historial reciente: ${JSON.stringify(recentHistory)}`,
        `omitInsuranceRecap (no repetir póliza/plan/cobertura/copago si es true): ${omitInsuranceRecap}`,
        omitInsuranceRecap
          ? 'En este turno NO incluyas número de póliza, nombre largo del plan, porcentaje de cobertura ni copago. El usuario ya los vio; ve al consejo clínico, bienestar, médico general primero, hospital y cartera SOLO desde datos del sistema o desde hospitalWebEnrichment si viene.'
          : 'Puedes mencionar de forma breve plan/cobertura/copago una sola vez si aporta valor.',
        input.businessData.hospitalWebEnrichment ||
        input.businessData.hospitals.some((h) => (h.webEnrichment?.fragmentos?.length ?? 0) > 0)
          ? 'Enriquecimiento web en «Datos útiles» (hospitalWebEnrichment y/o centrosMapaEnriquecimientoWeb): lee fragmentos + instruccionModelo de cada bloque. DEBES expresar en tu respuesta QUÉ dicen esos textos (servicios o especialidades mencionadas, o que no permiten concluir sobre lo que el usuario busca); no basta con decir que hubo búsqueda en internet. Prioriza datos Notion cuando existan listas en sistema.'
          : '',
        `Orden de hospitales en datos (hospitalsSortedBy): "${input.businessData.hospitalsSortedBy}". Si es "distance", el primero es el más cercano según la ubicación enviada; habla de proximidad de forma coherente con recommendedHospitalDistanceKm. Si es "copay", el primero es el de menor copago estimado entre los que tienes. No llames "cercano" a un hospital si recommendedHospitalDistanceKm es muy alto salvo que aclares que es el menos lejano entre los de la lista.`,
        'Si hay datos en Notion (listas de especialidades/cartera), úsalos con prioridad sobre la web. Solo incluye UNA pregunta breve al final si la pregunta sugerida aplica; si el array está vacío o ya contestaron antes, no preguntes.',
        '',
        'Responde solo en texto natural y útil para el paciente.',
      ].join('\n');

      return await this.callModelText(prompt);
    } catch {
      return fallback;
    }
  }

  private buildFallbackFinalResponse(analysis: SymptomAnalysis, businessData: BusinessData, history: ChatMessage[]): string {
    const hosp = businessData.recommendedHospital;
    const distKm = businessData.recommendedHospitalDistanceKm;
    const portfolio =
      businessData.recommendedHospitalPortfolio?.length > 0
        ? businessData.recommendedHospitalPortfolio
        : businessData.recommendedHospitalSpecialties ?? [];
    const specs = portfolio.length > 0 ? portfolio.slice(0, 12).join(', ') : '';

    const nearest =
      hosp &&
      (distKm != null
        ? businessData.hospitalsSortedBy === 'distance'
          ? `En tu red, priorizando cercanía a tu ubicación, una opción es ${hosp.nombre ?? hosp.idHospital}${hosp.ciudad ? ` (${hosp.ciudad})` : ''}, aprox. ${Math.round(distKm)} km.`
          : `En tu red puedes valorar ${hosp.nombre ?? hosp.idHospital}${hosp.ciudad ? ` (${hosp.ciudad})` : ''}; según tu ubicación figura aprox. ${Math.round(distKm)} km.`
        : `En tu red puedes acudir a ${hosp.nombre ?? hosp.idHospital}${hosp.ciudad ? ` en ${hosp.ciudad}` : ''}.`);

    const specLine = specs
      ? ` Según los datos cargados en el sistema para ese centro y tu red, figuran entre otros: ${specs}.`
      : '';

    const web = businessData.hospitalWebEnrichment;
    let webLine = '';
    if (web && web.fragmentos.length > 0) {
      const joined = web.fragmentos
        .slice(0, 2)
        .map((f) => f.texto)
        .join(' ')
        .trim();
      const clipped = joined.length > 380 ? `${joined.slice(0, 379)}…` : joined;
      const prov =
        web.proveedor === 'tavily_serper'
          ? 'Tavily y Serper'
          : web.proveedor === 'serper'
            ? 'Serper'
            : 'Tavily';
      webLine = ` Lo que aparece en fuentes públicas (${prov}) sobre ese centro indica, de forma no verificada: ${clipped} ${web.avisoLegal}`;
    }

    const osmWebLines = businessData.hospitals
      .filter((h) => (h.webEnrichment?.fragmentos?.length ?? 0) > 0)
      .slice(0, 2)
      .map((h) => {
        const fr = h.webEnrichment!.fragmentos.slice(0, 1).map((f) => f.texto).join(' ').trim();
        const clip = fr.length > 200 ? `${fr.slice(0, 199)}…` : fr;
        return ` ${h.nombre ?? 'Centro'} (mapa): ${clip}`;
      })
      .join('');

    const gp =
      businessData.primaryCareFirst && businessData.symptomSuggestedSpecialty?.nombre
        ? ` Lo habitual es que primero te vea medicina general o tu médico tratante; si hace falta, te canalizarán (por ejemplo hacia ${businessData.symptomSuggestedSpecialty.nombre}).`
        : businessData.primaryCareFirst
          ? ' Lo habitual es valorarlo primero con medicina general o tu médico tratante antes de ir directo a un especialista.'
          : '';

    const omitInsuranceRecap = policySummaryLikelyRedundant(history);

    const wellness =
      ' Mientras consigues cita: hidrátate bien, descansa en un lugar tranquilo y evita exceso de pantalla si la luz te molesta.';

    const insurance = omitInsuranceRecap
      ? ''
      : ` Cobertura orientativa ~${Math.round(businessData.coverage.coveragePercent * 100)}%, copago estimado ~${businessData.coverage.estimatedCopay} ${businessData.coverage.currency}.`;

    const urgent =
      analysis.priority === 'urgent'
        ? ' Si aparece debilidad, confusión repentina, fiebre muy alta o el peor dolor de cabeza de tu vida, busca urgencias.'
        : '';

    const tailWeb = `${webLine}${osmWebLines}`;
    const firstPart = nearest
      ? `${nearest}${specLine}${tailWeb}`
      : tailWeb.trim()
        ? `${tailWeb.trim()} Sin hospital de red identificado en estos datos; revisa tu póliza o app del seguro.`
        : 'No hay un hospital de red concreto en estos datos; revisa tu póliza o app del seguro.';

    const parts = [
      firstPart,
      gp,
      wellness,
      urgent,
      insurance,
    ];

    return parts.filter(Boolean).join('').trim();
  }

  private async callModelJson(prompt: string, userMessage: string): Promise<string> {
    if (env.AI_PROVIDER === 'openrouter') {
      return this.callOpenAiCompatible({
        baseUrl: env.OPENROUTER_BASE_URL,
        apiKey: env.OPENROUTER_API_KEY,
        model: env.OPENROUTER_MODEL,
        jsonMode: true,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: userMessage },
        ],
      });
    }

    if (env.AI_PROVIDER === 'openai') {
      return this.callOpenAiCompatible({
        baseUrl: env.OPENAI_BASE_URL,
        apiKey: env.OPENAI_API_KEY,
        model: env.OPENAI_MODEL,
        jsonMode: true,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: userMessage },
        ],
      });
    }

    return this.callGeminiJson(prompt, userMessage);
  }

  private async callModelText(prompt: string): Promise<string> {
    if (env.AI_PROVIDER === 'openrouter') {
      return this.callOpenAiCompatible({
        baseUrl: env.OPENROUTER_BASE_URL,
        apiKey: env.OPENROUTER_API_KEY,
        model: env.OPENROUTER_MODEL,
        jsonMode: false,
        messages: [{ role: 'system', content: prompt }],
      });
    }

    if (env.AI_PROVIDER === 'openai') {
      return this.callOpenAiCompatible({
        baseUrl: env.OPENAI_BASE_URL,
        apiKey: env.OPENAI_API_KEY,
        model: env.OPENAI_MODEL,
        jsonMode: false,
        messages: [{ role: 'system', content: prompt }],
      });
    }

    return this.callGeminiText(prompt);
  }

  private async callOpenAiCompatible(input: {
    baseUrl: string;
    apiKey: string;
    model: string;
    messages: CompletionMessage[];
    jsonMode?: boolean;
  }): Promise<string> {
    if (!input.apiKey) {
      throw new Error('AI provider missing API key');
    }

    const response = await fetch(`${input.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.apiKey}`,
        ...(env.AI_PROVIDER === 'openrouter'
          ? {
              'HTTP-Referer': 'http://localhost',
              'X-Title': 'Estimador Agéntico de Copago y Cobertura',
            }
          : {}),
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        temperature: 0.2,
        ...(input.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    });

    if (!response.ok) {
      throw new Error(`AI request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as CompletionResponse;
    return payload.choices?.[0]?.message?.content ?? '';
  }

  private async callGeminiJson(prompt: string, userMessage: string): Promise<string> {
    if (!env.GEMINI_API_KEY) {
      throw new Error('Gemini API key is missing');
    }

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `${prompt}\n\nMensaje del usuario: ${userMessage}`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Gemini request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as GeminiResponse;
    return payload.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }

  private async callGeminiText(prompt: string): Promise<string> {
    if (!env.GEMINI_API_KEY) {
      throw new Error('Gemini API key is missing');
    }

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: prompt,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.4,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Gemini request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as GeminiResponse;
    return payload.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }
}
