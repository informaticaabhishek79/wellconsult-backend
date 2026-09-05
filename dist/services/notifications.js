"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notifyAppointmentBooked = notifyAppointmentBooked;
exports.notifyAppointmentConfirmed = notifyAppointmentConfirmed;
exports.notifyAppointmentCancelled = notifyAppointmentCancelled;
exports.notifyAppointmentReminder = notifyAppointmentReminder;
exports.notifyPrescriptionIssued = notifyPrescriptionIssued;
exports.notifyVerificationApproved = notifyVerificationApproved;
exports.notifyVerificationRejected = notifyVerificationRejected;
exports.notifyFollowUpReminder = notifyFollowUpReminder;
exports.notifyNewQuestion = notifyNewQuestion;
exports.notifyQuestionAnswered = notifyQuestionAnswered;
const logger_1 = require("../utils/logger");
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM = process.env.TWILIO_PHONE || '';
const TWILIO_WA = process.env.TWILIO_WHATSAPP || 'whatsapp:+17372212163';
async function twilioRequest(to, body, channel = 'sms') {
    if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
        logger_1.logger.warn('Twilio not configured, skipping notification');
        return;
    }
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
    const auth = 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    if (channel === 'whatsapp') {
        // WhatsApp sandbox with ContentSid (pre-approved Hello World template)
        const params = new URLSearchParams({
            From: TWILIO_WA,
            To: `whatsapp:${to}`,
            ContentSid: 'HXb5b62575e6e4ff6129ad7c8efe1f983e',
        });
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': auth, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params,
        });
        const data = await res.json();
        if (!res.ok)
            throw new Error(`Twilio error: ${data.message}`);
        return data;
    }
    else {
        // SMS - use verified number to verified number
        const params = new URLSearchParams({ From: TWILIO_FROM, To: to, Body: body });
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': auth, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params,
        });
        const data = await res.json();
        if (!res.ok)
            throw new Error(`Twilio error: ${data.message}`);
        return data;
    }
}
async function sendNotification(phone, message) {
    if (!phone)
        return;
    const cleaned = phone.replace(/\s/g, '').startsWith('+') ? phone.replace(/\s/g, '') : `+91${phone.replace(/\D/g, '')}`;
    setImmediate(async () => {
        try {
            await twilioRequest(cleaned, message, 'sms');
            logger_1.logger.info('SMS sent', { to: cleaned });
        }
        catch (err) {
            logger_1.logger.warn('SMS failed', { error: err.message });
        }
        try {
            await twilioRequest(cleaned, message, 'whatsapp');
            logger_1.logger.info('WhatsApp sent', { to: cleaned });
        }
        catch (err) {
            logger_1.logger.warn('WhatsApp failed', { error: err.message });
        }
    });
}
async function notifyAppointmentBooked(p) {
    await sendNotification(p.doctorPhone, `Deemona Doctors: New appointment booked!\n\nPatient: ${p.patientName}\nDate: ${p.date}\nTime: ${p.time}\nType: ${p.consultType}\n\nLog in to confirm.`);
}
async function notifyAppointmentConfirmed(p) {
    await sendNotification(p.patientPhone, `Deemona Doctors: Appointment confirmed!\n\nDoctor: ${p.doctorName}\nDate: ${p.date}\nTime: ${p.time}\nType: ${p.consultType}\n\nJoin via Deemona Doctors at the scheduled time.`);
}
async function notifyAppointmentCancelled(p) {
    await sendNotification(p.phone, `Deemona Doctors: Appointment cancelled\n\nDate: ${p.date}\nTime: ${p.time}\n${p.reason ? `Reason: ${p.reason}\n` : ''}Refund processed in 5-7 business days.`);
}
async function notifyAppointmentReminder(p) {
    await sendNotification(p.phone, `Deemona Doctors Reminder: Consultation in 1 hour!\n\nDoctor: ${p.doctorName}\nTime: ${p.time}\nType: ${p.consultType}\n\nOpen Deemona Doctors to join.`);
}
async function notifyPrescriptionIssued(p) {
    await sendNotification(p.patientPhone, `Deemona Doctors: New prescription issued\n\nDr. ${p.doctorName} issued a prescription with ${p.medicineCount} medicine(s).\n\nView in Deemona Doctors -> Prescriptions.`);
}
async function notifyVerificationApproved(p) {
    await sendNotification(p.doctorPhone, `Deemona Doctors: Verification approved!\n\nCongratulations ${p.doctorName}! Your profile is now live and visible to patients.`);
}
async function notifyVerificationRejected(p) {
    await sendNotification(p.doctorPhone, `Deemona Doctors: Verification update\n\nDear ${p.doctorName}, verification could not be approved.\n${p.reason ? `Reason: ${p.reason}\n` : ''}Please re-upload documents.`);
}
async function notifyFollowUpReminder(p) {
    await sendNotification(p.patientPhone, `Deemona Doctors Follow-up Reminder\n\nDear ${p.patientName}, time for your follow-up with Dr. ${p.doctorName}.\n\nBook at Deemona Doctors.`);
}
async function notifyNewQuestion(p) {
    await sendNotification(p.doctorPhone, `Deemona Doctors: New question from ${p.patientName}\n\nLog in to respond within 15 minutes.`);
}
async function notifyQuestionAnswered(p) {
    await sendNotification(p.patientPhone, `Deemona Doctors: Dr. ${p.doctorName} answered your question.\n\nView in Deemona Doctors -> Ask a Doctor.`);
}
//# sourceMappingURL=notifications.js.map