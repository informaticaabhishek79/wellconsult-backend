"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const compression_1 = __importDefault(require("compression"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const env_1 = require("./config/env");
const requestLogger_1 = require("./middleware/requestLogger");
const errorHandler_1 = require("./middleware/errorHandler");
const rateLimiter_1 = require("./middleware/rateLimiter");
const auth_routes_1 = __importDefault(require("./modules/auth/auth.routes"));
const doctors_routes_1 = __importDefault(require("./modules/doctors/doctors.routes"));
const appointments_routes_1 = __importDefault(require("./modules/appointments/appointments.routes"));
const notifications_routes_1 = __importDefault(require("./modules/notifications/notifications.routes"));
const admin_routes_1 = __importDefault(require("./modules/admin/admin.routes"));
const onboarding_routes_1 = __importDefault(require("./modules/onboarding/onboarding.routes"));
const patients_routes_1 = __importDefault(require("./modules/patients/patients.routes"));
const consultations_routes_1 = __importDefault(require("./modules/consultations/consultations.routes"));
const prescriptions_routes_1 = __importDefault(require("./modules/prescriptions/prescriptions.routes"));
const reviews_routes_1 = __importDefault(require("./modules/reviews/reviews.routes"));
const video_routes_1 = __importDefault(require("./modules/video/video.routes"));
const oauth_routes_1 = __importDefault(require("./modules/auth/oauth.routes"));
const verification_routes_1 = __importDefault(require("./modules/doctors/verification.routes"));
const legal_routes_1 = __importDefault(require("./modules/admin/legal.routes"));
const chat_routes_1 = __importDefault(require("./modules/chat/chat.routes"));
const chatbot_routes_1 = __importDefault(require("./modules/chatbot/chatbot.routes"));
const agents_routes_1 = __importDefault(require("./modules/agents/agents.routes"));
const subscriptions_routes_1 = __importDefault(require("./modules/subscriptions/subscriptions.routes"));
const payments_routes_1 = __importDefault(require("./modules/payments/payments.routes"));
const agora_routes_1 = __importDefault(require("./modules/agora/agora.routes"));
const doctors_routes_2 = __importDefault(require("./modules/admin/doctors.routes"));
const app = (0, express_1.default)();
app.set('trust proxy', 1); // Trust Render's proxy
app.use((0, helmet_1.default)());
app.use((0, cors_1.default)({
    origin: env_1.env.cors.allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));
app.use((0, compression_1.default)());
app.use(express_1.default.json({ limit: '10mb' }));
app.use(express_1.default.urlencoded({ extended: true }));
app.use((0, cookie_parser_1.default)());
app.use(requestLogger_1.requestLogger);
app.get('/health', (_req, res) => res.json({ status: 'ok', version: env_1.env.API_VERSION, env: env_1.env.NODE_ENV }));
const base = `/api/${env_1.env.API_VERSION}`;
app.use(`${base}/auth`, auth_routes_1.default);
app.use(`${base}/doctors`, doctors_routes_1.default);
app.use(`${base}/appointments`, appointments_routes_1.default);
app.use(`${base}/notifications`, notifications_routes_1.default);
app.use(`${base}/admin`, admin_routes_1.default);
app.use(`${base}/onboarding`, onboarding_routes_1.default);
app.use(`${base}/patients`, patients_routes_1.default);
app.use(`${base}/consultations`, consultations_routes_1.default);
app.use(`${base}/prescriptions`, prescriptions_routes_1.default);
app.use(`${base}/reviews`, reviews_routes_1.default);
app.use(`${base}/video`, video_routes_1.default);
app.use(`${base}/auth`, oauth_routes_1.default);
app.use(`${base}/verification`, verification_routes_1.default);
app.use(`${base}/legal`, legal_routes_1.default);
app.use(`${base}/chat`, chat_routes_1.default);
app.use(`${base}/chatbot`, chatbot_routes_1.default);
app.use(`${base}/agents`, agents_routes_1.default);
app.use(`${base}/subscriptions`, subscriptions_routes_1.default);
app.use(`${base}/payments`, payments_routes_1.default);
app.use(`${base}/agora`, agora_routes_1.default);
app.use(`${base}/admin/doctors`, doctors_routes_2.default);
app.use(`${base}`, rateLimiter_1.apiLimiter);
app.use(errorHandler_1.notFound);
app.use(errorHandler_1.errorHandler);
exports.default = app;
//# sourceMappingURL=app.js.map