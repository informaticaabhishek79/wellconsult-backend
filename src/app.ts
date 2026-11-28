import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { requestLogger } from './middleware/requestLogger';
import { errorHandler, notFound } from './middleware/errorHandler';
import { apiLimiter } from './middleware/rateLimiter';

import authRoutes          from './modules/auth/auth.routes';
import doctorsRoutes       from './modules/doctors/doctors.routes';
import appointmentsRoutes  from './modules/appointments/appointments.routes';
import notificationsRoutes from './modules/notifications/notifications.routes';
import adminRoutes         from './modules/admin/admin.routes';
import onboardingRoutes    from './modules/onboarding/onboarding.routes';
import patientsRoutes      from './modules/patients/patients.routes';
import consultationsRoutes from './modules/consultations/consultations.routes';
import prescriptionsRoutes from './modules/prescriptions/prescriptions.routes';
import reviewsRoutes from './modules/reviews/reviews.routes';
import videoRoutes from './modules/video/video.routes';
import oauthRoutes from './modules/auth/oauth.routes';
import verificationRoutes from './modules/doctors/verification.routes';
import legalRoutes from './modules/admin/legal.routes';
import chatRoutes from './modules/chat/chat.routes';
import chatbotRoutes from './modules/chatbot/chatbot.routes';
import placesRoutes from './modules/places/places.routes';
import billingRoutes from './modules/billing/billing.routes';
import instantRoutes from './modules/billing/instant.routes';
import clinicalRoutes from './modules/clinical/clinical.routes';
import readingsRoutes from './modules/clinical/readings.routes';
import familyRoutes from './modules/family/family.routes';
import scheduleRoutes from './modules/doctors/schedule.routes';
import supportRoutes from './modules/support/support.routes';
import agentsRoutes from './modules/agents/agents.routes';
import subscriptionRoutes from './modules/subscriptions/subscriptions.routes';
import paymentRoutes from './modules/payments/payments.routes';
import agoraRoutes from './modules/agora/agora.routes';
import adminDoctorsRoutes from './modules/admin/doctors.routes';

const app = express();
app.set('trust proxy', 1); // Trust Render's proxy

app.use(helmet());
app.use(cors({
  origin:      env.cors.allowedOrigins,
  credentials: true,
  methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));
app.use(compression());
app.use(express.json({ limit: '10mb', verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(requestLogger);

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', version: env.API_VERSION, env: env.NODE_ENV })
);

const base = `${process.env.API_PREFIX ?? '/api'}/${env.API_VERSION}`;
app.use(`${base}/auth`,          authRoutes);
app.use(`${base}/doctors`,       doctorsRoutes);
app.use(`${base}/appointments`,  appointmentsRoutes);
app.use(`${base}/notifications`, notificationsRoutes);
app.use(`${base}/admin`,         adminRoutes);
app.use(`${base}/onboarding`,    onboardingRoutes);
app.use(`${base}/patients`,      patientsRoutes);
app.use(`${base}/consultations`, consultationsRoutes);
app.use(`${base}/prescriptions`, prescriptionsRoutes);
app.use(`${base}/reviews`, reviewsRoutes);
app.use(`${base}/video`, videoRoutes);
app.use(`${base}/auth`, oauthRoutes);
app.use(`${base}/verification`, verificationRoutes);
app.use(`${base}/legal`, legalRoutes);
app.use(`${base}/chat`, chatRoutes);
app.use(`${base}/chatbot`, chatbotRoutes);
app.use(`${base}/places`, placesRoutes);
app.use(`${base}/billing`, billingRoutes);
app.use(`${base}/instant`, instantRoutes);
app.use(`${base}/clinical`, clinicalRoutes);
app.use(`${base}/tracker`, readingsRoutes);
app.use(`${base}/family`, familyRoutes);
app.use(`${base}/schedule`, scheduleRoutes);
app.use(`${base}/support`, supportRoutes);
app.use(`${base}/agents`, agentsRoutes);
app.use(`${base}/subscriptions`, subscriptionRoutes);
app.use(`${base}/payments`, paymentRoutes);
app.use(`${base}/agora`, agoraRoutes);
app.use(`${base}/admin/doctors`, adminDoctorsRoutes);
app.use(`${base}`,               apiLimiter);

app.use(notFound);
app.use(errorHandler);

export default app;
