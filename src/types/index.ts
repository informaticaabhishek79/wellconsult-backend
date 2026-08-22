export type MedicalSystem = 'allopathy' | 'homeopathy' | 'ayurveda' | 'yoga' | 'naturopathy' | 'unani';
export type UserRole       = 'patient' | 'doctor' | 'admin';
export type ProfileStatus  = 'pending' | 'verified' | 'rejected' | 'suspended';
export type ConsultType    = 'video' | 'phone' | 'clinic';
export type ApptStatus     = 'booked' | 'confirmed' | 'ongoing' | 'completed' | 'cancelled' | 'no_show';
export type PaymentStatus  = 'pending' | 'paid' | 'failed' | 'refunded';
export type SessionStatus  = 'scheduled' | 'live' | 'ended';

export interface User {
  id: string; full_name: string; email: string; phone?: string;
  role: UserRole; avatar_url?: string; is_verified: boolean;
  is_active: boolean; created_at: Date; updated_at: Date;
}

export interface Doctor {
  id: string; user_id: string; medical_system: MedicalSystem;
  degree: string; reg_number: string; reg_body: string;
  specialization?: string; experience_years: number; city: string;
  bio?: string; languages: string[]; profile_status: ProfileStatus;
  avg_rating?: number; total_reviews: number;
  verified_at?: Date; created_at: Date; updated_at: Date;
}

export interface Patient {
  id: string; user_id: string; date_of_birth?: Date; gender?: string;
  blood_group?: string; known_allergies: string[];
  chronic_conditions: string[]; emergency_contact?: string;
}

export interface Appointment {
  id: string; doctor_id: string; patient_id: string;
  appt_date: Date; appt_time: string; consult_type: ConsultType;
  status: ApptStatus; cancel_reason?: string; payment_id?: string;
  booked_at: Date; updated_at: Date;
}
