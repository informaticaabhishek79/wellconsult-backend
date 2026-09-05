"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationService = void 0;
const firebase_admin_1 = __importDefault(require("firebase-admin"));
const env_1 = require("../../config/env");
const database_1 = require("../../config/database");
const logger_1 = require("../../utils/logger");
function getFirebaseApp() {
    if (firebase_admin_1.default.apps.length)
        return firebase_admin_1.default.app();
    if (!env_1.env.firebase.privateKey || !env_1.env.firebase.clientEmail.includes('@'))
        return null;
    return firebase_admin_1.default.initializeApp({
        credential: firebase_admin_1.default.credential.cert({
            projectId: env_1.env.firebase.projectId,
            privateKey: env_1.env.firebase.privateKey,
            clientEmail: env_1.env.firebase.clientEmail,
        }),
    });
}
exports.NotificationService = {
    async send(params) {
        const { userId, type, title, body, refType, refId, fcmToken } = params;
        // 1. Persist to DB
        await (0, database_1.query)(`INSERT INTO notifications (user_id, type, title, body, ref_type, ref_id)
       VALUES ($1, $2, $3, $4, $5, $6)`, [userId, type, title, body, refType ?? null, refId ?? null]);
        // 2. Push via FCM if token present
        if (fcmToken && getFirebaseApp()) {
            try {
                await getFirebaseApp().messaging().send({
                    token: fcmToken,
                    notification: { title, body },
                    data: { type, ...(refType ? { ref_type: refType } : {}), ...(refId ? { ref_id: refId } : {}) },
                    android: { priority: 'high' },
                    apns: { payload: { aps: { sound: 'default', badge: 1 } } },
                });
            }
            catch (err) {
                logger_1.logger.warn('FCM push failed', { userId, error: err.message });
            }
        }
    },
    async listForUser(userId, page, limit) {
        const offset = (page - 1) * limit;
        const rows = await (0, database_1.query)(`SELECT id, type, title, body, ref_type, ref_id, is_read, sent_at
       FROM notifications WHERE user_id=$1
       ORDER BY sent_at DESC LIMIT $2 OFFSET $3`, [userId, limit, offset]);
        const [{ count }] = await (0, database_1.query)('SELECT COUNT(*)::int AS count FROM notifications WHERE user_id=$1', [userId]);
        return { rows, total: parseInt(count, 10), page, limit };
    },
    async markRead(notifId, userId) {
        await (0, database_1.query)('UPDATE notifications SET is_read=TRUE WHERE id=$1 AND user_id=$2', [notifId, userId]);
    },
    async markAllRead(userId) {
        await (0, database_1.query)('UPDATE notifications SET is_read=TRUE WHERE user_id=$1', [userId]);
    },
};
//# sourceMappingURL=notifications.service.js.map