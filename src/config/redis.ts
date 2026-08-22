import { createClient } from 'redis';
import { env } from './env';
import { logger } from '../utils/logger';

export const redis = createClient({ url: env.redis.url });

redis.on('error', (err) => logger.error('Redis error', { error: err.message }));
redis.on('connect', () => logger.info('Redis connected'));

export async function connectRedis(): Promise<void> {
  await redis.connect();
}

export async function setEx(key: string, ttlSeconds: number, value: string): Promise<void> {
  await redis.setEx(key, ttlSeconds, value);
}

export async function get(key: string): Promise<string | null> {
  return redis.get(key);
}

export async function del(key: string): Promise<void> {
  await redis.del(key);
}
