import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_PATH: z.string().default('data/afterhours.db'),
  /** Built web app to serve. Empty = do not serve static files (dev uses Vite). */
  WEB_DIST: z.string().default(''),
  APP_URL: z.string().url().default('http://localhost:5173'),
  EVENT_NAME: z.string().default('After Hours'),
  EVENT_DATE: z.string().default('2026-11-21'),
  ADMIN_PIN: z.string().min(4).optional(),
  SCREEN_PIN: z.string().min(4).optional(),
  GATE_PIN: z.string().min(4).optional(),
  SESSION_HOURS: z.coerce.number().min(1).max(72).default(16),
  COOKIE_SECURE: bool.optional(),
  TRUST_PROXY: bool.default(false),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:recurse@kmit.in'),
  /** Login limits. Per IP is generous because a whole college can share one NAT address. */
  LOGIN_IP_PER_MIN: z.coerce.number().int().min(1).default(60),
  LOGIN_KIT_FAILS: z.coerce.number().int().min(1).default(5),
  LOGIN_KIT_WINDOW_MIN: z.coerce.number().min(1).default(5),
});

export interface Config {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  logLevel: string;
  databasePath: string;
  webDist: string;
  appUrl: string;
  eventName: string;
  eventDate: string;
  adminPin: string;
  screenPin: string;
  gatePin: string;
  sessionHours: number;
  cookieSecure: boolean;
  trustProxy: boolean;
  vapid: { publicKey: string; privateKey: string; subject: string } | null;
  login: { ipPerMin: number; kitFails: number; kitWindowMs: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Bad environment config:\n${lines}`);
  }
  const e = parsed.data;
  const prod = e.NODE_ENV === 'production';
  if (prod && (!e.ADMIN_PIN || !e.SCREEN_PIN || !e.GATE_PIN)) {
    throw new Error('ADMIN_PIN, SCREEN_PIN and GATE_PIN must be set in production (see .env.example).');
  }
  if (e.ADMIN_PIN && e.ADMIN_PIN === e.SCREEN_PIN) {
    throw new Error('ADMIN_PIN and SCREEN_PIN must differ.');
  }
  if (e.ADMIN_PIN && e.GATE_PIN && e.ADMIN_PIN === e.GATE_PIN) {
    throw new Error('ADMIN_PIN and GATE_PIN must differ.');
  }
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databasePath: e.DATABASE_PATH,
    webDist: e.WEB_DIST,
    appUrl: e.APP_URL.replace(/\/$/, ''),
    eventName: e.EVENT_NAME,
    eventDate: e.EVENT_DATE,
    // Dev defaults so `npm run dev` works without a .env. Production refuses to boot without them.
    adminPin: e.ADMIN_PIN ?? '2468',
    screenPin: e.SCREEN_PIN ?? '1357',
    gatePin: e.GATE_PIN ?? '3579',
    sessionHours: e.SESSION_HOURS,
    cookieSecure: e.COOKIE_SECURE ?? prod,
    trustProxy: e.TRUST_PROXY,
    vapid:
      e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY
        ? { publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY, subject: e.VAPID_SUBJECT }
        : null,
    login: { ipPerMin: e.LOGIN_IP_PER_MIN, kitFails: e.LOGIN_KIT_FAILS, kitWindowMs: e.LOGIN_KIT_WINDOW_MIN * 60_000 },
  };
}
