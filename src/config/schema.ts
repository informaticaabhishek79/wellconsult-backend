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
  // ── Phase 2: connected care ───────────────────────────────────────────────
  `ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS appointment_id TEXT`,
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS plan_credit BOOLEAN NOT NULL DEFAULT FALSE`,
  `CREATE TABLE IF NOT EXISTS pre_assessments (
     id BIGSERIAL PRIMARY KEY,
     appointment_id UUID NOT NULL UNIQUE,
     patient_id UUID NOT NULL,
     chief_complaint TEXT NOT NULL,
     duration TEXT,
     severity INT,
     symptoms JSONB NOT NULL DEFAULT '[]',
     current_medicines TEXT,
     allergies JSONB NOT NULL DEFAULT '[]',
     vitals JSONB NOT NULL DEFAULT '{}',
     notes TEXT,
     red_flags JSONB NOT NULL DEFAULT '[]',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS care_plans (
     id BIGSERIAL PRIMARY KEY,
     appointment_id UUID NOT NULL UNIQUE,
     doctor_id UUID NOT NULL,
     patient_id UUID NOT NULL,
     diagnosis TEXT,
     summary TEXT,
     advice TEXT,
     diet TEXT,
     lifestyle TEXT,
     warning_signs TEXT,
     tests JSONB NOT NULL DEFAULT '[]',
     follow_up_date DATE,
     follow_up_reminded BOOLEAN NOT NULL DEFAULT FALSE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS medication_schedules (
     id BIGSERIAL PRIMARY KEY,
     patient_id UUID NOT NULL,
     prescription_id TEXT,
     medicine_name TEXT NOT NULL,
     dosage TEXT,
     instructions TEXT,
     times TEXT[] NOT NULL DEFAULT '{}',
     start_date DATE NOT NULL,
     end_date DATE,
     active BOOLEAN NOT NULL DEFAULT TRUE,
     source TEXT NOT NULL DEFAULT 'prescription',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_medsched_patient ON medication_schedules(patient_id) WHERE active`,
  `CREATE TABLE IF NOT EXISTS medication_doses (
     id BIGSERIAL PRIMARY KEY,
     schedule_id BIGINT NOT NULL REFERENCES medication_schedules(id) ON DELETE CASCADE,
     due_at TIMESTAMPTZ NOT NULL,
     status TEXT NOT NULL DEFAULT 'due',
     reminded_at TIMESTAMPTZ,
     acted_at TIMESTAMPTZ,
     UNIQUE (schedule_id, due_at)
   )`,
  `CREATE TABLE IF NOT EXISTS allergy_overrides (
     id BIGSERIAL PRIMARY KEY,
     prescription_id TEXT,
     doctor_id UUID,
     patient_id UUID,
     warnings JSONB NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  // ── Phase 3 ──────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS family_members (
     id BIGSERIAL PRIMARY KEY,
     owner_user_id UUID NOT NULL,
     member_user_id UUID NOT NULL UNIQUE,
     relation TEXT NOT NULL DEFAULT 'other',
     consent_type TEXT NOT NULL,
     consent_text TEXT NOT NULL,
     consent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     consent_ip TEXT,
     active BOOLEAN NOT NULL DEFAULT TRUE,
     removed_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_family_owner ON family_members(owner_user_id)`,
  `CREATE TABLE IF NOT EXISTS health_readings (
     id BIGSERIAL PRIMARY KEY,
     patient_id UUID NOT NULL,
     kind TEXT NOT NULL,
     value NUMERIC NOT NULL,
     value2 NUMERIC,
     context TEXT,
     note TEXT,
     taken_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     source TEXT NOT NULL DEFAULT 'manual',
     source_ref TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_readings_patient ON health_readings(patient_id, kind, taken_at DESC)`,
  `ALTER TABLE doctors ADD COLUMN IF NOT EXISTS slot_minutes INT NOT NULL DEFAULT 30`,
  `CREATE TABLE IF NOT EXISTS doctor_time_off (
     id BIGSERIAL PRIMARY KEY,
     doctor_id UUID NOT NULL,
     off_date DATE NOT NULL,
     from_time TIME,
     to_time TIME,
     reason TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_timeoff_doctor ON doctor_time_off(doctor_id, off_date)`,
  `CREATE TABLE IF NOT EXISTS complaints (
     id BIGSERIAL PRIMARY KEY,
     ref TEXT NOT NULL UNIQUE,
     user_id UUID NOT NULL,
     role TEXT NOT NULL,
     appointment_id UUID,
     category TEXT NOT NULL,
     subject TEXT NOT NULL,
     description TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'open',
     priority TEXT NOT NULL DEFAULT 'normal',
     ack_due_at TIMESTAMPTZ NOT NULL,
     resolve_due_at TIMESTAMPTZ NOT NULL,
     first_response_at TIMESTAMPTZ,
     resolved_at TIMESTAMPTZ,
     rating INT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS complaint_messages (
     id BIGSERIAL PRIMARY KEY,
     complaint_id BIGINT NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
     author_id UUID NOT NULL,
     author_role TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS app_feedback (
     id BIGSERIAL PRIMARY KEY,
     user_id UUID NOT NULL,
     role TEXT NOT NULL,
     score INT NOT NULL,
     comment TEXT,
     page TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
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
