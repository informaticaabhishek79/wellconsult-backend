"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redis = void 0;
exports.connectRedis = connectRedis;
exports.setEx = setEx;
exports.get = get;
exports.del = del;
const redis_1 = require("redis");
const env_1 = require("./env");
const logger_1 = require("../utils/logger");
exports.redis = (0, redis_1.createClient)({
    url: env_1.env.redis.url,
    socket: {
        tls: env_1.env.redis.url.startsWith('rediss://'),
        rejectUnauthorized: false,
        reconnectStrategy: (retries) => {
            if (retries > 5)
                return false; // stop retrying after 5 attempts
            return Math.min(retries * 1000, 5000);
        },
    },
});
exports.redis.on('error', (err) => logger_1.logger.error('Redis error', { error: err.message }));
exports.redis.on('connect', () => logger_1.logger.info('Redis connected'));
async function connectRedis() {
    try {
        await exports.redis.connect();
    }
    catch (err) {
        logger_1.logger.warn('Redis connection failed — continuing without Redis', { error: err.message });
    }
}
async function setEx(key, ttlSeconds, value) {
    try {
        await exports.redis.setEx(key, ttlSeconds, value);
    }
    catch { /* ignore */ }
}
async function get(key) {
    try {
        return await exports.redis.get(key);
    }
    catch {
        return null;
    }
}
async function del(key) {
    try {
        await exports.redis.del(key);
    }
    catch { /* ignore */ }
}
//# sourceMappingURL=redis.js.map