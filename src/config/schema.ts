import { query } from './database';
import { logger } from '../utils/logger';

/* Idempotent schema additions for doctor verification & platform commission.
   Runs on every start; each statement is safe to repeat. */
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS platform_settings (
     key TEXT PRIMARY KEY,
     value JSONB NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_by UUID
   )`,
  `INSERT INTO platform_settings (key, value) VALUES ('commission', '{"default_pct": 20}') ON CONFLICT (key) DO NOTHING`,

  // Licence & council details
  `ALTER TABLE doctors ADD COLUMN IF NOT EXISTS reg_year INTEGER`,
  `ALTER TABLE doctors ADD COLUMN IF NOT EXISTS practice_license_no TEXT`,
  `ALTER TABLE doctors ADD COLUMN IF NOT EXISTS practice_license_authority TEXT`,

  // Commission agreement
  `ALTER TABLE doctors ADD COLUMN IF NOT EXISTS commission_pct NUMERIC(5,2)`, // per-doctor override (NULL = default)
  `ALTER TABLE doctors ADD COLUMN IF NOT EXISTS commission_status TEXT NOT NULL DEFAULT 'pending'`, // pending | accepted | declined
  `ALTER TABLE doctors ADD COLUMN IF NOT EXISTS commission_accepted_pct NUMERIC(5,2)`,
  `ALTER TABLE doctors ADD COLUMN IF NOT EXISTS commission_responded_at TIMESTAMPTZ`,

  // Admin's register check
  `ALTER TABLE doctors ADD COLUMN IF NOT EXISTS register_check JSONB`,
  `ALTER TABLE doctors ADD COLUMN IF NOT EXISTS verified_by UUID`,
  `ALTER TABLE doctors ADD COLUMN IF NOT EXISTS rejection_reason TEXT`,
  `ALTER TABLE doctors ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ`,

  // Allow the new document type (old check constraint, if any, listed fixed types)
  `ALTER TABLE doctor_documents DROP CONSTRAINT IF EXISTS doctor_documents_document_type_check`,

  // Instant consultations carry the 15-minute promise; scheduled ones do not
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS is_instant BOOLEAN NOT NULL DEFAULT FALSE`,


  // ── Billing & instant-consultation engine ───────────────────────────
  `INSERT INTO platform_settings (key, value) VALUES ('billing', '{"tax_pct": 0, "patient_full_refund_hours": 2, "slot_hold_minutes": 15, "instant_sla_minutes": 15, "instant_escalate_minutes": 5}') ON CONFLICT (key) DO NOTHING`,
  `DO $$ DECLARE r record; BEGIN
     FOR r IN SELECT conrelid::regclass::text AS tbl, conname FROM pg_constraint
              WHERE contype='c' AND conrelid IN ('appointments'::regclass, 'payments'::regclass)
                AND pg_get_constraintdef(oid) ILIKE '%status%'
     LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname); END LOOP;
   END $$`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS fee_paise BIGINT`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS discount_paise BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS tax_paise BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS amount_paise BIGINT`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'not_required'`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS hold_expires_at TIMESTAMPTZ`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS instant_deadline TIMESTAMPTZ`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS consultation_started_at TIMESTAMPTZ`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS escalation_level INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS last_escalated_at TIMESTAMPTZ`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS instant_tried UUID[] NOT NULL DEFAULT '{}'`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancelled_by TEXT`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancellation_reason TEXT`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS booked_at TIMESTAMPTZ DEFAULT NOW()`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS razorpay_order_id TEXT`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS razorpay_payment_id TEXT`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_status TEXT`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_id TEXT`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_amount BIGINT`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_reason TEXT`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_attempts INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_error TEXT`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_requested_at TIMESTAMPTZ`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS failure_reason TEXT`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS confirmed_via TEXT`,
  `CREATE TABLE IF NOT EXISTS ledger_entries (
     id BIGSERIAL PRIMARY KEY,
     idem_key TEXT UNIQUE NOT NULL,
     appointment_id UUID,
     payment_id UUID,
     doctor_id UUID,
     entry_type TEXT NOT NULL,
     amount_paise BIGINT NOT NULL,
     note TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS ledger_doctor_idx ON ledger_entries (doctor_id, entry_type)`,
  `CREATE TABLE IF NOT EXISTS payment_events (
     id BIGSERIAL PRIMARY KEY,
     event_id TEXT UNIQUE NOT NULL,
     event TEXT NOT NULL,
     payload JSONB,
     received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     processed_at TIMESTAMPTZ,
     error TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS sla_breaches (
     id BIGSERIAL PRIMARY KEY,
     appointment_id UUID UNIQUE NOT NULL,
     doctor_id UUID,
     kind TEXT NOT NULL,
     deadline TIMESTAMPTZ,
     breached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     escalation_level INTEGER,
     refund_paise BIGINT,
     refund_status TEXT,
     notes TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS doctor_payouts (
     id BIGSERIAL PRIMARY KEY,
     doctor_id UUID NOT NULL,
     amount_paise BIGINT NOT NULL,
     reference TEXT,
     note TEXT,
     created_by UUID,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // Commission snapshot on each appointment
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS commission_pct NUMERIC(5,2)`,
  `CREATE OR REPLACE FUNCTION set_appointment_commission() RETURNS trigger AS $$
   BEGIN
     IF NEW.commission_pct IS NULL THEN
       SELECT COALESCE(d.commission_accepted_pct, d.commission_pct,
                       (SELECT (value->>'default_pct')::numeric FROM platform_settings WHERE key='commission'), 0)
         INTO NEW.commission_pct FROM doctors d WHERE d.id = NEW.doctor_id;
     END IF;
     RETURN NEW;
   END $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_appointment_commission ON appointments`,
  `CREATE TRIGGER trg_appointment_commission BEFORE INSERT ON appointments
     FOR EACH ROW EXECUTE FUNCTION set_appointment_commission()`,
];

export async function ensureSchema() {
  for (const sql of STATEMENTS) {
    try { await query(sql); }
    catch (e: any) { logger.error('Schema step failed', { sql: sql.slice(0, 80), error: e?.message }); }
  }
  logger.info('Schema check complete');
}

/** Commission the doctor is currently offered: their override, else the platform default. */
export const EFFECTIVE_PCT_SQL =
  `COALESCE(d.commission_pct, (SELECT (value->>'default_pct')::numeric FROM platform_settings WHERE key='commission'), 0)`;
