import { z } from 'zod';

export const registerSchema = z.object({
  body: z.object({
    full_name: z.string().min(2).max(120),
    email:     z.string().email(),
    phone:     z.string().regex(/^\+?[1-9]\d{9,14}$/).optional(),
    password:  z.string().min(8).regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/,
      'Password must have uppercase, lowercase, number, and special character.'),
    role:      z.enum(['patient', 'doctor']),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email:    z.string().email(),
    password: z.string().min(1),
  }),
});

export const otpSendSchema = z.object({
  body: z.object({
    identifier: z.string(),  // email or phone
    purpose:    z.enum(['email', 'phone', 'password_reset']),
  }),
});

export const otpVerifySchema = z.object({
  body: z.object({
    user_id:  z.string().uuid(),
    otp_code: z.string().length(6).regex(/^\d+$/),
    purpose:  z.enum(['email', 'phone', 'password_reset']),
  }),
});

export const resetPasswordSchema = z.object({
  body: z.object({
    token:        z.string().min(1),
    new_password: z.string().min(8),
  }),
});
