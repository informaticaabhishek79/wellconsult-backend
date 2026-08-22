import { Pool, PoolClient } from 'pg';
import { env } from './env';
import { logger } from '../utils/logger';

export const pool = new Pool({
  host:     env.db.host,
  port:     env.db.port,
  database: env.db.database,
  user:     env.db.user,
  password: env.db.password,
  max:      env.db.max,
  idleTimeoutMillis:    30000,
  connectionTimeoutMillis: 5000,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  logger.error('Unexpected DB pool error', { error: err.message });
});

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const start = Date.now();
  const { rows } = await pool.query(sql, params);
  const duration = Date.now() - start;
  if (duration > 500) logger.warn('Slow query detected', { sql, duration });
  return rows as T[];
}

export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function connectDB(): Promise<void> {
  const client = await pool.connect();
  client.release();
  logger.info('PostgreSQL connected', { host: env.db.host, db: env.db.database });
}
