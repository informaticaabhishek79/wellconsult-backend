export declare const AuthService: {
    register(body: {
        full_name: string;
        email: string;
        phone?: string;
        password: string;
        role: "patient" | "doctor";
    }): Promise<{
        user_id: string;
        role: string;
    }>;
    login(email: string, password: string): Promise<{
        access_token: string;
        refresh_token: string;
        expires_in: number;
        user: {
            id: string;
            full_name: string;
            role: import("../../types").UserRole;
            doctorId: string;
            patientId: string;
        };
    }>;
    logout(accessToken: string, userId: string): Promise<void>;
    refresh(refreshToken: string): Promise<{
        access_token: string;
        refresh_token: string;
        expires_in: number;
    }>;
    sendOtp(userId: string, purpose: string): Promise<void>;
    verifyOtp(userId: string, otpCode: string, purpose: string): Promise<void>;
};
