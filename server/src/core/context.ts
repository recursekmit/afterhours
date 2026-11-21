import type { StickerDefInput } from '@afterhours/shared';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Config } from '../config';
import type { Db } from './db';
import type { LiveBus } from './live/bus';
import type { PointsService } from './points/ledger';
import type { StickerService } from './points/stickers';
import type { PushService } from './push/service';

/** Everything a feature gets handed. One per process. */
export interface AppContext {
  config: Config;
  db: Db;
  /** ctx.live.publish('<feature>.<event>', payload, audience) */
  live: LiveBus;
  /** ctx.points.award({ attendeeId, source, ref, points, label }) — idempotent */
  points: PointsService;
  /** ctx.stickers.unlock(attendeeId, stickerId) — idempotent */
  stickers: StickerService;
  /** ctx.push.sendPush(audience, { title, body, url, tag }) */
  push: PushService;
  log: FastifyBaseLogger;
  /** Server clock. Use this, not Date.now(), so tests can fake time. */
  now: () => number;
}

export type FeatureContext = AppContext;

/**
 * A server feature. Lives in server/src/features/<name>/index.ts and is
 * listed once in server/src/features/registry.ts.
 */
export interface ServerFeature {
  /** Same as the folder name. kebab-case. Routes mount at /api/<name>. */
  name: string;
  /**
   * Register routes on an encapsulated Fastify instance already prefixed with
   * /api/<name>. Use the guards from core (requireAttendee, requireAdmin,
   * requireScreen) and parse() with your shared Zod schemas.
   */
  routes?: (app: FastifyInstance, ctx: FeatureContext) => void | Promise<void>;
  /** Sticker catalogue entries this feature can unlock. */
  stickers?: StickerDefInput[];
  /** Runs once after migrations, before the server listens. */
  boot?: (ctx: FeatureContext) => void | Promise<void>;
  /** Runs every `everyMs` while the server is up (no overlap; errors are logged). */
  tick?: { everyMs: number; run: (ctx: FeatureContext) => void | Promise<void> };
  /** `npm run seed`: insert believable demo data. Runs after core seed, inside no transaction. */
  seed?: (ctx: FeatureContext) => void | Promise<void>;
  /** Feature names whose seed must run before this one (e.g. attendance needs schedule's activities). */
  seedAfter?: string[];
  /**
   * "purge test player" (core/auth/purge.ts) already deleted this attendee's rows from every table with an
   * attendee_id column; drop any in-memory cache that still counts them (crowds, tallies, boards).
   */
  onPurge?: (ctx: FeatureContext, attendeeId: number) => void;
}

/** Identity helper so feature objects are type-checked where they are written. */
export function defineFeature(feature: ServerFeature): ServerFeature {
  return feature;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}
