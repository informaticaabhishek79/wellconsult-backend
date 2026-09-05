import { z } from 'zod';
export declare const registerSchema: z.ZodObject<{
    body: z.ZodObject<{
        full_name: z.ZodString;
        email: z.ZodString;
        phone: z.ZodOptional<z.ZodString>;
        password: z.ZodString;
        role: z.ZodEnum<["patient", "doctor"]>;
    }, "strip", z.ZodTypeAny, {
        password: string;
        role: "patient" | "doctor";
        email: string;
        full_name: string;
        phone?: string | undefined;
    }, {
        password: string;
        role: "patient" | "doctor";
        email: string;
        full_name: string;
        phone?: string | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    body: {
        password: string;
        role: "patient" | "doctor";
        email: string;
        full_name: string;
        phone?: string | undefined;
    };
}, {
    body: {
        password: string;
        role: "patient" | "doctor";
        email: string;
        full_name: string;
        phone?: string | undefined;
    };
}>;
export declare const loginSchema: z.ZodObject<{
    body: z.ZodObject<{
        email: z.ZodString;
        password: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        password: string;
        email: string;
    }, {
        password: string;
        email: string;
    }>;
}, "strip", z.ZodTypeAny, {
    body: {
        password: string;
        email: string;
    };
}, {
    body: {
        password: string;
        email: string;
    };
}>;
export declare const otpSendSchema: z.ZodObject<{
    body: z.ZodObject<{
        identifier: z.ZodString;
        purpose: z.ZodEnum<["email", "phone", "password_reset"]>;
    }, "strip", z.ZodTypeAny, {
        identifier: string;
        purpose: "phone" | "password_reset" | "email";
    }, {
        identifier: string;
        purpose: "phone" | "password_reset" | "email";
    }>;
}, "strip", z.ZodTypeAny, {
    body: {
        identifier: string;
        purpose: "phone" | "password_reset" | "email";
    };
}, {
    body: {
        identifier: string;
        purpose: "phone" | "password_reset" | "email";
    };
}>;
export declare const otpVerifySchema: z.ZodObject<{
    body: z.ZodObject<{
        user_id: z.ZodString;
        otp_code: z.ZodString;
        purpose: z.ZodEnum<["email", "phone", "password_reset"]>;
    }, "strip", z.ZodTypeAny, {
        user_id: string;
        purpose: "phone" | "password_reset" | "email";
        otp_code: string;
    }, {
        user_id: string;
        purpose: "phone" | "password_reset" | "email";
        otp_code: string;
    }>;
}, "strip", z.ZodTypeAny, {
    body: {
        user_id: string;
        purpose: "phone" | "password_reset" | "email";
        otp_code: string;
    };
}, {
    body: {
        user_id: string;
        purpose: "phone" | "password_reset" | "email";
        otp_code: string;
    };
}>;
export declare const resetPasswordSchema: z.ZodObject<{
    body: z.ZodObject<{
        token: z.ZodString;
        new_password: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        token: string;
        new_password: string;
    }, {
        token: string;
        new_password: string;
    }>;
}, "strip", z.ZodTypeAny, {
    body: {
        token: string;
        new_password: string;
    };
}, {
    body: {
        token: string;
        new_password: string;
    };
}>;
