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
