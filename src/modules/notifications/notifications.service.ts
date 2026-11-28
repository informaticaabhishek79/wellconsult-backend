import admin from 'firebase-admin';
import { env } from '../../config/env';
import { query } from '../../config/database';
import { logger } from '../../utils/logger';

function getFirebaseApp() {
  if (admin.apps.length) return admin.app();
  if (!env.firebase.privateKey || !env.firebase.clientEmail.includes('@')) return null;
  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   env.firebase.projectId,
      privateKey:  env.firebase.privateKey,
      clientEmail: env.firebase.clientEmail,
    }),
  });
}

interface SendParams {
  userId:   string;
  type:     string;
  title:    string;
  body:     string;
  refType?: string;
  refId?:   string;
  fcmToken?: string;
}

export const NotificationService = {
  async send(params: SendParams): Promise<void> {
    let { userId, title, fcmToken } = params;
    const { type, body, refType, refId } = params;
    // A family member has no login: their notifications go to the account holder, labelled with their name.
    const fam = await query<{ owner_user_id: string; full_name: string; fcm_token?: string }>(
      `SELECT fm.owner_user_id, mu.full_name, ou.fcm_token FROM family_members fm
       JOIN users mu ON mu.id = fm.member_user_id JOIN users ou ON ou.id = fm.owner_user_id
       WHERE fm.member_user_id = $1 LIMIT 1`, [userId]).catch(() => [] as any[]);
    if (fam[0]) { userId = fam[0].owner_user_id; title = `${fam[0].full_name}: ${title}`; fcmToken = fam[0].fcm_token || undefined; }

    // 1. Persist to DB
    await query(
      `INSERT INTO notifications (user_id, type, title, body, ref_type, ref_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, type, title, body, refType ?? null, refId ?? null]
    );

    // 2. Push via FCM if token present
    if (fcmToken && getFirebaseApp()) {
  try {
    await getFirebaseApp()!.messaging().send({
          token: fcmToken,
          notification: { title, body },
          data: { type, ...(refType ? { ref_type: refType } : {}), ...(refId ? { ref_id: refId } : {}) },
          android: { priority: 'high' },
          apns: { payload: { aps: { sound: 'default', badge: 1 } } },
        });
      } catch (err) {
        logger.warn('FCM push failed', { userId, error: (err as Error).message });
      }
    }
  },

  async listForUser(userId: string, page: number, limit: number) {
    const offset = (page - 1) * limit;
    const rows = await query(
      `SELECT id, type, title, body, ref_type, ref_id, is_read, sent_at
       FROM notifications WHERE user_id=$1
       ORDER BY sent_at DESC LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    const [{ count }] = await query<{ count: string }>(
      'SELECT COUNT(*)::int AS count FROM notifications WHERE user_id=$1', [userId]
    );
    return { rows, total: parseInt(count, 10), page, limit };
  },

  async markRead(notifId: string, userId: string): Promise<void> {
    await query(
      'UPDATE notifications SET is_read=TRUE WHERE id=$1 AND user_id=$2',
      [notifId, userId]
    );
  },

  async markAllRead(userId: string): Promise<void> {
    await query('UPDATE notifications SET is_read=TRUE WHERE user_id=$1', [userId]);
  },
};
