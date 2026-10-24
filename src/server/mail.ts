import nodemailer from 'nodemailer';
import { config, smtpConfigured } from './config.ts';

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransport() {
  if (!smtpConfigured) throw new Error('SMTP non configurato (imposta SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM).');
  transport ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    requireTLS: !config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
  return transport;
}

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export async function sendMail(opts: { to: string; subject: string; text: string; html?: string; attachments?: MailAttachment[] }) {
  const t = getTransport();
  await t.sendMail({
    from: { name: 'Ore Lavoro', address: config.smtp.from },
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    attachments: opts.attachments,
  });
}

export function htmlWrap(title: string, bodyHtml: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:auto;color:#1b2430">
<h2 style="margin:0 0 12px">${title}</h2>${bodyHtml}
<p style="color:#8a93a0;font-size:12px;margin-top:24px">Messaggio automatico di Ore Lavoro.</p></div>`;
}
