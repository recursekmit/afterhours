import { join } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Config } from './config';
import { setPurgeHooks } from './core/auth/purge';
import { registerAuthRoutes } from './core/auth/routes';
import { purgeExpiredSessions } from './core/auth/sessions';
import type { AppContext, ServerFeature } from './core/context';
import { type Db, openDb } from './core/db';
import { errorHandler } from './core/errors';
import { LiveBus } from './core/live/bus';
import { registerLiveRoutes } from './core/live/routes';
import { type MigrationSource, runMigrations } from './core/migrate';
import { presence, registerMiscRoutes } from './core/misc-routes';
import { PointsService } from './core/points/ledger';
import { registerPointsRoutes } from './core/points/routes';
import { CORE_STICKERS, StickerService } from './core/points/stickers';
import { type PushSender, PushService } from './core/push/service';
import { registerPushRoutes } from './core/push/routes';
import { registerStatic } from './core/static';

export interface BuildOptions {
  config: Config;
  /** Directory that holds core/migrations and features/<name>/migrations (src in dev, dist in prod). */
  srcRoot: string;
  features: ServerFeature[];
  db?: Db;
  logger?: FastifyServerOptions['logger'];
  now?: () => number;
  pushSender?: PushSender;
  /** Disable timers (ticks, presence) for deterministic tests. */
  timers?: boolean;
}

export function migrationSources(srcRoot: string, features: ServerFeature[]): MigrationSource[] {
  return [
    { scope: 'core', dir: join(srcRoot, 'core', 'migrations') },
    ...features.map((f) => ({ scope: f.name, dir: join(srcRoot, 'features', f.name, 'migrations') })),
  ];
}

/** Create the context (db, services) and run migrations. Used by the app and by the seed script. */
export function createContext(opts: BuildOptions, log: FastifyInstance['log']): AppContext {
  const names = new Set<string>();
  for (const f of opts.features) {
    if (!/^[a-z][a-z0-9-]*$/.test(f.name)) throw new Error(`Feature name "${f.name}" must be kebab-case`);
    if (names.has(f.name) || f.name === 'core') throw new Error(`Duplicate feature name "${f.name}"`);
    names.add(f.name);
  }
  const now = opts.now ?? Date.now;
  const db = opts.db ?? openDb(opts.config.databasePath);
  const migrated = runMigrations(db, migrationSources(opts.srcRoot, opts.features));
  if (migrated.applied.length) log.info({ applied: migrated.applied }, 'migrations applied');
  for (const id of migrated.changed) log.warn({ id }, 'an applied migration file changed on disk; it will NOT be re-run');

  const live = new LiveBus({ now, heartbeatMs: opts.timers === false ? 0 : undefined });
  const stickers = new StickerService(db, live, now);
  stickers.register(CORE_STICKERS);
  for (const f of opts.features) if (f.stickers) stickers.register(f.stickers.map((s) => ({ ...s, feature: f.name })));
  const points = new PointsService(db, live, now);
  const push = new PushService(db, opts.config, opts.pushSender);
  return { config: opts.config, db, live, points, stickers, push, log, now };
}

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: opts.config.trustProxy,
    bodyLimit: 256 * 1024,
    // SSE streams stay open; do not let them block shutdown.
    forceCloseConnections: true,
  });
  const ctx = createContext(opts, app.log);
  app.decorate('ctx', ctx);
  app.setErrorHandler(errorHandler);
  await app.register(fastifyCookie);

  // Security headers for every response.
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    if (req.url.startsWith('/api/') && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  registerMiscRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerLiveRoutes(app, ctx);
  registerPointsRoutes(app, ctx);
  registerPushRoutes(app, ctx);

  for (const f of opts.features) {
    if (f.routes) {
      const register = f.routes;
      await app.register(async (scope) => register(scope, ctx), { prefix: `/api/${f.name}` });
    }
  }
  setPurgeHooks(ctx, opts.features.flatMap((f) => (f.onPurge ? [f.onPurge] : [])));
  for (const f of opts.features) await f.boot?.(ctx);

  if (opts.config.webDist) await registerStatic(app, opts.config.webDist);
  else app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'not_found', message: 'Nothing here.' } }));

  // Timers: feature ticks, presence broadcast, session cleanup.
  const timers: ReturnType<typeof setInterval>[] = [];
  if (opts.timers !== false) {
    app.addHook('onReady', async () => {
      for (const f of opts.features) {
        if (!f.tick) continue;
        const { everyMs, run } = f.tick;
        let busy = false;
        timers.push(
          setInterval(() => {
            if (busy) return;
            busy = true;
            Promise.resolve()
              .then(() => run(ctx))
              .catch((err: unknown) => app.log.error({ err, feature: f.name }, 'feature tick failed'))
              .finally(() => (busy = false));
          }, everyMs),
        );
      }
      let last = '';
      timers.push(
        setInterval(() => {
          const p = presence(ctx);
          const key = `${p.here}/${p.online}`;
          if (key !== last) {
            last = key;
            ctx.live.publish('presence.changed', p, 'all');
          }
        }, 3000),
      );
      timers.push(setInterval(() => purgeExpiredSessions(ctx), 10 * 60_000));
      for (const t of timers) t.unref();
    });
  }

  // preClose: end SSE streams before the HTTP server waits for connections.
  app.addHook('preClose', async () => {
    for (const t of timers) clearInterval(t);
    ctx.live.close();
    ctx.points.close();
  });
  app.addHook('onClose', async () => {
    if (!opts.db) ctx.db.close();
  });

  return { app, ctx };
}
