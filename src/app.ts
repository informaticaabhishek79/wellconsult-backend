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

const app = express();

app.use(helmet());
app.use(cors({
  origin:      env.cors.allowedOrigins,
  credentials: true,
  methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(requestLogger);

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', version: env.API_VERSION, env: env.NODE_ENV })
);

const base = `/api/${env.API_VERSION}`;
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
app.use(`${base}`,               apiLimiter);

app.use(notFound);
app.use(errorHandler);

export default app;
