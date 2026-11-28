import { Resend } from 'resend';
import { logger } from './logger';

/* One mailer for the whole app. Uses Resend when RESEND_API_KEY is set, otherwise SMTP
   (set EMAIL_PROVIDER=smtp to force SMTP). Same shape as resend.emails.send so callers don't change. */

type Mail = { from?: string; to: string | string[]; subject: string; html: string };
type Result = { data?: any; error?: { message: string } | null };

const smtpReady = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const port = parseInt(process.env.SMTP_PORT || '587', 10);

let nodemailer: any = null;
try { nodemailer = require('nodemailer'); } catch { logger.error('nodemailer is not installed — SMTP disabled'); }

const transport = smtpReady && nodemailer
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

const resendClient = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const preferSmtp = process.env.EMAIL_PROVIDER === 'smtp' || !resendClient;

// With SMTP the sender must usually be the SMTP mailbox (or an alias of it).
const smtpFrom = `Deemona Doctors <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`;

export const mailConfigured = !!transport || !!resendClient;
export const mailProvider = preferSmtp && transport ? 'smtp' : resendClient ? 'resend' : transport ? 'smtp' : 'none';
logger.info('Email provider', { provider: mailProvider });

export const mailer = {
  emails: {
    async send(mail: Mail): Promise<Result> {
      if (mailProvider === 'smtp' && transport) {
        try {
          const info = await transport.sendMail({ from: smtpFrom, to: mail.to, subject: mail.subject, html: mail.html });
          return { data: { id: info.messageId }, error: null };
        } catch (e: any) {
          logger.error('SMTP send failed', { error: e?.message, code: e?.code });
          return { error: { message: e?.message || 'SMTP send failed' } };
        }
      }
      if (resendClient) {
        const r: any = await resendClient.emails.send({ from: mail.from || 'Deemona Doctors <noreply@mail.deemona.com>', to: mail.to, subject: mail.subject, html: mail.html });
        if (r?.error) logger.error('Resend send failed', { error: r.error });
        return r;
      }
      logger.warn('No email provider configured (set SMTP_* or RESEND_API_KEY)');
      return { error: { message: 'No email provider configured' } };
    },
  },
};
