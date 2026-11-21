import { type LivePollResponse, SSE_HELLO } from '@afterhours/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { viewerOf } from '../auth/guards';
import type { AppContext } from '../context';
import { parse } from '../validate';
import type { LiveClient } from './bus';

const SinceQuery = z.object({ since: z.coerce.number().int().nonnegative().optional() });

/** Above this many unsent bytes a client is considered stuck and dropped (it will reconnect or poll). */
const MAX_BUFFERED = 512 * 1024;

export function registerLiveRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/live', (req, reply) => {
    const viewer = viewerOf(req);
    const q = parse(SinceQuery, req.query);
    const header = req.headers['last-event-id'];
    const fromHeader = typeof header === 'string' && /^\d+$/.test(header) ? Number(header) : undefined;
    const since = fromHeader ?? q.since;

    reply.hijack();
    const res = reply.raw;
    const socket = req.raw.socket;
    socket.setTimeout(0);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    if (since !== undefined) {
      const replay = ctx.live.replayFrames(since, viewer);
      if (replay.reset) res.write(`event: reset\ndata: ${ctx.live.currentCursor}\n\n`);
      for (const f of replay.frames) res.write(f);
    }
    res.write(`event: ${SSE_HELLO}\ndata: ${JSON.stringify({ cursor: ctx.live.currentCursor })}\n\n`);

    const client: LiveClient = {
      viewer,
      write(frame) {
        if (res.destroyed || res.writableEnded) return false;
        if (res.writableLength > MAX_BUFFERED) return false;
        res.write(frame);
        return true;
      },
      close() {
        if (!res.writableEnded) res.end();
      },
    };
    const unsubscribe = ctx.live.subscribe(client);
    req.raw.on('close', unsubscribe);
  });

  app.get('/api/live/poll', async (req): Promise<LivePollResponse> => {
    const viewer = viewerOf(req);
    const { since } = parse(SinceQuery, req.query);
    ctx.live.notePoll(viewer.attendeeId !== null ? `a:${viewer.attendeeId}` : `ip:${req.ip}:${viewer.admin ? 'admin' : viewer.screen ? 'screen' : viewer.gate ? 'gate' : 'anon'}`);
    if (since === undefined) return { cursor: ctx.live.currentCursor, events: [], reset: false };
    return ctx.live.since(since, viewer);
  });
}
