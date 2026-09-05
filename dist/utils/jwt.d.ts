export interface JwtPayload {
    sub: string;
    role: string;
    doctorId?: string;
    patientId?: string;
}
export declare function signAccessToken(payload: JwtPayload): string;
export declare function signRefreshToken(payload: Pick<JwtPayload, 'sub'>): string;
export declare function verifyAccessToken(token: string): JwtPayload;
export declare function verifyRefreshToken(token: string): Pick<JwtPayload, 'sub'>;
