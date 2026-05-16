import type { RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { AiService } from '../services/ai.service';
import type { BusinessService } from '../services/business.service';
import type { ChatService } from '../services/chat.service';
import type { ChatProgressPayload } from '../types/chat-progress.types';
import { wrapAsync } from '../utils/async-handler';
import { createCustomerId } from '../utils/id';
import { logger } from '../utils/logger';

const chatMessageSchema = z.object({
  customerId: z.string().optional(),
  numeroPoliza: z.string().optional(),
  conversationId: z.string().optional(),
  message: z.string().min(1, 'El mensaje es obligatorio'),
  metadata: z.record(z.unknown()).optional(),
  customerContext: z
    .object({
      planType: z.string().optional(),
      insuranceTier: z.string().optional(),
      age: z.number().optional(),
      city: z.string().optional(),
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      language: z.string().optional(),
      notes: z.string().optional(),
    })
    .partial()
    .optional(),
  /** Si es true, la respuesta va en NDJSON: líneas `progress` y una final `complete`. */
  stream: z.boolean().optional(),
});

export function createChatMessageController(deps: {
  aiService: AiService;
  businessService: BusinessService;
  chatService: ChatService;
}): RequestHandler {
  return wrapAsync(async (req, res) => {
    const payload = chatMessageSchema.parse(req.body);
    const authUser = (req as any).user;
    const requestedConversationId = payload.conversationId;

    let customerId = payload.customerId ?? payload.numeroPoliza ?? createCustomerId();

    logger.info(`Processing message for customer: ${customerId}`);

    // If user is authenticated and has linked patients, enforce access control
    if (authUser?.linkedPatientPageIds && Array.isArray(authUser.linkedPatientPageIds) && authUser.linkedPatientPageIds.length > 0) {
      const linked: string[] = authUser.linkedPatientPageIds;
      if (payload.customerId) {
        // if provided customerId is not one of linked patient page ids, deny
        if (!linked.includes(payload.customerId)) {
          logger.warn(`Access denied for user ${authUser.id} to patient ${payload.customerId}`);
          res.status(403).json({ success: false, message: 'Forbidden: no access to requested patient' });
          return;
        }
      } else if (!payload.numeroPoliza) {
        // default to first linked patient
        customerId = linked[0];
      }
    }
    
    const streamed = payload.stream === true;

    const emit = (p: ChatProgressPayload) => {
      if (!streamed) return;
      (res as Response).write(JSON.stringify({ type: 'progress', ...p }) + '\n');
    };

    if (streamed) {
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      (res as Response).flushHeaders?.();
    }

    try {
      emit({
        phase: 'chat_context',
        label: 'Actualizando tu perfil y el hilo de la conversación…',
      });

      logger.debug(`Updating context for ${customerId}`);
      const customerContext = await deps.chatService.updateCustomerContext(customerId, {
        ...payload.customerContext,
        metadata: payload.metadata,
        conversationId: requestedConversationId,
      });

      const historyBeforeAnswer = requestedConversationId
        ? await deps.chatService.getConversationHistory(customerId, requestedConversationId)
        : [];

      emit({ phase: 'ai_analyze', label: 'Analizando tu mensaje con IA…' });
      logger.info('Analyzing symptoms with AI...');
      const analysis = await deps.aiService.analyzeSymptoms(payload.message, customerContext, historyBeforeAnswer);
      const requiredData = deps.aiService.determineRequiredData(analysis);

      emit({
        phase: 'ai_interpretation',
        label: 'Interpretación lista',
        detail: [
          analysis.specialty ? `Especialidad orientadora: ${analysis.specialty}` : null,
          `Prioridad: ${analysis.priority}`,
          analysis.intent ? `Intención: ${String(analysis.intent).replace(/_/g, ' ')}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      });

      logger.info(`Specialty detected: ${analysis.specialty}, Intent: ${analysis.intent}, Needs Business Data: ${analysis.needsBusinessData}`);

      let businessData: any = null;
      
      if (analysis.needsBusinessData) {
        businessData = await deps.businessService.fetchBusinessData({
          numeroPoliza: customerId,
          symptomText: payload.message,
          customerContext: {
            ...customerContext,
            ...payload.customerContext,
          },
          consultationPageId: requestedConversationId,
          analysis: {
            specialty: analysis.specialty,
            priority: analysis.priority,
            intent: analysis.intent,
            requiredData: requiredData.requiredData,
          },
          onChatProgress: emit,
        });
      } else {
        // Para respuestas simples, necesitamos asegurar que exista una consulta en Notion
        // para poder guardar los mensajes.
        let consultationId = requestedConversationId;
        
        if (!consultationId || consultationId.startsWith('new-')) {
          const newConsultation = await deps.notionService.createConsultationRecord({
            numeroPoliza: customerId,
            patientPageId: (customerContext as any).patientPageId,
            sintomaIngresado: payload.message.slice(0, 50),
            estadoConsulta: 'Abierta',
          });
          consultationId = newConsultation.pageId;
        }

        businessData = {
          consultation: { pageId: consultationId },
          hospitals: [],
          coverage: { coveragePercent: 0, estimatedCopay: 0, currency: 'USD' },
          decisionNotes: ['Skipped business data: not needed for this intent']
        };
      }

      await deps.chatService.saveMessage({
        customerId,
        conversationId: businessData.consultation.pageId,
        role: 'user',
        content: payload.message,
        timestamp: new Date().toISOString(),
        metadata: payload.metadata ?? {},
      });

      emit({ 
        phase: 'ai_response', 
        label: analysis.needsBusinessData 
          ? 'Generando respuesta con tus datos de cobertura y red…' 
          : 'Generando respuesta…' 
      });
      
      logger.info('Generating final AI response...');
      const assistantMessageText = await deps.aiService.generateFinalResponse({
        customerContext: {
          ...customerContext,
          lastIntent: analysis.intent,
          lastPriority: analysis.priority,
          lastSpecialty: analysis.specialty,
          consultationId: businessData.consultation.pageId,
          patientPageId: businessData.patient?.pageId,
          planPageId: businessData.plan?.pageId,
          specialtyPageId: businessData.specialty?.pageId,
          hospitalPageId: businessData.recommendedHospital?.pageId,
        },
        analysis,
        businessData,
        history: [...historyBeforeAnswer],
      });

      const resolvedConversationId = businessData.consultation.pageId;

      let assistantMessageContent = assistantMessageText;
      try {
        const assistantMessage = await deps.chatService.saveMessage({
          customerId,
          conversationId: resolvedConversationId,
          role: 'assistant',
          content: assistantMessageText,
          timestamp: new Date().toISOString(),
          metadata: {
            analysis,
            businessData,
          },
        });

        assistantMessageContent = assistantMessage.content;
      } catch (error) {
        logger.warn(`No se pudo guardar el mensaje del asistente para ${customerId}: ${(error as Error).message}`);
      }

      let finalHistory = historyBeforeAnswer;
      try {
        finalHistory = await deps.chatService.getConversationHistory(customerId, resolvedConversationId);
      } catch (error) {
        logger.warn(`No se pudo reconstruir el historial final para ${customerId}: ${(error as Error).message}`);
      }
      const finalCustomerContext = {
        ...customerContext,
        conversationId: resolvedConversationId,
      };

      emit({ phase: 'ai_response', label: 'Respuesta lista.' });

      logger.info(`Message processed successfully for ${customerId}`);

      const body = {
        success: true as const,
        data: {
          customerId,
          conversationId: resolvedConversationId,
          analysis,
          businessData,
          assistantMessage: assistantMessageContent,
          history: finalHistory,
          customerContext: finalCustomerContext,
        },
      };

      if (streamed) {
        (res as Response).write(JSON.stringify({ type: 'complete', ...body }) + '\n');
        res.end();
        return;
      }

      res.status(200).json(body);
    } catch (err) {
      if (streamed) {
        const message = err instanceof Error ? err.message : 'Error al procesar el mensaje';
        (res as Response).write(JSON.stringify({ type: 'error', message }) + '\n');
        res.end();
        return;
      }
      throw err;
    }
  });
}

export function createChatHistoryController(chatService: ChatService): RequestHandler {
  return wrapAsync(async (req, res) => {
    const customerId = z.string().min(1).parse(req.params.customerId);
    const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : undefined;
    const authUser = (req as any).user;
    
    if (authUser?.linkedPatientPageIds && Array.isArray(authUser.linkedPatientPageIds) && authUser.linkedPatientPageIds.length > 0) {
      const linked: string[] = authUser.linkedPatientPageIds;
      if (!linked.includes(customerId)) {
        res.status(403).json({ success: false, message: 'Forbidden: no access to requested patient' });
        return;
      }
    }

    // Si no hay conversationId, devolvemos la lista de sesiones disponibles para este usuario
    if (!conversationId) {
      const sessions = await chatService.getUserSessions(customerId);
      res.json({
        success: true,
        data: {
          customerId,
          sessions
        }
      });
      return;
    }

    // Si hay conversationId, devolvemos el historial de esa sesión específica
    const history = await chatService.getConversationHistory(customerId, conversationId);
    const state = await chatService.getConversationState(customerId, conversationId);

    res.json({
      success: true,
      data: {
        customerId,
        conversationId: state.conversationId,
        customerContext: state.context,
        messages: history,
      },
    });
  });
}

export function createChatDeleteController(chatService: ChatService): RequestHandler {
  return wrapAsync(async (req, res) => {
    const customerId = z.string().min(1).parse(req.params.customerId);
    const conversationId = z.string().min(1).parse(req.params.conversationId);
    const authUser = (req as any).user;
    
    if (authUser?.linkedPatientPageIds && Array.isArray(authUser.linkedPatientPageIds) && authUser.linkedPatientPageIds.length > 0) {
      const linked: string[] = authUser.linkedPatientPageIds;
      if (!linked.includes(customerId)) {
        res.status(403).json({ success: false, message: 'Forbidden: no access to requested patient' });
        return;
      }
    }

    await chatService.deleteSession(customerId, conversationId);

    res.json({
      success: true,
      message: 'Session deleted successfully'
    });
  });
}
