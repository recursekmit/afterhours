import { resolve } from 'node:path';
import type { LiveEnvelope } from '@afterhours/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app';
import { type Config, loadConfig } from '../src/config';
import type { AppContext, ServerFeature } from '../src/core/context';
import { openDb } from '../src/core/db';
import type { LiveClient } from '../src/core/live/bus';
import type { PushSender } from '../src/core/push/service';
import { features as allFeatures } from '../src/features/registry';

export const SRC_ROOT = resolve(import.meta.dirname, '../src');
export const ADMIN_PIN = '9999';
export const SCREEN_PIN = '8888';
export const GATE_PIN = '7777';

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  clock: { now: () => number; advance: (ms: number) => void; set: (ms: number) => void };
  close: () => Promise<void>;
}

/**
 * A full app on an in-memory database with a fake clock and no timers.
 * Use app.inject() for requests; use a Jar per simulated browser.
 */
export async function makeApp(
  opts: { config?: Partial<Config>; features?: ServerFeature[]; pushSender?: PushSender; env?: Record<string, string> } = {},
): Promise<TestApp> {
  const config: Config = {
    ...loadConfig({ NODE_ENV: 'test', ADMIN_PIN, SCREEN_PIN, GATE_PIN, ...opts.env }),
    ...opts.config,
  };
  let t = Date.parse('2026-11-21T09:30:00Z');
  const clock = { now: () => t, advance: (ms: number) => void (t += ms), set: (ms: number) => void (t = ms) };
  const { app, ctx } = await buildApp({
    config,
    srcRoot: SRC_ROOT,
    features: opts.features ?? allFeatures,
    db: openDb(':memory:'),
    now: clock.now,
    timers: false,
    pushSender: opts.pushSender,
  });
  await app.ready();
  return {
    app,
    ctx,
    clock,
    close: async () => {
      await app.close();
      ctx.db.close();
    },
  };
}

/** A tiny cookie jar = one browser/phone. */
export class Jar {
  cookies: Record<string, string> = {};
  store(res: LightMyRequestResponse): LightMyRequestResponse {
    for (const c of res.cookies as { name: string; value: string; expires?: Date; maxAge?: number }[]) {
      const expired = (c.expires && c.expires.getTime() < Date.now() - 1000) || c.maxAge === 0 || c.value === '';
      if (expired) delete this.cookies[c.name];
      else this.cookies[c.name] = c.value;
    }
    return res;
  }
  get header(): string {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
}

export async function req(
  app: FastifyInstance,
  jar: Jar | null,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  const res = await app.inject({
    method,
    url,
    payload: payload as object | undefined,
    headers: { ...(jar ? { cookie: jar.header } : {}), ...headers },
  });
  jar?.store(res);
  return res;
}

export async function adminJar(app: FastifyInstance): Promise<Jar> {
  const jar = new Jar();
  const r = await req(app, jar, 'POST', '/api/admin/session', { pin: ADMIN_PIN });
  if (r.statusCode !== 200) throw new Error(`admin login failed: ${r.body}`);
  return jar;
}

export async function gateJar(app: FastifyInstance): Promise<Jar> {
  const jar = new Jar();
  const r = await req(app, jar, 'POST', '/api/gate/session', { pin: GATE_PIN });
  if (r.statusCode !== 200) throw new Error(`gate login failed: ${r.body}`);
  return jar;
}

export async function makeKits(app: FastifyInstance, count: number) {
  const admin = await adminJar(app);
  const r = await req(app, admin, 'POST', '/api/admin/kits', { mode: 'blank', count });
  return (r.json() as { kits: { kitId: string; password: string }[] }).kits;
}

export const AVATAR = { shape: 'blob', color: 'lime', eyes: 'wide', mouth: 'grin', top: 'cap', extra: 'none' } as const;

/** Sign a fresh phone in with a kit and finish the profile. */
export async function signedInAttendee(app: FastifyInstance, kit: { kitId: string; password: string }, nickname = 'tester') {
  const jar = new Jar();
  const r = await req(app, jar, 'POST', '/api/auth/signin', { kitId: kit.kitId, password: kit.password });
  if (r.statusCode !== 200) throw new Error(`signin failed: ${r.body}`);
  const p = await req(app, jar, 'PUT', '/api/me/profile', { name: 'Test Person', roll: '23BD1A0599', nickname, avatar: AVATAR });
  if (p.statusCode !== 200) throw new Error(`profile failed: ${p.body}`);
  const id = (p.json() as { attendee: { id: number } }).attendee.id;
  return { jar, id };
}

/** Capture everything the bus sends to a given viewer. */
export function capture(ctx: AppContext, viewer: LiveClient['viewer']) {
  const events: LiveEnvelope[] = [];
  const unsub = ctx.live.subscribe({
    viewer,
    write(frame) {
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (line && !frame.startsWith('event:')) events.push(JSON.parse(line.slice(6)) as LiveEnvelope);
      return true;
    },
    close() {},
  });
  return { events, unsub, types: () => events.map((e) => e.type) };
}
