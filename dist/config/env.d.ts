export declare const env: {
    readonly NODE_ENV: string;
    readonly PORT: number;
    readonly API_VERSION: string;
    readonly db: {
        readonly host: string;
        readonly port: number;
        readonly database: string;
        readonly user: string;
        readonly password: string;
        readonly max: number;
    };
    readonly redis: {
        readonly url: string;
    };
    readonly jwt: {
        readonly accessSecret: string;
        readonly refreshSecret: string;
        readonly accessExpires: string;
        readonly refreshExpires: string;
    };
    readonly aws: {
        readonly region: string;
        readonly accessKey: string;
        readonly secretKey: string;
        readonly bucket: string;
    };
    readonly razorpay: {
        readonly keyId: string;
        readonly keySecret: string;
        readonly webhookSecret: string;
    };
    readonly firebase: {
        readonly projectId: string;
        readonly privateKey: string;
        readonly clientEmail: string;
    };
    readonly smtp: {
        readonly host: string;
        readonly port: number;
        readonly user: string;
        readonly pass: string;
        readonly from: string;
    };
    readonly twilio: {
        readonly accountSid: string;
        readonly authToken: string;
        readonly phone: string;
    };
    readonly daily: {
        readonly apiKey: string;
        readonly domain: string;
    };
    readonly cors: {
        readonly allowedOrigins: string[];
    };
    readonly rateLimit: {
        readonly windowMs: number;
        readonly max: number;
    };
};
