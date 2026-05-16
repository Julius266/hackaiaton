import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { AiService } from '../services/ai.service';
import type { BusinessService } from '../services/business.service';
import type { ChatService } from '../services/chat.service';
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
      language: z.string().optional(),
      notes: z.string().optional(),
    })
    .partial()
    .optional(),
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
    
    logger.debug(`Updating context for ${customerId}`);
    const customerContext = await deps.chatService.updateCustomerContext(customerId, {
      ...payload.customerContext,
      metadata: payload.metadata,
      conversationId: requestedConversationId,
    });

    const historyBeforeAnswer = requestedConversationId
      ? await deps.chatService.getConversationHistory(customerId, requestedConversationId)
      : [];
    
    logger.info('Analyzing symptoms with AI...');
    const analysis = await deps.aiService.analyzeSymptoms(payload.message, customerContext, historyBeforeAnswer);
    const requiredData = deps.aiService.determineRequiredData(analysis);

    logger.info(`Specialty detected: ${analysis.specialty}, Intent: ${analysis.intent}`);

    const businessData = await deps.businessService.fetchBusinessData({
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
    });

    await deps.chatService.saveMessage({
      customerId,
      conversationId: businessData.consultation.pageId,
      role: 'user',
      content: payload.message,
      timestamp: new Date().toISOString(),
      metadata: payload.metadata ?? {},
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
    
    logger.info(`Message processed successfully for ${customerId}`);

    res.status(200).json({
      success: true,
      data: {
        customerId,
        conversationId: resolvedConversationId,
        analysis,
        businessData,
        assistantMessage: assistantMessageContent,
        history: finalHistory,
        customerContext: finalCustomerContext,
      },
    });
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
