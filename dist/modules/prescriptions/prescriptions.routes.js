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
const database_1 = require("../../config/database");
const apiResponse_1 = require("../../utils/apiResponse");
const errorHandler_1 = require("../../middleware/errorHandler");
const router = (0, express_1.Router)();
router.use(authenticate_1.authenticate);
// POST /prescriptions (doctor only)
router.post('/', (0, authorize_1.authorize)('doctor'), async (req, res, next) => {
    try {
        const { consultation_id, appointment_id, medical_system, items } = req.body;
        let c = null;
        if (consultation_id) {
            c = await (0, database_1.queryOne)('SELECT doctor_id, patient_id FROM consultations WHERE id=$1', [consultation_id]);
        }
        else if (appointment_id) {
            // Get doctor and patient from appointment directly
            const appt = await (0, database_1.queryOne)('SELECT doctor_id, patient_id FROM appointments WHERE id=$1', [appointment_id]);
            c = appt || null;
        }
        if (!c)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Consultation not found.');
        const result = await (0, database_1.withTransaction)(async (client) => {
            const [rx] = await client.query(`INSERT INTO prescriptions (consultation_id, doctor_id, patient_id, medical_system)
         VALUES ($1,$2,$3,$4) RETURNING id, issued_at`, [consultation_id || null, c.doctor_id, c.patient_id, medical_system]).then(r => r.rows);
            for (const item of items || []) {
                await client.query(`INSERT INTO prescription_items (prescription_id, medicine_name, dosage, frequency, duration_days, instructions)
           VALUES ($1,$2,$3,$4,$5,$6)`, [rx.id, item.medicine_name, item.dosage, item.frequency, item.duration_days, item.instructions]);
            }
            return rx;
        });
        (0, apiResponse_1.sendCreated)(res, result);
    }
    catch (e) {
        next(e);
    }
});
// GET /prescriptions (patient gets their prescriptions)
router.get('/', async (req, res, next) => {
    try {
        const { query } = await Promise.resolve().then(() => __importStar(require('../../config/database')));
        let prescriptions = [];
        if (req.user.role === 'patient') {
            const [patient] = await query('SELECT id FROM patients WHERE user_id=$1', [req.user.sub]);
            if (!patient) {
                (0, apiResponse_1.sendSuccess)(res, []);
                return;
            }
            prescriptions = await query(`SELECT p.id, p.medical_system, p.issued_at,
                u.full_name AS doctor_name,
                JSON_AGG(pi ORDER BY pi.id) FILTER (WHERE pi.id IS NOT NULL) AS items
         FROM prescriptions p
         JOIN doctors d ON d.id = p.doctor_id
         JOIN users u ON u.id = d.user_id
         LEFT JOIN prescription_items pi ON pi.prescription_id = p.id
         WHERE p.patient_id = $1
         GROUP BY p.id, u.full_name
         ORDER BY p.issued_at DESC`, [patient.id]);
        }
        else if (req.user.role === 'doctor') {
            prescriptions = await query(`SELECT p.id, p.medical_system, p.issued_at,
                pu.full_name AS patient_name,
                JSON_AGG(pi ORDER BY pi.id) FILTER (WHERE pi.id IS NOT NULL) AS items
         FROM prescriptions p
         JOIN patients pat ON pat.id = p.patient_id
         JOIN users pu ON pu.id = pat.user_id
         LEFT JOIN prescription_items pi ON pi.prescription_id = p.id
         WHERE p.doctor_id = $1
         GROUP BY p.id, pu.full_name
         ORDER BY p.issued_at DESC`, [req.user.doctorId]);
        }
        else {
            prescriptions = [];
        }
        (0, apiResponse_1.sendSuccess)(res, prescriptions);
    }
    catch (e) {
        next(e);
    }
});
// GET /prescriptions/:id
router.get('/:id', async (req, res, next) => {
    try {
        const rx = await (0, database_1.queryOne)(`SELECT p.*, u.full_name AS doctor_name,
              JSON_AGG(pi ORDER BY pi.id) AS items
       FROM prescriptions p
       JOIN doctors d ON d.id = p.doctor_id
       JOIN users u ON u.id = d.user_id
       LEFT JOIN prescription_items pi ON pi.prescription_id = p.id
       WHERE p.id=$1 GROUP BY p.id, u.full_name`, [req.params.id]);
        if (!rx)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Prescription not found.');
        (0, apiResponse_1.sendSuccess)(res, rx);
    }
    catch (e) {
        next(e);
    }
});
exports.default = router;
//# sourceMappingURL=prescriptions.routes.js.map