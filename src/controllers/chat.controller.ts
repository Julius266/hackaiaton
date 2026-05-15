import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { AiService } from '../services/ai.service';
import type { BusinessService } from '../services/business.service';
import type { ChatService } from '../services/chat.service';
import { wrapAsync } from '../utils/async-handler';
import { createCustomerId } from '../utils/id';

const chatMessageSchema = z.object({
  customerId: z.string().optional(),
  numeroPoliza: z.string().optional(),
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

    let customerId = payload.customerId ?? payload.numeroPoliza ?? createCustomerId();

    // If user is authenticated and has linked patients, enforce access control
    if (authUser?.linkedPatientPageIds && Array.isArray(authUser.linkedPatientPageIds) && authUser.linkedPatientPageIds.length > 0) {
      const linked: string[] = authUser.linkedPatientPageIds;
      if (payload.customerId) {
        // if provided customerId is not one of linked patient page ids, deny
        if (!linked.includes(payload.customerId)) {
          res.status(403).json({ success: false, message: 'Forbidden: no access to requested patient' });
          return;
        }
      } else if (!payload.numeroPoliza) {
        // default to first linked patient
        customerId = linked[0];
      }
    }
    const customerContext = await deps.chatService.updateCustomerContext(customerId, {
      ...payload.customerContext,
      metadata: payload.metadata,
    });

    const historyBeforeAnswer = await deps.chatService.getConversationHistory(customerId);
    const analysis = await deps.aiService.analyzeSymptoms(payload.message, customerContext, historyBeforeAnswer);
    const requiredData = deps.aiService.determineRequiredData(analysis);

    const businessData = await deps.businessService.fetchBusinessData({
      numeroPoliza: customerId,
      symptomText: payload.message,
      customerContext: {
        ...customerContext,
        ...payload.customerContext,
      },
      analysis: {
        specialty: analysis.specialty,
        priority: analysis.priority,
        intent: analysis.intent,
        requiredData: requiredData.requiredData,
      },
    });

    const consultationId = businessData.consultation.pageId;

    const userMessage = await deps.chatService.saveMessage({
      customerId,
      conversationId: consultationId,
      role: 'user',
      content: payload.message,
      timestamp: new Date().toISOString(),
      metadata: payload.metadata ?? {},
    });

    const assistantMessageText = await deps.aiService.generateFinalResponse({
      customerContext: {
        ...customerContext,
        lastIntent: analysis.intent,
        lastPriority: analysis.priority,
        lastSpecialty: analysis.specialty,
        consultationId,
        patientPageId: businessData.patient?.pageId,
        planPageId: businessData.plan?.pageId,
        specialtyPageId: businessData.specialty?.pageId,
        hospitalPageId: businessData.recommendedHospital?.pageId,
      },
      analysis,
      businessData,
      history: [...historyBeforeAnswer, userMessage],
    });

    const assistantMessage = await deps.chatService.saveMessage({
      customerId,
      conversationId: consultationId,
      role: 'assistant',
      content: assistantMessageText,
      timestamp: new Date().toISOString(),
      metadata: {
        analysis,
        businessData,
      },
    });

    const finalHistory = await deps.chatService.getConversationHistory(customerId);
    const finalContext = await deps.chatService.updateCustomerContext(customerId, {
      lastIntent: analysis.intent,
      lastPriority: analysis.priority,
      lastSpecialty: analysis.specialty,
      consultationId,
      patientPageId: businessData.patient?.pageId,
      planPageId: businessData.plan?.pageId,
      specialtyPageId: businessData.specialty?.pageId,
      hospitalPageId: businessData.recommendedHospital?.pageId,
    });

    res.status(200).json({
      success: true,
      data: {
        customerId,
        conversationId: consultationId,
        analysis,
        businessData,
        assistantMessage: assistantMessage.content,
        history: finalHistory,
        customerContext: finalContext,
      },
    });
  });
}

export function createChatHistoryController(chatService: ChatService): RequestHandler {
  return wrapAsync(async (req, res) => {
    const customerId = z.string().min(1).parse(req.params.customerId);
    const authUser = (req as any).user;
    if (authUser?.linkedPatientPageIds && Array.isArray(authUser.linkedPatientPageIds) && authUser.linkedPatientPageIds.length > 0) {
      const linked: string[] = authUser.linkedPatientPageIds;
      if (!linked.includes(customerId)) {
        res.status(403).json({ success: false, message: 'Forbidden: no access to requested patient' });
        return;
      }
    }
    const history = await chatService.getConversationHistory(customerId);
    const state = await chatService.getConversationState(customerId);

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
