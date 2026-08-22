import { query, queryOne } from '../../config/database';
import { AppError } from '../../middleware/errorHandler';
import { getPagination } from '../../utils/pagination';
import { Request } from 'express';

export const DoctorsService = {
  async search(req: Request) {
    const { page, limit, offset } = getPagination(req);
    const { medical_system, city, consult_type, language, min_rating, max_fee, experience_min, sort } = req.query;

    const conditions: string[] = ["d.profile_status = 'verified'", 'u.is_active = TRUE'];
    const params: unknown[] = [];
    let p = 1;

    if (medical_system) { conditions.push(`d.medical_system = $${p++}`); params.push(medical_system); }
    if (city)           { conditions.push(`d.city ILIKE $${p++}`);        params.push(`%${city}%`); }
    if (language)       { conditions.push(`$${p++} = ANY(d.languages)`);  params.push(language); }
    if (min_rating)     { conditions.push(`d.avg_rating >= $${p++}`);     params.push(Number(min_rating)); }
    if (experience_min) { conditions.push(`d.experience_years >= $${p++}`); params.push(Number(experience_min)); }
    if (max_fee) {
      conditions.push(`EXISTS (SELECT 1 FROM consultation_fees cf WHERE cf.doctor_id = d.id AND cf.fee_amount <= $${p++})`);
      params.push(Number(max_fee));
    }
    if (consult_type) {
      conditions.push(`EXISTS (SELECT 1 FROM consultation_fees cf WHERE cf.doctor_id = d.id AND cf.consult_type = $${p++})`);
      params.push(consult_type);
    }

    const orderMap: Record<string, string> = {
      rating: 'd.avg_rating DESC NULLS LAST',
      fee_asc: 'min_fee ASC',
      fee_desc: 'min_fee DESC',
      experience: 'd.experience_years DESC',
    };
    const orderBy = orderMap[sort as string] || 'd.avg_rating DESC NULLS LAST';

    const where = conditions.join(' AND ');

    const [{ count }] = await query<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM doctors d JOIN users u ON u.id = d.user_id WHERE ${where}`,
      params
    );

    const rows = await query(
      `SELECT d.id, u.full_name, u.avatar_url, d.medical_system, d.degree,
              d.specialization, d.experience_years, d.city, d.languages,
              d.avg_rating, d.total_reviews,
              ARRAY_AGG(DISTINCT cf.consult_type) FILTER (WHERE cf.consult_type IS NOT NULL) AS consult_types,
              MIN(cf.fee_amount) AS min_fee
       FROM doctors d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN consultation_fees cf ON cf.doctor_id = d.id
       WHERE ${where}
       GROUP BY d.id, u.full_name, u.avatar_url
       ORDER BY ${orderBy}
       LIMIT $${p++} OFFSET $${p++}`,
      [...params, limit, offset]
    );

    return { rows, total: parseInt(count, 10), page, limit };
  },

  async getById(doctorId: string) {
    const doctor = await queryOne(
      `SELECT d.*, u.full_name, u.email, u.avatar_url,
              ARRAY_AGG(DISTINCT cf.consult_type) AS consult_types,
              JSON_AGG(DISTINCT jsonb_build_object('type', cf.consult_type, 'fee', cf.fee_amount)) AS fees
       FROM doctors d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN consultation_fees cf ON cf.doctor_id = d.id
       WHERE d.id = $1 AND d.profile_status = 'verified'
       GROUP BY d.id, u.full_name, u.email, u.avatar_url`,
      [doctorId]
    );
    if (!doctor) throw new AppError(404, 'DOCTOR_NOT_FOUND', 'Doctor not found.');
    return doctor;
  },

  async getAvailability(doctorId: string, date: string) {
    const dayOfWeek = new Date(date).getDay();
    const slots = await query(
      `SELECT da.slot_start, da.slot_end,
              EXISTS (
                SELECT 1 FROM appointments a
                WHERE a.doctor_id = $1 AND a.appt_date = $2
                  AND a.appt_time = da.slot_start
                  AND a.status NOT IN ('cancelled','no_show')
              ) AS is_booked
       FROM doctor_availability da
       WHERE da.doctor_id = $1 AND da.day_of_week = $3 AND da.is_active = TRUE
       ORDER BY da.slot_start`,
      [doctorId, date, dayOfWeek]
    );
    return { doctor_id: doctorId, date, available_slots: slots };
  },

  async updateProfile(doctorId: string, body: Record<string, unknown>) {
    const { bio, specialization, city, languages, experience_years } = body;
    await query(
      `UPDATE doctors SET bio=$1, specialization=$2, city=$3, languages=$4,
       experience_years=$5, updated_at=NOW() WHERE id=$6`,
      [bio, specialization, city, languages, experience_years, doctorId]
    );
    return this.getById(doctorId);
  },

  async getDashboard(doctorId: string) {
    const [stats] = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status='completed') AS total_consultations,
         COUNT(*) FILTER (WHERE status='booked' AND appt_date = CURRENT_DATE) AS today_appointments,
         COUNT(*) FILTER (WHERE status='booked' AND appt_date > CURRENT_DATE) AS upcoming_appointments
       FROM appointments WHERE doctor_id = $1`,
      [doctorId]
    );
    const upcoming = await query(
      `SELECT a.id, a.appt_date, a.appt_time, a.consult_type, a.status,
              u.full_name AS patient_name, u.avatar_url AS patient_avatar
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       JOIN users u ON u.id = p.user_id
       WHERE a.doctor_id = $1 AND a.appt_date >= CURRENT_DATE AND a.status = 'booked'
       ORDER BY a.appt_date, a.appt_time LIMIT 10`,
      [doctorId]
    );
    return { stats, upcoming };
  },
};
