import { Request } from 'express';
export declare const AppointmentsService: {
    book(patientId: string, body: {
        doctor_id: string;
        appt_date: string;
        appt_time: string;
        consult_type: string;
        payment_method: string;
        is_emergency?: boolean;
    }): Promise<{
        appointment_id: any;
        status: any;
        payment: {
            payment_id: any;
            gateway: string;
            razorpay_order_id: string;
            amount: number;
            currency: string;
        };
    }>;
    getById(appointmentId: string): Promise<Record<string, unknown>>;
    cancel(appointmentId: string, reason: string): Promise<{
        appointment_id: string;
        status: string;
        refund_initiated: boolean;
    }>;
    listForPatient(patientId: string, req: Request): Promise<{
        rows: Record<string, unknown>[];
        total: number;
        page: number;
        limit: number;
    }>;
};
