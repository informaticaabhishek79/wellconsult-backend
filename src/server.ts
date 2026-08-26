import http from 'http';
import app from './app';
import { env } from './config/env';
import { connectDB } from './config/database';
import { connectRedis } from './config/redis';
import { startScheduler } from './jobs/scheduler';
import { logger } from './utils/logger';
import { initSocketServer } from './modules/chat/chat.gateway';

async function bootstrap(): Promise<void> {
  try {
    await connectDB();
    await connectRedis();

    const server = http.createServer(app);
    initSocketServer(server);

    server.listen(env.PORT, () => {
      logger.info(`WellConsult API running`, {
        port: env.PORT,
        env:  env.NODE_ENV,
        url:  `http://localhost:${env.PORT}/api/${env.API_VERSION}`,
      });
    });

    startScheduler();

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`${signal} received — shutting down gracefully`);
      server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

  } catch (err) {
    logger.error('Bootstrap failed', { error: (err as Error).message });
    process.exit(1);
  }
}

bootstrap();
