import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface JwtPayload {
  sub: string;       // user_id
  role: string;
  doctorId?: string;
  patientId?: string;
  actingOwner?: string; // set when a patient acts for a family member (sub = member)
}

export function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessExpires as string,
    algorithm: 'HS256',
  } as jwt.SignOptions);
}

export function signRefreshToken(payload: Pick<JwtPayload, 'sub'>): string {
  return jwt.sign(payload, env.jwt.refreshSecret, {
    expiresIn: env.jwt.refreshExpires as string,
    algorithm: 'HS256',
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, env.jwt.accessSecret) as JwtPayload;
}

export function verifyRefreshToken(token: string): Pick<JwtPayload, 'sub'> {
  return jwt.verify(token, env.jwt.refreshSecret) as Pick<JwtPayload, 'sub'>;
}
