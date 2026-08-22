import { Request, Response, NextFunction } from 'express';
import { AuthService } from './auth.service';
import { sendSuccess, sendCreated, sendError } from '../../utils/apiResponse';

export const AuthController = {
  async register(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await AuthService.register(req.body);
      sendCreated(res, { ...data, message: 'OTP sent to registered email.' });
    } catch (e) { next(e); }
  },

  async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await AuthService.login(req.body.email, req.body.password);
      res.cookie('refresh_token', data.refresh_token, {
        httpOnly: true, secure: true, sameSite: 'strict', maxAge: 30 * 24 * 60 * 60 * 1000,
      });
      sendSuccess(res, data);
    } catch (e) { next(e); }
  },

  async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const token = req.headers.authorization!.slice(7);
      await AuthService.logout(token, req.user!.sub);
      res.clearCookie('refresh_token');
      sendSuccess(res, { message: 'Logged out.' });
    } catch (e) { next(e); }
  },

  async refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const refreshToken = req.cookies?.refresh_token || req.body?.refresh_token;
      if (!refreshToken) { sendError(res, 401, 'MISSING_REFRESH_TOKEN', 'Refresh token required.'); return; }
      const data = await AuthService.refresh(refreshToken);
      res.cookie('refresh_token', data.refresh_token, {
        httpOnly: true, secure: true, sameSite: 'strict', maxAge: 30 * 24 * 60 * 60 * 1000,
      });
      sendSuccess(res, data);
    } catch (e) { next(e); }
  },

  async sendOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await AuthService.sendOtp(req.body.user_id, req.body.purpose);
      sendSuccess(res, { message: 'OTP sent.' });
    } catch (e) { next(e); }
  },

  async verifyOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await AuthService.verifyOtp(req.body.user_id, req.body.otp_code, req.body.purpose);
      sendSuccess(res, { message: 'Verified.' });
    } catch (e) { next(e); }
  },
};
