import cron from 'node-cron';
import { query } from '../config/database';
import { NotificationService } from '../modules/notifications/notifications.service';
import { logger } from '../utils/logger';

/**
 * Runs every day at 08:00 AM IST (02:30 UTC).
 * Sends appointment reminders for appointments 24h and 1h away.
 */
export function startScheduler(): void {
  // ── 24-hour reminder ──────────────────────────────────
  cron.schedule('30 2 * * *', async () => {
    logger.info('[Scheduler] Running 24h appointment reminders');
    try {
      const rows = await query<{
        appointment_id: string; user_id: string; doctor_name: string;
        appt_date: string; appt_time: string; consult_type: string; fcm_token?: string;
      }>(
        `SELECT a.id AS appointment_id, pu.id AS user_id, pu.fcm_token,
                du.full_name AS doctor_name, a.appt_date, a.appt_time, a.consult_type
         FROM appointments a
         JOIN patients pt ON pt.id = a.patient_id
         JOIN users pu ON pu.id = pt.user_id
         JOIN doctors d ON d.id = a.doctor_id
         JOIN users du ON du.id = d.user_id
         WHERE a.appt_date = CURRENT_DATE + INTERVAL '1 day'
           AND a.status = 'booked'`
      );

      for (const row of rows) {
        await NotificationService.send({
          userId:    row.user_id,
          type:      'appt_reminder',
          title:     'Appointment tomorrow',
          body:      `Your ${row.consult_type} consultation with ${row.doctor_name} is tomorrow at ${row.appt_time}.`,
          refType:   'appointment',
          refId:     row.appointment_id,
          fcmToken:  row.fcm_token,
        });
      }
      logger.info(`[Scheduler] 24h reminders sent: ${rows.length}`);
    } catch (err) {
      logger.error('[Scheduler] 24h reminder error', { error: (err as Error).message });
    }
  });

  // ── 1-hour reminder (runs every hour at :00) ──────────
  cron.schedule('0 * * * *', async () => {
    const now   = new Date();
    const inOne = new Date(now.getTime() + 60 * 60 * 1000);
    const date  = inOne.toISOString().slice(0, 10);
    const time  = inOne.toTimeString().slice(0, 5);

    try {
      const rows = await query<{
        appointment_id: string; user_id: string; doctor_name: string;
        consult_type: string; fcm_token?: string;
      }>(
        `SELECT a.id AS appointment_id, pu.id AS user_id, pu.fcm_token,
                du.full_name AS doctor_name, a.consult_type
         FROM appointments a
         JOIN patients pt ON pt.id = a.patient_id
         JOIN users pu ON pu.id = pt.user_id
         JOIN doctors d ON d.id = a.doctor_id
         JOIN users du ON du.id = d.user_id
         WHERE a.appt_date = $1 AND a.appt_time = $2 AND a.status = 'confirmed'`,
        [date, time]
      );

      for (const row of rows) {
        await NotificationService.send({
          userId:   row.user_id,
          type:     'appt_reminder',
          title:    'Your consultation starts in 1 hour',
          body:     `Get ready for your ${row.consult_type} session with ${row.doctor_name}.`,
          refType:  'appointment',
          refId:    row.appointment_id,
          fcmToken: row.fcm_token,
        });
      }
    } catch (err) {
      logger.error('[Scheduler] 1h reminder error', { error: (err as Error).message });
    }
  });

  // ── Post-consultation review prompt (runs at 22:00 daily) ──
  cron.schedule('0 16 * * *', async () => { // 22:00 IST = 16:30 UTC ~ round to 16:00
    logger.info('[Scheduler] Sending review prompts');
    try {
      const rows = await query<{
        consultation_id: string; user_id: string; doctor_name: string; fcm_token?: string;
      }>(
        `SELECT c.id AS consultation_id, pu.id AS user_id, pu.fcm_token,
                du.full_name AS doctor_name
         FROM consultations c
         JOIN appointments a ON a.id = c.appointment_id
         JOIN patients pt ON pt.id = c.patient_id
         JOIN users pu ON pu.id = pt.user_id
         JOIN doctors d ON d.id = c.doctor_id
         JOIN users du ON du.id = d.user_id
         WHERE c.session_status = 'ended'
           AND DATE(c.ended_at) = CURRENT_DATE
           AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.consultation_id = c.id)`
      );

      for (const row of rows) {
        await NotificationService.send({
          userId:   row.user_id,
          type:     'review_prompt',
          title:    'How was your consultation?',
          body:     `Share your experience with ${row.doctor_name}. It helps others choose the right doctor.`,
          refType:  'consultation',
          refId:    row.consultation_id,
          fcmToken: row.fcm_token,
        });
      }
      logger.info(`[Scheduler] Review prompts sent: ${rows.length}`);
    } catch (err) {
      logger.error('[Scheduler] Review prompt error', { error: (err as Error).message });
    }
  });

  // ── Follow-up reminders ───────────────────────────────
  cron.schedule('30 3 * * *', async () => {
    try {
      const rows = await query<{
        user_id: string; doctor_name: string; follow_up_days: number; fcm_token?: string;
      }>(
        `SELECT pu.id AS user_id, pu.fcm_token,
                du.full_name AS doctor_name, c.follow_up_days
         FROM consultations c
         JOIN patients pt ON pt.id = c.patient_id
         JOIN users pu ON pu.id = pt.user_id
         JOIN doctors d ON d.id = c.doctor_id
         JOIN users du ON du.id = d.user_id
         WHERE c.follow_up_days IS NOT NULL
           AND DATE(c.ended_at) + c.follow_up_days * INTERVAL '1 day' = CURRENT_DATE`
      );

      for (const row of rows) {
        await NotificationService.send({
          userId:   row.user_id,
          type:     'appt_reminder',
          title:    'Follow-up due today',
          body:     `${row.doctor_name} recommended a follow-up today. Book your next consultation.`,
          fcmToken: row.fcm_token,
        });
      }
    } catch (err) {
      logger.error('[Scheduler] Follow-up error', { error: (err as Error).message });
    }
  });

  // ── SLA Enforcement: Auto-refund if doctor doesn't confirm within 15 min ──
  cron.schedule('*/5 * * * *', async () => { // runs every 5 minutes
    try {
      const rows = await query<{
        id: string; patient_id: string; doctor_id: string;
        patient_phone: string; doctor_name: string; appt_date: string; appt_time: string;
      }>(
        `SELECT a.id, a.patient_id, a.doctor_id,
                u.phone AS patient_phone,
                du.full_name AS doctor_name,
                a.appt_date, a.appt_time
         FROM appointments a
         JOIN patients pt ON pt.id = a.patient_id
         JOIN users u ON u.id = pt.user_id
         JOIN doctors d ON d.id = a.doctor_id
         JOIN users du ON du.id = d.user_id
         WHERE a.status = 'booked'
           AND a.created_at < NOW() - INTERVAL '15 minutes'`
      );

      for (const row of rows) {
        // Auto-cancel and mark for refund
        await query(
          `UPDATE appointments SET status='cancelled', cancelled_by='system',
           cancellation_reason='Doctor did not confirm within 15 minutes. Auto-refunded.'
           WHERE id=$1`,
          [row.id]
        );

        // Notify patient via SMS/WhatsApp
        const { notifyAppointmentCancelled } = await import('../services/notifications');
        await notifyAppointmentCancelled({
          phone: row.patient_phone,
          date: String(row.appt_date).slice(0, 10),
          time: String(row.appt_time).slice(0, 5),
          reason: 'Doctor did not confirm in time. Full refund will be processed within 5-7 business days.',
        });

        logger.info('[Scheduler] SLA breach - auto cancelled appointment', { appointmentId: row.id });
      }

      if (rows.length > 0) {
        logger.info(`[Scheduler] SLA enforcement: ${rows.length} appointments auto-cancelled`);
      }
    } catch (err) {
      logger.error('[Scheduler] SLA enforcement error', { error: (err as Error).message });
    }
  });

  // ── SMS/WhatsApp 1-hour reminder (runs every hour) ────
  cron.schedule('30 * * * *', async () => { // at :30 every hour
    const now   = new Date();
    const inOne = new Date(now.getTime() + 60 * 60 * 1000);
    const date  = inOne.toISOString().slice(0, 10);
    const time  = inOne.toTimeString().slice(0, 5);

    try {
      const rows = await query<{
        appointment_id: string;
        patient_phone: string; patient_name: string;
        doctor_phone: string; doctor_name: string;
        consult_type: string; appt_time: string;
      }>(
        `SELECT a.id AS appointment_id,
                pu.phone AS patient_phone, pu.full_name AS patient_name,
                du.phone AS doctor_phone, du.full_name AS doctor_name,
                a.consult_type, a.appt_time
         FROM appointments a
         JOIN patients pt ON pt.id = a.patient_id
         JOIN users pu ON pu.id = pt.user_id
         JOIN doctors d ON d.id = a.doctor_id
         JOIN users du ON du.id = d.user_id
         WHERE a.appt_date = $1 AND a.appt_time = $2 AND a.status = 'confirmed'`,
        [date, time]
      );

      for (const row of rows) {
        const { notifyAppointmentReminder } = await import('../services/notifications');
        // Remind patient
        await notifyAppointmentReminder({
          phone: row.patient_phone,
          doctorName: row.doctor_name,
          time: String(row.appt_time).slice(0, 5),
          consultType: row.consult_type,
        });
        // Remind doctor
        await notifyAppointmentReminder({
          phone: row.doctor_phone,
          doctorName: `Patient: ${row.patient_name}`,
          time: String(row.appt_time).slice(0, 5),
          consultType: row.consult_type,
        });
      }

      if (rows.length > 0) {
        logger.info(`[Scheduler] SMS reminders sent: ${rows.length} appointments`);
      }
    } catch (err) {
      logger.error('[Scheduler] SMS reminder error', { error: (err as Error).message });
    }
  });

  logger.info('[Scheduler] All cron jobs registered');
}
