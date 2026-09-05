"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetPasswordSchema = exports.otpVerifySchema = exports.otpSendSchema = exports.loginSchema = exports.registerSchema = void 0;
const zod_1 = require("zod");
exports.registerSchema = zod_1.z.object({
    body: zod_1.z.object({
        full_name: zod_1.z.string().min(2).max(120),
        email: zod_1.z.string().email(),
        phone: zod_1.z.string().regex(/^\+?[1-9]\d{9,14}$/).optional(),
        password: zod_1.z.string().min(8).regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/, 'Password must have uppercase, lowercase, number, and special character.'),
        role: zod_1.z.enum(['patient', 'doctor']),
    }),
});
exports.loginSchema = zod_1.z.object({
    body: zod_1.z.object({
        email: zod_1.z.string().email(),
        password: zod_1.z.string().min(1),
    }),
});
exports.otpSendSchema = zod_1.z.object({
    body: zod_1.z.object({
        identifier: zod_1.z.string(), // email or phone
        purpose: zod_1.z.enum(['email', 'phone', 'password_reset']),
    }),
});
exports.otpVerifySchema = zod_1.z.object({
    body: zod_1.z.object({
        user_id: zod_1.z.string().uuid(),
        otp_code: zod_1.z.string().length(6).regex(/^\d+$/),
        purpose: zod_1.z.enum(['email', 'phone', 'password_reset']),
    }),
});
exports.resetPasswordSchema = zod_1.z.object({
    body: zod_1.z.object({
        token: zod_1.z.string().min(1),
        new_password: zod_1.z.string().min(8),
    }),
});
//# sourceMappingURL=auth.schema.js.map