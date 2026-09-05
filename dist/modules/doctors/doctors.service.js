"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DoctorsService = void 0;
const database_1 = require("../../config/database");
const errorHandler_1 = require("../../middleware/errorHandler");
const pagination_1 = require("../../utils/pagination");
exports.DoctorsService = {
    async search(req) {
        const { page, limit, offset } = (0, pagination_1.getPagination)(req);
        const { medical_system, city, consult_type, language, min_rating, max_fee, experience_min, sort } = req.query;
        const conditions = ['u.is_active = TRUE'];
        const params = [];
        let p = 1;
        if (medical_system) {
            conditions.push(`d.medical_system = $${p++}`);
            params.push(medical_system);
        }
        if (city) {
            conditions.push(`d.city ILIKE $${p++}`);
            params.push(`%${city}%`);
        }
        if (language) {
            conditions.push(`$${p++} = ANY(d.languages)`);
            params.push(language);
        }
        if (min_rating) {
            conditions.push(`d.avg_rating >= $${p++}`);
            params.push(Number(min_rating));
        }
        if (experience_min) {
            conditions.push(`d.experience_years >= $${p++}`);
            params.push(Number(experience_min));
        }
        if (max_fee) {
            conditions.push(`EXISTS (SELECT 1 FROM consultation_fees cf WHERE cf.doctor_id = d.id AND cf.fee_amount <= $${p++})`);
            params.push(Number(max_fee));
        }
        if (consult_type) {
            conditions.push(`EXISTS (SELECT 1 FROM consultation_fees cf WHERE cf.doctor_id = d.id AND cf.consult_type = $${p++})`);
            params.push(consult_type);
        }
        const orderMap = {
            rating: 'd.avg_rating DESC NULLS LAST',
            fee_asc: 'min_fee ASC',
            fee_desc: 'min_fee DESC',
            experience: 'd.experience_years DESC',
        };
        const orderBy = orderMap[sort] || 'd.avg_rating DESC NULLS LAST';
        const where = conditions.join(' AND ');
        const [{ count }] = await (0, database_1.query)(`SELECT COUNT(*)::int AS count FROM doctors d JOIN users u ON u.id = d.user_id WHERE ${where}`, params);
        const rows = await (0, database_1.query)(`SELECT d.id, u.full_name, u.avatar_url, d.medical_system, d.degree,
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
       LIMIT $${p++} OFFSET $${p++}`, [...params, limit, offset]);
        return { rows, total: parseInt(count, 10), page, limit };
    },
    async getById(doctorId) {
        const doctor = await (0, database_1.queryOne)(`SELECT d.*, u.full_name, u.email, u.avatar_url,
              ARRAY_AGG(DISTINCT cf.consult_type) AS consult_types,
              JSON_AGG(DISTINCT jsonb_build_object('type', cf.consult_type, 'fee', cf.fee_amount)) AS fees
       FROM doctors d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN consultation_fees cf ON cf.doctor_id = d.id
       WHERE d.id = $1 AND u.is_active = TRUE
       GROUP BY d.id, u.full_name, u.email, u.avatar_url`, [doctorId]);
        if (!doctor)
            throw new errorHandler_1.AppError(404, 'DOCTOR_NOT_FOUND', 'Doctor not found.');
        return doctor;
    },
    async getAvailability(doctorId, date) {
        const dayOfWeek = new Date(date).getDay();
        const slots = await (0, database_1.query)(`SELECT da.slot_start, da.slot_end,
              EXISTS (
                SELECT 1 FROM appointments a
                WHERE a.doctor_id = $1 AND a.appt_date = $2
                  AND a.appt_time = da.slot_start
                  AND a.status NOT IN ('cancelled','no_show')
              ) AS is_booked
       FROM doctor_availability da
       WHERE da.doctor_id = $1 AND da.day_of_week = $3 AND da.is_active = TRUE
       ORDER BY da.slot_start`, [doctorId, date, dayOfWeek]);
        return { doctor_id: doctorId, date, available_slots: slots };
    },
    async updateProfile(doctorId, body) {
        const { bio, specialization, city, languages, experience_years, medical_system, degree, reg_number, reg_body, consult_types } = body;
        await (0, database_1.query)(`UPDATE doctors SET bio=$1, specialization=$2, city=$3, languages=$4,
       experience_years=$5, medical_system=COALESCE($6, medical_system),
       degree=COALESCE($7, degree), reg_number=COALESCE($8, reg_number),
       reg_body=COALESCE($9, reg_body), updated_at=NOW() WHERE id=$10`, [bio, specialization, city, languages, experience_years, medical_system, degree, reg_number, reg_body, doctorId]);
        return this.getMyProfile(doctorId);
    },
    async getDashboard(doctorId) {
        const [stats] = await (0, database_1.query)(`SELECT
         COUNT(*) FILTER (WHERE status='completed') AS total_consultations,
         COUNT(*) FILTER (WHERE status='booked' AND appt_date = CURRENT_DATE) AS today_appointments,
         COUNT(*) FILTER (WHERE status='booked' AND appt_date > CURRENT_DATE) AS upcoming_appointments
       FROM appointments WHERE doctor_id = $1`, [doctorId]);
        const upcoming = await (0, database_1.query)(`SELECT a.id, a.appt_date, a.appt_time, a.consult_type, a.status,
              u.full_name AS patient_name, u.avatar_url AS patient_avatar
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       JOIN users u ON u.id = p.user_id
       WHERE a.doctor_id = $1 AND a.appt_date >= CURRENT_DATE AND a.status = 'booked'
       ORDER BY a.appt_date, a.appt_time LIMIT 10`, [doctorId]);
        return { stats, upcoming };
    },
    async getMyProfile(doctorId) {
        const { query, queryOne } = await Promise.resolve().then(() => __importStar(require('../../config/database')));
        const doctor = await queryOne(`SELECT d.*, u.full_name, u.email, u.avatar_url,
              ARRAY_AGG(DISTINCT cf.consult_type) FILTER (WHERE cf.consult_type IS NOT NULL) AS consult_types,
              JSON_AGG(DISTINCT jsonb_build_object('type', cf.consult_type, 'fee', cf.fee_amount)) FILTER (WHERE cf.consult_type IS NOT NULL) AS fees
       FROM doctors d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN consultation_fees cf ON cf.doctor_id = d.id
       WHERE d.id = $1
       GROUP BY d.id, u.full_name, u.email, u.avatar_url`, [doctorId]);
        return doctor;
    },
    async updateFees(doctorId, body) {
        const { query } = await Promise.resolve().then(() => __importStar(require('../../config/database')));
        await query(`INSERT INTO consultation_fees (doctor_id, consult_type, fee_amount, currency)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (doctor_id, consult_type) DO UPDATE SET fee_amount=$3, currency=$4`, [doctorId, body.consult_type, body.fee_amount, body.currency || 'INR']);
        return { success: true };
    },
    async addAvailability(doctorId, body) {
        const { query } = await Promise.resolve().then(() => __importStar(require('../../config/database')));
        await query(`INSERT INTO doctor_availability (doctor_id, day_of_week, slot_start, slot_end, is_active)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (doctor_id, day_of_week, slot_start) DO NOTHING`, [doctorId, body.day_of_week, body.slot_start, body.slot_end]);
        return { success: true };
    },
};
//# sourceMappingURL=doctors.service.js.map