"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = void 0;
exports.query = query;
exports.queryOne = queryOne;
exports.withTransaction = withTransaction;
exports.connectDB = connectDB;
const pg_1 = require("pg");
const env_1 = require("./env");
const logger_1 = require("../utils/logger");
exports.pool = new pg_1.Pool({
    host: env_1.env.db.host,
    port: env_1.env.db.port,
    database: env_1.env.db.database,
    user: env_1.env.db.user,
    password: env_1.env.db.password,
    max: env_1.env.db.max,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: { rejectUnauthorized: false },
});
exports.pool.on('error', (err) => {
    logger_1.logger.error('Unexpected DB pool error', { error: err.message });
});
async function query(sql, params) {
    const start = Date.now();
    const { rows } = await exports.pool.query(sql, params);
    const duration = Date.now() - start;
    if (duration > 500)
        logger_1.logger.warn('Slow query detected', { sql, duration });
    return rows;
}
async function queryOne(sql, params) {
    const rows = await query(sql, params);
    return rows[0] ?? null;
}
async function withTransaction(fn) {
    const client = await exports.pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    }
    catch (err) {
        await client.query('ROLLBACK');
        throw err;
    }
    finally {
        client.release();
    }
}
async function connectDB() {
    const client = await exports.pool.connect();
    client.release();
    logger_1.logger.info('PostgreSQL connected', { host: env_1.env.db.host, db: env_1.env.db.database });
}
//# sourceMappingURL=database.js.map