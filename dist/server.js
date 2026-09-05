"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = __importDefault(require("http"));
const app_1 = __importDefault(require("./app"));
const env_1 = require("./config/env");
const database_1 = require("./config/database");
const redis_1 = require("./config/redis");
const scheduler_1 = require("./jobs/scheduler");
const logger_1 = require("./utils/logger");
const chat_gateway_1 = require("./modules/chat/chat.gateway");
async function bootstrap() {
    try {
        await (0, database_1.connectDB)();
        await (0, redis_1.connectRedis)();
        const server = http_1.default.createServer(app_1.default);
        (0, chat_gateway_1.initSocketServer)(server);
        server.listen(env_1.env.PORT, () => {
            logger_1.logger.info(`Deemona Doctors API running`, {
                port: env_1.env.PORT,
                env: env_1.env.NODE_ENV,
                url: `http://localhost:${env_1.env.PORT}/api/${env_1.env.API_VERSION}`,
            });
        });
        (0, scheduler_1.startScheduler)();
        // Graceful shutdown
        const shutdown = async (signal) => {
            logger_1.logger.info(`${signal} received — shutting down gracefully`);
            server.close(() => {
                logger_1.logger.info('HTTP server closed');
                process.exit(0);
            });
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    }
    catch (err) {
        logger_1.logger.error('Bootstrap failed', { error: err.message });
        process.exit(1);
    }
}
bootstrap();
//# sourceMappingURL=server.js.map