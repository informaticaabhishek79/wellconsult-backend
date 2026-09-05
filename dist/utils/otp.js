"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OTP_TTL_SECONDS = exports.generateOtp = void 0;
const crypto_1 = __importDefault(require("crypto"));
const generateOtp = () => crypto_1.default.randomInt(100000, 999999).toString();
exports.generateOtp = generateOtp;
exports.OTP_TTL_SECONDS = 600; // 10 minutes
//# sourceMappingURL=otp.js.map