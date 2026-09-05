export declare function notifyAppointmentBooked(p: {
    doctorPhone?: string;
    patientName: string;
    date: string;
    time: string;
    consultType: string;
}): Promise<void>;
export declare function notifyAppointmentConfirmed(p: {
    patientPhone?: string;
    doctorName: string;
    date: string;
    time: string;
    consultType: string;
}): Promise<void>;
export declare function notifyAppointmentCancelled(p: {
    phone?: string;
    date: string;
    time: string;
    reason?: string;
}): Promise<void>;
export declare function notifyAppointmentReminder(p: {
    phone?: string;
    doctorName: string;
    time: string;
    consultType: string;
}): Promise<void>;
export declare function notifyPrescriptionIssued(p: {
    patientPhone?: string;
    doctorName: string;
    medicineCount: number;
}): Promise<void>;
export declare function notifyVerificationApproved(p: {
    doctorPhone?: string;
    doctorName: string;
}): Promise<void>;
export declare function notifyVerificationRejected(p: {
    doctorPhone?: string;
    doctorName: string;
    reason?: string;
}): Promise<void>;
export declare function notifyFollowUpReminder(p: {
    patientPhone?: string;
    patientName: string;
    doctorName: string;
}): Promise<void>;
export declare function notifyNewQuestion(p: {
    doctorPhone?: string;
    patientName: string;
}): Promise<void>;
export declare function notifyQuestionAnswered(p: {
    patientPhone?: string;
    doctorName: string;
}): Promise<void>;
