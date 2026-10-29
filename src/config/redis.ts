import { createClient } from 'redis';
import { env } from './env';
import { logger } from '../utils/logger';

export const redis = createClient({
  url: env.redis.url,
  socket: {
    tls: env.redis.url.startsWith('rediss://'),
    rejectUnauthorized: false,
    reconnectStrategy: (retries) => {
      if (retries > 5) return false; // stop retrying after 5 attempts
      return Math.min(retries * 1000, 5000);
    },
  },
});

redis.on('error', (err) => {
  logger.error('Redis error', { error: err.message });
  if (!redis.isOpen) {
    redis.connect().catch(() => {});
  }
});
redis.on('connect', () => logger.info('Redis connected'));

export async function connectRedis(): Promise<void> {
  try {
    await redis.connect();
  } catch (err) {
    logger.warn('Redis connection failed — continuing without Redis', { error: (err as Error).message });
  }
}

export async function setEx(key: string, ttlSeconds: number, value: string): Promise<void> {
  try { await redis.setEx(key, ttlSeconds, value); } catch { /* ignore */ }
}

export async function get(key: string): Promise<string | null> {
  try { return await redis.get(key); } catch { return null; }
}

export async function del(key: string): Promise<void> {
  try { await redis.del(key); } catch { /* ignore */ }
}