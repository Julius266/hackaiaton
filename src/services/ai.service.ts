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
  followUpQuestions: ['¿Desde cuándo comenzaron los síntomas?', '¿Hay fiebre, dolor fuerte o dificultad para respirar?'],
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

function buildFollowUpQuestions(intent: string, specialty: string, priority: SymptomAnalysis['priority']): string[] {
  const questions = ['¿Desde cuándo comenzaron los síntomas?'];

  if (intent === 'coverage_check') {
    questions.push('¿Qué tipo de plan o seguro tiene el paciente?');
  }

  if (priority === 'urgent') {
    questions.push('¿Hay dificultad para respirar, desmayo o dolor muy intenso ahora mismo?');
  }

  if (specialty !== 'Medicina General') {
    questions.push(`¿Los síntomas están relacionados con ${specialty.toLowerCase()} o con otra molestia adicional?`);
  }

  return questions;
}

export class AiService {
  public async analyzeSymptoms(message: string, customerContext: CustomerContext, history: ChatMessage[]): Promise<SymptomAnalysis> {
    const fallbackAnalysis = buildHeuristicAnalysis(message, customerContext);

    if (env.AI_PROVIDER === 'mock') {
      return fallbackAnalysis;
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
        `Contexto de cliente: ${JSON.stringify(customerContext)}`,
        `Historial reciente: ${JSON.stringify(history.slice(-6))}`,
        `Mensaje actual: ${message}`,
      ].join('\n');

      const responseText = await this.callModelJson(prompt, message);
      const parsed = safeJsonParse<Partial<SymptomAnalysis>>(extractJsonCandidate(responseText), {});

      return {
        ...fallbackAnalysis,
        ...parsed,
        requiredData: parsed.requiredData ?? fallbackAnalysis.requiredData,
        followUpQuestions: parsed.followUpQuestions ?? fallbackAnalysis.followUpQuestions,
        needsBusinessData: typeof parsed.needsBusinessData === 'boolean' ? parsed.needsBusinessData : fallbackAnalysis.needsBusinessData,
      };
    } catch {
      return fallbackAnalysis;
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
    const fallback = this.buildFallbackFinalResponse(input.analysis, input.businessData);

    if (env.AI_PROVIDER === 'mock') {
      return fallback;
    }

    try {
      const prompt = [
        FINAL_RESPONSE_PROMPT,
        '',
        `Análisis estructurado: ${JSON.stringify(input.analysis)}`,
        `Datos de negocio: ${JSON.stringify(input.businessData)}`,
        `Contexto de cliente: ${JSON.stringify(input.customerContext)}`,
        `Historial reciente: ${JSON.stringify(input.history.slice(-8))}`,
        '',
        'Responde solo en texto natural y útil para el paciente.',
      ].join('\n');

      return await this.callModelText(prompt);
    } catch {
      return fallback;
    }
  }

  private buildFallbackFinalResponse(analysis: SymptomAnalysis, businessData: BusinessData): string {
    const hospitalLine = businessData.recommendedHospital
      ? `Hospital recomendado: ${businessData.recommendedHospital.nombre ?? businessData.recommendedHospital.idHospital}.`
      : 'No se encontró una recomendación de hospital más precisa en este momento.';

    const urgencyLine =
      analysis.priority === 'urgent'
        ? 'La prioridad es alta: si el paciente tiene dolor de pecho fuerte, dificultad para respirar o desmayo, se recomienda atención inmediata.'
        : `Prioridad detectada: ${analysis.priority}.`;

    return [
      `Detecté una posible especialidad de ${businessData.specialty?.nombre ?? analysis.specialty}.`,
      urgencyLine,
      `Cobertura estimada: ${Math.round(businessData.coverage.coveragePercent * 100)}%.`,
      `Copago estimado: ${businessData.coverage.estimatedCopay}.`,
      hospitalLine,
      'Este resultado es una estimación operativa del backend y puede ajustarse al esquema final de Notion.',
    ].join(' ');
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
