import type { BusinessData } from './business.types';
import type { ChatMessage, CustomerContext } from './chat.types';

export type AnalysisPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface SymptomAnalysis {
  intent: string;
  specialty: string;
  priority: AnalysisPriority;
  requiredData: string[];
  needsBusinessData: boolean;
  summary: string;
  followUpQuestions: string[];
  structuredSignal: string;
}

export interface AnalysisInput {
  message: string;
  customerContext: CustomerContext;
  history: ChatMessage[];
}

export interface FinalResponseInput {
  customerContext: CustomerContext;
  analysis: SymptomAnalysis;
  businessData: BusinessData;
  history: ChatMessage[];
}

export interface RequiredDataResult {
  requiredData: string[];
  needsBusinessData: boolean;
}
