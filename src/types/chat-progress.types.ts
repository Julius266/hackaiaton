/** Fases emitidas al cliente cuando `stream: true` en POST /chat/message (orden aproximado). */
export type ChatProgressPhase =
  | 'chat_context'
  | 'ai_analyze'
  | 'ai_interpretation'
  | 'patient_plan'
  | 'specialty_coverage'
  | 'hospital_network'
  | 'nearby_osm'
  | 'economics'
  | 'hospital_portfolio'
  | 'web_enrichment'
  | 'consultation'
  | 'ai_response';

export interface ChatProgressPayload {
  phase: ChatProgressPhase;
  label: string;
  detail?: string;
}
