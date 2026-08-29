import { logger } from '../utils/logger';

const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM  = process.env.TWILIO_PHONE || '';
const TWILIO_WA    = process.env.TWILIO_WHATSAPP || 'whatsapp:+14155238886';

async function twilioRequest(to: string, body: string, channel: 'sms' | 'whatsapp' = 'sms') {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
    logger.warn('Twilio not configured, skipping notification');
    return;
  }
  const from  = channel === 'whatsapp' ? TWILIO_WA : TWILIO_FROM;
  const toNum = channel === 'whatsapp' ? `whatsapp:${to}` : to;
  const url   = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
  const res   = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: from, To: toNum, Body: body }),
  });
  const data = await res.json() as any;
  if (!res.ok) throw new Error(`Twilio error: ${data.message}`);
  return data;
}

async function sendNotification(phone: string | null | undefined, message: string) {
  if (!phone) return;
  const cleaned = phone.replace(/\s/g, '').startsWith('+') ? phone.replace(/\s/g, '') : `+91${phone.replace(/\D/g, '')}`;
  setImmediate(async () => {
    try { await twilioRequest(cleaned, message, 'sms'); logger.info('SMS sent', { to: cleaned }); }
    catch (err) { logger.warn('SMS failed', { error: (err as Error).message }); }
  });
}

export async function notifyAppointmentBooked(p: { doctorPhone?: string; patientName: string; date: string; time: string; consultType: string }) {
  await sendNotification(p.doctorPhone, `WellConsult: New appointment booked!\n\nPatient: ${p.patientName}\nDate: ${p.date}\nTime: ${p.time}\nType: ${p.consultType}\n\nLog in to confirm.`);
}

export async function notifyAppointmentConfirmed(p: { patientPhone?: string; doctorName: string; date: string; time: string; consultType: string }) {
  await sendNotification(p.patientPhone, `WellConsult: Appointment confirmed!\n\nDoctor: ${p.doctorName}\nDate: ${p.date}\nTime: ${p.time}\nType: ${p.consultType}\n\nJoin via WellConsult at the scheduled time.`);
}

export async function notifyAppointmentCancelled(p: { phone?: string; date: string; time: string; reason?: string }) {
  await sendNotification(p.phone, `WellConsult: Appointment cancelled\n\nDate: ${p.date}\nTime: ${p.time}\n${p.reason ? `Reason: ${p.reason}\n` : ''}Refund processed in 5-7 business days.`);
}

export async function notifyAppointmentReminder(p: { phone?: string; doctorName: string; time: string; consultType: string }) {
  await sendNotification(p.phone, `WellConsult Reminder: Consultation in 1 hour!\n\nDoctor: ${p.doctorName}\nTime: ${p.time}\nType: ${p.consultType}\n\nOpen WellConsult to join.`);
}

export async function notifyPrescriptionIssued(p: { patientPhone?: string; doctorName: string; medicineCount: number }) {
  await sendNotification(p.patientPhone, `WellConsult: New prescription issued\n\nDr. ${p.doctorName} issued a prescription with ${p.medicineCount} medicine(s).\n\nView in WellConsult -> Prescriptions.`);
}

export async function notifyVerificationApproved(p: { doctorPhone?: string; doctorName: string }) {
  await sendNotification(p.doctorPhone, `WellConsult: Verification approved!\n\nCongratulations ${p.doctorName}! Your profile is now live and visible to patients.`);
}

export async function notifyVerificationRejected(p: { doctorPhone?: string; doctorName: string; reason?: string }) {
  await sendNotification(p.doctorPhone, `WellConsult: Verification update\n\nDear ${p.doctorName}, verification could not be approved.\n${p.reason ? `Reason: ${p.reason}\n` : ''}Please re-upload documents.`);
}

export async function notifyFollowUpReminder(p: { patientPhone?: string; patientName: string; doctorName: string }) {
  await sendNotification(p.patientPhone, `WellConsult Follow-up Reminder\n\nDear ${p.patientName}, time for your follow-up with Dr. ${p.doctorName}.\n\nBook at WellConsult.`);
}

export async function notifyNewQuestion(p: { doctorPhone?: string; patientName: string }) {
  await sendNotification(p.doctorPhone, `WellConsult: New question from ${p.patientName}\n\nLog in to respond within 15 minutes.`);
}

export async function notifyQuestionAnswered(p: { patientPhone?: string; doctorName: string }) {
  await sendNotification(p.patientPhone, `WellConsult: Dr. ${p.doctorName} answered your question.\n\nView in WellConsult -> Ask a Doctor.`);
}
