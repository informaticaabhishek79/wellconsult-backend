/** General API rate limiter — 100 req / 15 min per IP */
export declare const apiLimiter: import("express-rate-limit").RateLimitRequestHandler;
/** Auth endpoints — stricter: 10 req / 15 min */
export declare const authLimiter: import("express-rate-limit").RateLimitRequestHandler;
/** OTP send — 5 req / 10 min */
export declare const otpLimiter: import("express-rate-limit").RateLimitRequestHandler;
/** File upload — 20 req / hour */
export declare const uploadLimiter: import("express-rate-limit").RateLimitRequestHandler;
