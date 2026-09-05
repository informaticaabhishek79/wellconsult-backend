import { Request } from 'express';
export declare const DoctorsService: {
    search(req: Request): Promise<{
        rows: Record<string, unknown>[];
        total: number;
        page: number;
        limit: number;
    }>;
    getById(doctorId: string): Promise<Record<string, unknown>>;
    getAvailability(doctorId: string, date: string): Promise<{
        doctor_id: string;
        date: string;
        available_slots: Record<string, unknown>[];
    }>;
    updateProfile(doctorId: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null>;
    getDashboard(doctorId: string): Promise<{
        stats: Record<string, unknown>;
        upcoming: Record<string, unknown>[];
    }>;
    getMyProfile(doctorId: string): Promise<Record<string, unknown> | null>;
    updateFees(doctorId: string, body: {
        consult_type: string;
        fee_amount: number;
        currency: string;
    }): Promise<{
        success: boolean;
    }>;
    addAvailability(doctorId: string, body: {
        day_of_week: number;
        slot_start: string;
        slot_end: string;
    }): Promise<{
        success: boolean;
    }>;
};
