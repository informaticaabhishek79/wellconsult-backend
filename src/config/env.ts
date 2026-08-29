import dotenv from 'dotenv';
dotenv.config();

const required = (key: string): string => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
};

export const env = {
  NODE_ENV:   process.env.NODE_ENV || 'development',
  PORT:       parseInt(process.env.PORT || '4000', 10),
  API_VERSION: process.env.API_VERSION || 'v1',

  db: {
    host:     required('DB_HOST'),
    port:     parseInt(process.env.DB_PORT || '5432', 10),
    database: required('DB_NAME'),
    user:     required('DB_USER'),
    password: required('DB_PASSWORD'),
    max:      parseInt(process.env.DB_POOL_MAX || '20', 10),
  },

  redis: { url: required('REDIS_URL') },

  jwt: {
    accessSecret:   required('JWT_ACCESS_SECRET'),
    refreshSecret:  required('JWT_REFRESH_SECRET'),
    accessExpires:  process.env.JWT_ACCESS_EXPIRES  || '24h',
    refreshExpires: process.env.JWT_REFRESH_EXPIRES || '30d',
  },

  aws: {
    region:    required('AWS_REGION'),
    accessKey: required('AWS_ACCESS_KEY_ID'),
    secretKey: required('AWS_SECRET_ACCESS_KEY'),
    bucket:    required('AWS_S3_BUCKET'),
  },

  razorpay: {
    keyId:         required('RAZORPAY_KEY_ID'),
    keySecret:     required('RAZORPAY_KEY_SECRET'),
    webhookSecret: required('RAZORPAY_WEBHOOK_SECRET'),
  },

  firebase: {
    projectId:   process.env.FIREBASE_PROJECT_ID || '',
    privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
  },

  smtp: {
    host:     required('SMTP_HOST'),
    port:     parseInt(process.env.SMTP_PORT || '587', 10),
    user:     required('SMTP_USER'),
    pass:     required('SMTP_PASS'),
    from:     process.env.EMAIL_FROM || 'noreply@wellconsult.in',
  },

  twilio: {
    accountSid: required('TWILIO_ACCOUNT_SID'),
    authToken:  required('TWILIO_AUTH_TOKEN'),
    phone:      required('TWILIO_PHONE'),
  },

  daily: {
    apiKey: required('DAILY_API_KEY'),
    domain: required('DAILY_DOMAIN'),
  },

  cors: {
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(','),
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
    max:      parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  },
} as const;
