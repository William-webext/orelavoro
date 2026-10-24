import path from 'node:path';

const env = process.env;

function int(name: string, fallback: number): number {
  const v = Number(env[name]);
  return Number.isFinite(v) && env[name] !== undefined && env[name] !== '' ? v : fallback;
}

export const config = {
  port: int('PORT', 3000),
  dataDir: path.resolve(env.DATA_DIR ?? './data'),
  /** Fuso orario per "Timbra ora", report e promemoria. */
  tz: env.APP_TZ || 'Europe/Lisbon',
  /** URL pubblico, usato nei link delle mail. */
  appUrl: (env.APP_URL ?? '').replace(/\/$/, ''),
  /** auto = cookie Secure solo se la richiesta arriva via HTTPS (tunnel Cloudflare). */
  cookieSecure: (env.COOKIE_SECURE ?? 'auto') as 'auto' | 'true' | 'false',
  sessionDays: int('SESSION_DAYS', 60),
  /** Oltre queste ore un ingresso senza uscita è considerato dimenticato. */
  maxShiftHours: int('MAX_SHIFT_HOURS', 12),
  maxDayHours: int('MAX_DAY_HOURS', 14),
  loginMaxFailures: int('LOGIN_MAX_FAILURES', 5),
  loginLockMinutes: int('LOGIN_LOCK_MINUTES', 15),
  backupKeep: int('BACKUP_KEEP', 14),
  superadmin: {
    username: (env.SUPERADMIN_USER ?? '').trim().toLowerCase(),
    pin: (env.SUPERADMIN_PIN ?? '').trim(),
    name: env.SUPERADMIN_NAME ?? 'Amministratore',
    email: env.SUPERADMIN_EMAIL ?? '',
  },
  smtp: {
    host: env.SMTP_HOST ?? '',
    port: int('SMTP_PORT', 587),
    user: env.SMTP_USER ?? '',
    pass: env.SMTP_PASS ?? '',
    from: env.SMTP_FROM || env.SMTP_USER || '',
    /** true = TLS implicito (porta 465); false = STARTTLS (587). */
    secure: (env.SMTP_SECURE ?? 'false') === 'true',
  },
};

export const smtpConfigured = Boolean(config.smtp.host && config.smtp.user && config.smtp.pass && config.smtp.from);
