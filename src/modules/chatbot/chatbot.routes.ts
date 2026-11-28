import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { sendSuccess } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';
import Anthropic from '@anthropic-ai/sdk';
import rateLimit from 'express-rate-limit';
import { authorize } from '../../middleware/authorize';
import { runVeda, confirmProposal } from './veda.agent';

const router = Router();

const SYSTEM_PROMPT = `You are Deemona Doctors's AI health assistant named "Veda" for an Indian holistic healthcare teleconsultation platform.

ABOUT DEEMONA DOCTORS:
- Indian holistic healthcare platform connecting patients with doctors via teleconsultation
- Medical systems: Allopathy, Homeopathy, Ayurveda, Yoga Therapy, Naturopathy, Unani
- Services: Video consultations, Chat consultations, Instant consultations with online doctors

HOW TO HELP PATIENTS:
1. Ask about their health concern and follow-up questions (duration, severity, location)
2. Based on symptoms, suggest which medical system might help
3. Guide them to book appointment or use instant consultation with online doctors

MEDICAL SYSTEMS:
- Allopathy: Modern medicine, acute conditions, infections
- Ayurveda: Chronic conditions, digestive issues, lifestyle diseases
- Homeopathy: Allergies, skin conditions, children health
- Yoga Therapy: Stress, anxiety, musculoskeletal issues
- Naturopathy: Detox, chronic conditions, preventive health
- Unani: Digestive, respiratory, skin conditions

RULES:
- Never diagnose definitively - always recommend consulting a doctor
- Keep responses concise (2-4 sentences max)
- Be warm, empathetic, professional
- If emergency (chest pain, difficulty breathing, severe bleeding) advise calling 112 immediately
- Communicate in English or Hindi as patient prefers`;

router.post('/chat', authenticate, async (req, res, next) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      throw new AppError(400, 'MISSING_FIELDS', 'messages array required.');
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: messages.slice(-10).map((m: any) => ({
        role: m.role,
        content: m.text || m.content || '',
      })),
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    sendSuccess(res, { text });
  } catch (e: any) {
    next(e);
  }
});

// ── Veda agent: thinks (triage, precautions) and acts (doctors, slots, booking proposals) ──
const agentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req: any) => req.user?.sub || req.ip,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many messages. Please wait a few minutes.' } },
});

router.post('/agent', authenticate, agentLimiter, async (req, res, next) => {
  try {
    const { messages, lang } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new AppError(400, 'MISSING_FIELDS', 'messages array required.');
    }
    const result = await runVeda(req.user!.sub, req.user!.role, messages, lang === 'hi' ? 'hi' : 'en');
    sendSuccess(res, result);
  } catch (e) { next(e); }
});

// The ONLY way a booking proposed by Veda is executed: the patient taps Confirm.
router.post('/confirm-booking', authenticate, authorize('patient'), async (req, res, next) => {
  try {
    const { proposal_id } = req.body;
    if (!proposal_id) throw new AppError(400, 'MISSING_FIELDS', 'proposal_id required.');
    sendSuccess(res, await confirmProposal(req.user!.sub, String(proposal_id)));
  } catch (e) { next(e); }
});

export default router;
