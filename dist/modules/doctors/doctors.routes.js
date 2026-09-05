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
const express_1 = require("express");
const authenticate_1 = require("../../middleware/authenticate");
const authorize_1 = require("../../middleware/authorize");
const doctors_service_1 = require("./doctors.service");
const apiResponse_1 = require("../../utils/apiResponse");
const database_1 = require("../../config/database");
const router = (0, express_1.Router)();
// Get online doctors
router.get('/online', authenticate_1.authenticate, async (req, res, next) => {
    try {
        const { redis } = await Promise.resolve().then(() => __importStar(require('../../config/redis')));
        const { query: dbQuery } = await Promise.resolve().then(() => __importStar(require('../../config/database')));
        const keys = await redis.keys('doctor:online:*');
        if (keys.length === 0) {
            res.json({ success: true, data: [] });
            return;
        }
        const onlineDoctorIds = keys.map((k) => k.replace('doctor:online:', ''));
        const doctors = await dbQuery(`SELECT d.id, u.full_name, d.medical_system, d.specialization, d.degree,
              d.avg_rating, d.total_reviews, d.city, d.experience_years
       FROM doctors d
       JOIN users u ON u.id = d.user_id
       WHERE d.id = ANY($1::uuid[])
         AND d.profile_status = 'verified'
         AND u.is_active = TRUE`, [onlineDoctorIds]);
        res.json({ success: true, data: doctors });
    }
    catch (e) {
        next(e);
    }
});
// Public routes
router.get('/', async (req, res, next) => {
    try {
        const { rows, total, page, limit } = await doctors_service_1.DoctorsService.search(req);
        (0, apiResponse_1.sendSuccess)(res, rows, 200, { page, limit, total });
    }
    catch (e) {
        next(e);
    }
});
router.get('/:id/availability', async (req, res, next) => {
    try {
        const date = req.query.date || new Date().toISOString().slice(0, 10);
        (0, apiResponse_1.sendSuccess)(res, await doctors_service_1.DoctorsService.getAvailability(req.params.id, date));
    }
    catch (e) {
        next(e);
    }
});
// Doctor auth routes
router.get('/me/dashboard', authenticate_1.authenticate, (0, authorize_1.authorize)('doctor'), async (req, res, next) => {
    try {
        const data = await doctors_service_1.DoctorsService.getDashboard(req.user.doctorId);
        (0, apiResponse_1.sendSuccess)(res, data);
    }
    catch (e) {
        next(e);
    }
});
router.get('/me/profile', authenticate_1.authenticate, (0, authorize_1.authorize)('doctor'), async (req, res, next) => {
    try {
        (0, apiResponse_1.sendSuccess)(res, await doctors_service_1.DoctorsService.getMyProfile(req.user.doctorId));
    }
    catch (e) {
        next(e);
    }
});
router.put('/me/profile', authenticate_1.authenticate, (0, authorize_1.authorize)('doctor'), async (req, res, next) => {
    try {
        (0, apiResponse_1.sendSuccess)(res, await doctors_service_1.DoctorsService.updateProfile(req.user.doctorId, req.body));
    }
    catch (e) {
        next(e);
    }
});
router.post('/me/fees', authenticate_1.authenticate, (0, authorize_1.authorize)('doctor'), async (req, res, next) => {
    try {
        (0, apiResponse_1.sendSuccess)(res, await doctors_service_1.DoctorsService.updateFees(req.user.doctorId, req.body));
    }
    catch (e) {
        next(e);
    }
});
router.post('/me/availability', authenticate_1.authenticate, (0, authorize_1.authorize)('doctor'), async (req, res, next) => {
    try {
        (0, apiResponse_1.sendSuccess)(res, await doctors_service_1.DoctorsService.addAvailability(req.user.doctorId, req.body));
    }
    catch (e) {
        next(e);
    }
});
router.get('/me/appointments', authenticate_1.authenticate, (0, authorize_1.authorize)('doctor'), async (req, res, next) => {
    try {
        const { query } = await Promise.resolve().then(() => __importStar(require('../../config/database')));
        const appointments = await query(`SELECT a.id, a.appt_date, a.appt_time, a.consult_type, a.status,
              u.full_name AS patient_name, p.id AS patient_id
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       JOIN users u ON u.id = p.user_id
       WHERE a.doctor_id = $1
       ORDER BY a.appt_date DESC, a.appt_time DESC`, [req.user.doctorId]);
        (0, apiResponse_1.sendSuccess)(res, appointments);
    }
    catch (e) {
        next(e);
    }
});
router.patch('/me/appointments/:id/confirm', authenticate_1.authenticate, (0, authorize_1.authorize)('doctor'), async (req, res, next) => {
    try {
        await (0, database_1.query)("UPDATE appointments SET status='confirmed' WHERE id=$1 AND doctor_id=$2", [req.params.id, req.user.doctorId]);
        setImmediate(async () => {
            try {
                const { notifyAppointmentConfirmed } = await Promise.resolve().then(() => __importStar(require('../../services/notifications')));
                const { query: q } = await Promise.resolve().then(() => __importStar(require('../../config/database')));
                const [apptInfo] = await q(`SELECT a.appt_date, a.appt_time, a.consult_type, u.phone AS patient_phone, du.full_name AS doctor_name
           FROM appointments a JOIN patients p ON p.id=a.patient_id JOIN users u ON u.id=p.user_id
           JOIN doctors d ON d.id=a.doctor_id JOIN users du ON du.id=d.user_id WHERE a.id=$1`, [req.params.id]);
                if (apptInfo) {
                    await notifyAppointmentConfirmed({
                        patientPhone: apptInfo.patient_phone,
                        doctorName: apptInfo.doctor_name,
                        date: String(apptInfo.appt_date).slice(0, 10),
                        time: String(apptInfo.appt_time).slice(0, 5),
                        consultType: apptInfo.consult_type,
                    });
                }
            }
            catch (e) {
                console.error('Notification error:', e);
            }
        });
        (0, apiResponse_1.sendSuccess)(res, { message: 'Appointment confirmed' });
    }
    catch (e) {
        next(e);
    }
});
router.patch('/me/appointments/:id/complete', authenticate_1.authenticate, (0, authorize_1.authorize)('doctor'), async (req, res, next) => {
    try {
        const { query } = await Promise.resolve().then(() => __importStar(require('../../config/database')));
        await query("UPDATE appointments SET status='completed' WHERE id=$1 AND doctor_id=$2", [req.params.id, req.user.doctorId]);
        (0, apiResponse_1.sendSuccess)(res, { message: 'Appointment completed' });
    }
    catch (e) {
        next(e);
    }
});
router.post('/me/appointments/:id/followup', authenticate_1.authenticate, (0, authorize_1.authorize)('doctor'), async (req, res, next) => {
    try {
        const { follow_up_days, notes } = req.body;
        const { query } = await Promise.resolve().then(() => __importStar(require('../../config/database')));
        // Update consultation with follow-up info
        await query(`UPDATE consultations SET follow_up_days=$1, follow_up_notes=$2 
       WHERE appointment_id=$3 AND doctor_id=$4`, [follow_up_days, notes, req.params.id, req.user.doctorId]);
        (0, apiResponse_1.sendSuccess)(res, { message: 'Follow-up period set', follow_up_days });
    }
    catch (e) {
        next(e);
    }
});
// Public doctor detail (must be last to avoid conflicts with /me routes)
router.get('/:id', async (req, res, next) => {
    try {
        (0, apiResponse_1.sendSuccess)(res, await doctors_service_1.DoctorsService.getById(req.params.id));
    }
    catch (e) {
        next(e);
    }
});
// Doctor earnings stats
router.get('/me/earnings', authenticate_1.authenticate, (0, authorize_1.authorize)('doctor'), async (req, res, next) => {
    try {
        const { period = 'month' } = req.query;
        let dateFilter = '';
        if (period === 'week')
            dateFilter = "AND a.appt_date >= CURRENT_DATE - INTERVAL '7 days'";
        else if (period === 'month')
            dateFilter = "AND a.appt_date >= DATE_TRUNC('month', CURRENT_DATE)";
        else if (period === 'year')
            dateFilter = "AND a.appt_date >= DATE_TRUNC('year', CURRENT_DATE)";
        const [stats] = await (0, database_1.query)(`SELECT
        COUNT(*) AS total_consultations,
        COUNT(*) FILTER (WHERE a.status = 'completed') AS completed_consultations,
        COALESCE(SUM(CASE WHEN a.status = 'completed' THEN COALESCE(a.fee, 0) ELSE 0 END), 0) AS total_earnings,
        COALESCE(SUM(CASE WHEN a.status = 'confirmed' THEN COALESCE(a.fee, 0) ELSE 0 END), 0) AS pending_earnings,
        (SELECT avg_rating FROM doctors WHERE user_id=$1) AS avg_rating
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       WHERE d.user_id=$1 ${dateFilter}`, [req.user.sub]);
        (0, apiResponse_1.sendSuccess)(res, stats);
    }
    catch (e) {
        next(e);
    }
});
// Doctor earnings history
router.get('/me/earnings/history', authenticate_1.authenticate, (0, authorize_1.authorize)('doctor'), async (req, res, next) => {
    try {
        const { period = 'month' } = req.query;
        let dateFilter = '';
        if (period === 'week')
            dateFilter = "AND a.appt_date >= CURRENT_DATE - INTERVAL '7 days'";
        else if (period === 'month')
            dateFilter = "AND a.appt_date >= DATE_TRUNC('month', CURRENT_DATE)";
        else if (period === 'year')
            dateFilter = "AND a.appt_date >= DATE_TRUNC('year', CURRENT_DATE)";
        const history = await (0, database_1.query)(`SELECT a.id, a.appt_date, a.appt_time, a.status, a.consult_type,
              COALESCE(a.fee, 0) AS fee,
              pu.full_name AS patient_name
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       JOIN patients pt ON pt.id = a.patient_id
       JOIN users pu ON pu.id = pt.user_id
       WHERE d.user_id=$1 ${dateFilter}
       ORDER BY a.appt_date DESC LIMIT 50`, [req.user.sub]);
        (0, apiResponse_1.sendSuccess)(res, history);
    }
    catch (e) {
        next(e);
    }
});
exports.default = router;
//# sourceMappingURL=doctors.routes.js.map