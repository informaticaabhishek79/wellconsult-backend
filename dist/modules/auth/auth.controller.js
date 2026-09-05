"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthController = void 0;
const auth_service_1 = require("./auth.service");
const apiResponse_1 = require("../../utils/apiResponse");
exports.AuthController = {
    async register(req, res, next) {
        try {
            const data = await auth_service_1.AuthService.register(req.body);
            (0, apiResponse_1.sendCreated)(res, { ...data, message: 'OTP sent to registered email.' });
        }
        catch (e) {
            next(e);
        }
    },
    async login(req, res, next) {
        try {
            const data = await auth_service_1.AuthService.login(req.body.email, req.body.password);
            res.cookie('refresh_token', data.refresh_token, {
                httpOnly: true, secure: true, sameSite: 'strict', maxAge: 30 * 24 * 60 * 60 * 1000,
            });
            (0, apiResponse_1.sendSuccess)(res, data);
        }
        catch (e) {
            next(e);
        }
    },
    async logout(req, res, next) {
        try {
            const token = req.headers.authorization.slice(7);
            await auth_service_1.AuthService.logout(token, req.user.sub);
            res.clearCookie('refresh_token');
            (0, apiResponse_1.sendSuccess)(res, { message: 'Logged out.' });
        }
        catch (e) {
            next(e);
        }
    },
    async refresh(req, res, next) {
        try {
            const refreshToken = req.cookies?.refresh_token || req.body?.refresh_token;
            if (!refreshToken) {
                (0, apiResponse_1.sendError)(res, 401, 'MISSING_REFRESH_TOKEN', 'Refresh token required.');
                return;
            }
            const data = await auth_service_1.AuthService.refresh(refreshToken);
            res.cookie('refresh_token', data.refresh_token, {
                httpOnly: true, secure: true, sameSite: 'strict', maxAge: 30 * 24 * 60 * 60 * 1000,
            });
            (0, apiResponse_1.sendSuccess)(res, data);
        }
        catch (e) {
            next(e);
        }
    },
    async sendOtp(req, res, next) {
        try {
            await auth_service_1.AuthService.sendOtp(req.body.user_id, req.body.purpose);
            (0, apiResponse_1.sendSuccess)(res, { message: 'OTP sent.' });
        }
        catch (e) {
            next(e);
        }
    },
    async verifyOtp(req, res, next) {
        try {
            await auth_service_1.AuthService.verifyOtp(req.body.user_id, req.body.otp_code, req.body.purpose);
            (0, apiResponse_1.sendSuccess)(res, { message: 'Verified.' });
        }
        catch (e) {
            next(e);
        }
    },
};
//# sourceMappingURL=auth.controller.js.map