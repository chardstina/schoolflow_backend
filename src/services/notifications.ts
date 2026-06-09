/**
 * Notification Service — SMS via Termii + Email via Nodemailer/SendGrid
 */
import axios from 'axios';
import nodemailer from 'nodemailer';
import { formatNaira } from '../utils/currency';

const TERMII_API_KEY = process.env.TERMII_API_KEY!;
const TERMII_SENDER_ID = process.env.TERMII_SENDER_ID ?? 'SchoolFlow';

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// ── SMS via Termii ─────────────────────────────────────────────

export async function sendSms(phone: string, message: string): Promise<void> {
  // Normalize Nigerian number to international format
  const normalized = phone.startsWith('0') ? `234${phone.slice(1)}` : phone.replace(/^\+/, '');

  await axios.post('https://api.ng.termii.com/api/sms/send', {
    to: normalized,
    from: TERMII_SENDER_ID,
    sms: message,
    type: 'plain',
    channel: 'generic',
    api_key: TERMII_API_KEY,
  });
}

// ── Email ──────────────────────────────────────────────────────

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  await mailer.sendMail({
    from: `"${process.env.EMAIL_FROM_NAME ?? 'SchoolFlow'}" <${process.env.EMAIL_FROM}>`,
    to,
    subject,
    html,
  });
}

// ── Payment Reminder ───────────────────────────────────────────

export async function sendPaymentReminder(invoice: any): Promise<void> {
  const parent = invoice.student?.parent?.user;
  const studentName = `${invoice.student.firstName} ${invoice.student.lastName}`;
  const schoolName = invoice.school?.name ?? 'the school';
  const balance = formatNaira(invoice.balanceKobo / 100);
  const invoiceNo = invoice.invoiceNo;

  const smsText = `Dear ${parent?.firstName ?? 'Parent'}, ${studentName}'s school fee balance at ${schoolName} is ${balance} for ${invoice.term?.name ?? 'this term'}. Invoice: ${invoiceNo}. Pay now via your parent portal. SchoolFlow.`;

  const emailHtml = `
    <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px">
      <h2 style="color:#1a3c5e">Fee Payment Reminder</h2>
      <p>Dear ${parent?.firstName ?? 'Parent'},</p>
      <p>This is a reminder that <strong>${studentName}</strong>'s school fee balance at
        <strong>${schoolName}</strong> is outstanding.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:8px;background:#f5f5f5"><strong>Invoice No</strong></td>
            <td style="padding:8px">${invoiceNo}</td></tr>
        <tr><td style="padding:8px;background:#f5f5f5"><strong>Term</strong></td>
            <td style="padding:8px">${invoice.term?.name ?? ''}</td></tr>
        <tr><td style="padding:8px;background:#f5f5f5"><strong>Outstanding Balance</strong></td>
            <td style="padding:8px;color:#e53e3e;font-weight:bold">${balance}</td></tr>
        <tr><td style="padding:8px;background:#f5f5f5"><strong>Due Date</strong></td>
            <td style="padding:8px">${new Date(invoice.dueDate).toLocaleDateString('en-NG')}</td></tr>
      </table>
      <a href="${process.env.APP_URL}/parent/fees/${invoice.id}"
         style="background:#1a3c5e;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">
        Pay Now
      </a>
      <p style="margin-top:24px;color:#666;font-size:12px">SchoolFlow — School Management Platform</p>
    </div>
  `;

  const jobs: Promise<void>[] = [];

  if (parent?.phone) {
    jobs.push(sendSms(parent.phone, smsText).catch((e) => console.error('[SMS reminder]', e)));
  }
  if (parent?.email) {
    jobs.push(sendEmail(parent.email, `Fee Reminder — ${balance} outstanding`, emailHtml).catch((e) => console.error('[Email reminder]', e)));
  }

  await Promise.all(jobs);
}

// ── Result Published Notification ────────────────────────────

export async function notifyResultsPublished(
  parentPhone: string | null,
  parentEmail: string | null,
  parentName: string,
  studentName: string,
  schoolName: string,
  term: string
): Promise<void> {
  const message = `Dear ${parentName}, ${studentName}'s ${term} results are now available on your SchoolFlow parent portal. Log in to view the full report card.`;

  const jobs: Promise<void>[] = [];
  if (parentPhone) jobs.push(sendSms(parentPhone, message).catch(console.error));
  if (parentEmail) {
    jobs.push(
      sendEmail(
        parentEmail,
        `Results Available — ${studentName} (${term})`,
        `<div style="font-family:sans-serif;padding:24px"><p>${message}</p>
         <a href="${process.env.APP_URL}/parent/results" style="background:#1a3c5e;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:12px">View Results</a></div>`
      ).catch(console.error)
    );
  }
  await Promise.all(jobs);
}
