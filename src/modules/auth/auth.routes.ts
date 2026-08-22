import { Router } from 'express';
import { AuthController } from './auth.controller';
import { authenticate } from '../../middleware/authenticate';
import { authLimiter, otpLimiter } from '../../middleware/rateLimiter';
import { validate } from '../../middleware/validate';
import { registerSchema, loginSchema, otpSendSchema, otpVerifySchema } from './auth.schema';

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), AuthController.register);
router.post('/login',    authLimiter, validate(loginSchema),    AuthController.login);
router.post('/logout',   authenticate,                           AuthController.logout);
router.post('/refresh',                                          AuthController.refresh);
router.post('/otp/send',   otpLimiter, validate(otpSendSchema),   AuthController.sendOtp);
router.post('/otp/verify', otpLimiter, validate(otpVerifySchema),  AuthController.verifyOtp);

export default router;
