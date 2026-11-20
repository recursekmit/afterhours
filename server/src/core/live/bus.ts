import {
  type Audience,
  type LiveEnvelope,
  type LiveEventType,
  type LiveEvents,
  LIVE_HEARTBEAT_MS,
  SSE_HEARTBEAT,
} from '@afterhours/shared';

/** Who is on the other end of a connection or poll. */
export interface Viewer {
  attendeeId: number | null;
  admin: boolean;
  screen: boolean;
  gate?: boolean;
}

export const anonymousViewer: Viewer = { attendeeId: null, admin: false, screen: false, gate: false };

export interface LiveClient {
  viewer: Viewer;
  /** Write a pre-serialised SSE frame. Return false if the client should be dropped. */
  write(frame: string): boolean;
  close(): void;
}

interface Stored {
  env: LiveEnvelope;
  audiences: Audience[];
  frame: string;
}

export function matchesAudience(audiences: Audience[], v: Viewer): boolean {
  for (const a of audiences) {
    if (a === 'all') return true;
    if (a === 'attendees' && v.attendeeId !== null) return true;
    if (a === 'admins' && v.admin) return true;
    if (a === 'screens' && (v.screen || v.admin)) return true;
    if (a === 'gates' && (v.gate || v.admin)) return true;
    if (typeof a === 'object' && v.attendeeId !== null && a.attendeeId === v.attendeeId) return true;
  }
  return false;
}

export interface LiveBusOptions {
  bufferSize?: number;
  heartbeatMs?: number;
  now?: () => number;
}

export interface SinceResult {
  cursor: number;
  events: LiveEnvelope[];
  reset: boolean;
}

/**
 * One in-process event bus. Every publish gets the next cursor, is kept in a
 * bounded replay buffer, and is written once-serialised to every matching
 * SSE client. Pollers read the same buffer via since().
 */
export class LiveBus {
  private cursor: number;
  /** First cursor issued by this process; anything below it is from a previous boot. */
  readonly bootCursor: number;
  private readonly buffer: Stored[] = [];
  private readonly bufferSize: number;
  private readonly clients = new Set<LiveClient>();
  private readonly now: () => number;
  private readonly heartbeatMs: number;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /** viewer key -> last poll time, to count polling phones as online */
  private readonly pollers = new Map<string, number>();

  constructor(opts: LiveBusOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.bufferSize = opts.bufferSize ?? 2000;
    this.heartbeatMs = opts.heartbeatMs ?? LIVE_HEARTBEAT_MS;
    // Seed from wall-clock ms so cursors keep rising across restarts.
    this.cursor = this.now();
    this.bootCursor = this.cursor + 1;
  }

  get currentCursor(): number {
    return this.cursor;
  }

  /**
   * Publish a typed event. `audience` defaults to everyone.
   *   ctx.live.publish('reactions.burst', { counts }, 'all')
   *   ctx.live.publish('points.awarded', {...}, { attendeeId })
   */
  publish<K extends LiveEventType>(type: K, data: LiveEvents[K], audience: Audience | Audience[] = 'all'): LiveEnvelope<K> {
    const env: LiveEnvelope<K> = { cursor: ++this.cursor, type, at: this.now(), data };
    const audiences = Array.isArray(audience) ? audience : [audience];
    const frame = `id: ${env.cursor}\ndata: ${JSON.stringify(env)}\n\n`;
    this.buffer.push({ env, audiences, frame });
    if (this.buffer.length > this.bufferSize) this.buffer.splice(0, this.buffer.length - this.bufferSize);
    for (const c of this.clients) {
      if (matchesAudience(audiences, c.viewer)) this.send(c, frame);
    }
    return env;
  }

  /** Events after `since` that this viewer may see. reset=true if we cannot prove nothing was missed. */
  since(since: number, viewer: Viewer): SinceResult {
    const oldest = this.buffer[0]?.env.cursor ?? this.cursor + 1;
    const fromAnotherBoot = since < this.bootCursor - 1;
    const tooOld = since < oldest - 1;
    const fromFuture = since > this.cursor;
    if (fromAnotherBoot || tooOld || fromFuture) {
      return { cursor: this.cursor, events: [], reset: true };
    }
    const events: LiveEnvelope[] = [];
    // Buffer is sorted by cursor; walk from the end for the common "recent" case.
    let i = this.buffer.length - 1;
    while (i >= 0 && (this.buffer[i]?.env.cursor ?? 0) > since) i--;
    for (let j = i + 1; j < this.buffer.length; j++) {
      const s = this.buffer[j];
      if (s && matchesAudience(s.audiences, viewer)) events.push(s.env);
    }
    return { cursor: this.cursor, events, reset: false };
  }

  /** Frames to replay to a new SSE client. */
  replayFrames(since: number, viewer: Viewer): { frames: string[]; reset: boolean } {
    const r = this.since(since, viewer);
    if (r.reset) return { frames: [], reset: true };
    const frames: string[] = [];
    for (const s of this.buffer) {
      if (s.env.cursor > since && matchesAudience(s.audiences, viewer)) frames.push(s.frame);
    }
    return { frames, reset: false };
  }

  subscribe(client: LiveClient): () => void {
    this.clients.add(client);
    this.ensureHeartbeat();
    return () => {
      this.clients.delete(client);
    };
  }

  notePoll(key: string): void {
    this.pollers.set(key, this.now());
  }

  /** Open SSE streams plus phones that polled in the last 10 s. */
  onlineCount(): number {
    const cutoff = this.now() - 10_000;
    for (const [k, t] of this.pollers) if (t < cutoff) this.pollers.delete(k);
    return this.clients.size + this.pollers.size;
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  private send(c: LiveClient, frame: string) {
    let ok: boolean;
    try {
      ok = c.write(frame);
    } catch {
      ok = false;
    }
    if (!ok) {
      this.clients.delete(c);
      try {
        c.close();
      } catch {
        /* already gone */
      }
    }
  }

  private ensureHeartbeat() {
    if (this.heartbeat || this.heartbeatMs <= 0) return;
    this.heartbeat = setInterval(() => {
      if (this.clients.size === 0) return;
      const frame = `event: ${SSE_HEARTBEAT}\ndata: ${this.cursor}\n\n`;
      for (const c of this.clients) this.send(c, frame);
    }, this.heartbeatMs);
    this.heartbeat.unref();
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const c of this.clients) {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}
