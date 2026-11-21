// Pulse: drops' read-only window on the rest of the app.
// - Reads the live bus replay buffer (as a staff viewer) once per tick: every public event other features
//   already publish. Nothing in their folders changes and nothing subscribes as a fake client, so presence
//   counts are untouched.
// - Turns those events into feed lines, room-drop progress (reactions) and hype.
// - Reads the schedule (read-only service) for "x starts in 2 min" and "x is on now".
// Payloads are parsed with loose local schemas, so a feature changing its event shape can only make the
// feed quieter, never crash it.
import { ARCADE_GAMES } from '@afterhours/shared/features/arcade';
import type { HypeState } from '@afterhours/shared/features/drops';
import { z } from 'zod';
import { type FeatureContext, one } from '../../core';
import type { Viewer } from '../../core/live/bus';
import { trailVisible } from '../hunt/visibility';
import { buildState } from '../schedule/service';
import { names, nick, push as feed } from './feed';
import { AUTO_ROOM, scaleInput } from './library';
import { addRoom, bump, createDrop, fireDrop, liveDrop, mem as dropMem } from './service';
import { getSettings, hypeTargetOf, presentCount, sizingOf } from './settings';

const STAFF: Viewer = { attendeeId: null, admin: true, screen: true };

export const HYPE_EVERY_MS = 2000;
export const HYPE_COOLDOWN_MS = 5 * 60_000;
export const SCHEDULE_EVERY_MS = 5000;
export const CROWD_EVERY_MS = 90_000;
export const LOUD_EVERY_MS = 120_000;
/** Designed for 300 people; scaled to the room (roomSizing().loudAt). */
export const LOUD_AT = 60;

const Stamp = z.object({ trailId: z.number(), nickname: z.string(), solved: z.number() });
const Finished = z.object({ trailId: z.number(), finisher: z.object({ nickname: z.string(), rank: z.number() }) });
const Crowd = z.object({ trailId: z.number(), hunting: z.number() });
const HuntState = z.object({ trailId: z.number(), status: z.string(), title: z.string() });
const Arrivals = z.object({ names: z.array(z.string()) });
const Record_ = z.object({ game: z.string(), nickname: z.string() });
const Cleared = z.object({ nickname: z.string(), mode: z.string(), level: z.number(), firstClear: z.boolean() });
const SprintEnded = z.object({ top: z.array(z.object({ nickname: z.string() })) });
const PollLaunched = z.object({ poll: z.object({ kind: z.string(), question: z.string() }) });
const Moves = z.object({ top: z.array(z.object({ nickname: z.string(), attendeeId: z.number() })) });
const Burst = z.object({ counts: z.record(z.string(), z.number()) });

interface PulseMem {
  cursor: number | null;
  trailTitles: Map<number, string>;
  trailStatus: Map<number, string>;
  crowdAt: Map<number, { at: number; hunting: number }>;
  topId: number | null;
  loud: { at: number; n: number }[];
  lastLoudAt: number;
  lastScheduleAt: number;
  schedulePrimed: boolean;
  lastNowId: number | null;
  announced: Set<string>;
  hype: HypeState;
  lastHypeAt: number;
  lastHypeSentAt: number;
  sentLevel: number;
}

const mems = new WeakMap<FeatureContext, PulseMem>();
function mem(ctx: FeatureContext): PulseMem {
  let m = mems.get(ctx);
  if (!m) {
    const s = getSettings(ctx);
    m = {
      cursor: null,
      trailTitles: new Map(),
      trailStatus: new Map(),
      crowdAt: new Map(),
      topId: null,
      loud: [],
      lastLoudAt: 0,
      lastScheduleAt: 0,
      schedulePrimed: false,
      lastNowId: null,
      announced: new Set(),
      hype: { enabled: s.hypeEnabled, level: 0, perMin: 0, target: s.hypeTarget, onFireAt: null },
      lastHypeAt: 0,
      lastHypeSentAt: 0,
      sentLevel: -1,
    };
    mems.set(ctx, m);
  }
  return m;
}

function trailName(m: PulseMem, id: number): string {
  return m.trailTitles.get(id) ?? 'the trail';
}

/** Read everything published since the last call and react to it. */
export function pump(ctx: FeatureContext): void {
  const m = mem(ctx);
  if (m.cursor === null) {
    m.cursor = ctx.live.currentCursor;
    return;
  }
  const r = ctx.live.since(m.cursor, STAFF);
  m.cursor = r.cursor;
  if (r.reset) return; // buffer overflowed between ticks: skip, the feed is best effort
  const now = ctx.now();
  for (const env of r.events) {
    const d: unknown = env.data;
    // a trail whose event (treasure hunt or morse challenge) is hidden from players: no feed lines about it
    if (env.type.startsWith('hunt.')) {
      const id = (d as { trailId?: unknown } | null)?.trailId;
      if (typeof id !== 'number' || !trailVisible(ctx, id)) continue;
    }
    switch (env.type) {
      case 'reactions.burst': {
        const p = Burst.safeParse(d);
        if (!p.success) break;
        const n = Object.values(p.data.counts).reduce((a, b) => a + b, 0);
        if (n <= 0) break;
        const room = liveDrop(ctx);
        if (room?.kind === 'room' && room.opens_at !== null && room.closes_at !== null && env.at >= room.opens_at && env.at < room.closes_at) addRoom(ctx, room, n);
        else bump(ctx, n, env.at);
        m.loud.push({ at: env.at, n });
        break;
      }
      case 'hunt.state': {
        const p = HuntState.safeParse(d);
        if (!p.success) break;
        const before = m.trailStatus.get(p.data.trailId);
        m.trailTitles.set(p.data.trailId, p.data.title);
        m.trailStatus.set(p.data.trailId, p.data.status);
        if (p.data.status === 'open' && before !== undefined && before !== 'open') {
          feed(ctx, { key: `trail-open:${p.data.trailId}`, priority: 2, tone: 'info', icon: 'map', text: `${p.data.title} is open. go explore` });
        }
        break;
      }
      case 'hunt.stamp': {
        const p = Stamp.safeParse(d);
        if (!p.success) break;
        feed(ctx, {
          key: 'stamp',
          priority: 1,
          tone: 'info',
          icon: 'map',
          name: nick(p.data.nickname),
          text: (n, c) => (c === 1 ? `${n[0]} found stop ${p.data.solved}` : `${names(n, c)} found stops`),
        });
        break;
      }
      case 'hunt.finished': {
        const p = Finished.safeParse(d);
        if (!p.success) break;
        const f = p.data.finisher;
        feed(ctx, { key: `finish:${p.data.trailId}:${f.rank}`, priority: f.rank <= 3 ? 3 : 2, tone: 'win', icon: 'flag', text: `${nick(f.nickname)} finished ${trailName(m, p.data.trailId)}, #${f.rank}` });
        break;
      }
      case 'hunt.crowd': {
        const p = Crowd.safeParse(d);
        if (!p.success || p.data.hunting < 5) break;
        const last = m.crowdAt.get(p.data.trailId);
        if (last && (now - last.at < CROWD_EVERY_MS || last.hunting === p.data.hunting)) break;
        m.crowdAt.set(p.data.trailId, { at: now, hunting: p.data.hunting });
        feed(ctx, { key: `crowd:${p.data.trailId}`, priority: 1, tone: 'info', icon: 'map', text: `${trailName(m, p.data.trailId)} has ${p.data.hunting} explorers` });
        break;
      }
      case 'attendance.arrivals': {
        const p = Arrivals.safeParse(d);
        if (!p.success) break;
        for (const who of p.data.names.slice(0, 5)) {
          feed(ctx, { key: 'arrivals', priority: 1, tone: 'info', icon: 'check', name: nick(who), text: (n, c) => (c === 1 ? `${n[0]} just checked in` : `${names(n, c)} just checked in`) });
        }
        break;
      }
      case 'arcade.record': {
        const p = Record_.safeParse(d);
        if (!p.success) break;
        const title = (ARCADE_GAMES as Record<string, { title: string } | undefined>)[p.data.game]?.title ?? 'the arcade';
        feed(ctx, { key: `arcade:${p.data.game}`, priority: 2, tone: 'win', icon: 'crown', text: `${nick(p.data.nickname)} took #1 on ${title}` });
        break;
      }
      case 'morse.cleared': {
        const p = Cleared.safeParse(d);
        if (!p.success || !p.data.firstClear) break;
        const lvl = p.data.level;
        feed(ctx, { key: 'morse', priority: 1, tone: 'info', icon: 'wave', name: nick(p.data.nickname), text: (n, c) => (c === 1 ? `${n[0]} cleared morse ${p.data.mode} level ${lvl}` : `${names(n, c)} levelled up in morse`) });
        break;
      }
      case 'morse.sprint-ended': {
        const p = SprintEnded.safeParse(d);
        const top = p.success ? p.data.top[0] : undefined;
        if (top) feed(ctx, { key: 'sprint', priority: 2, tone: 'win', icon: 'crown', text: `${nick(top.nickname)} won the morse speed round` });
        break;
      }
      case 'polls.launched': {
        const p = PollLaunched.safeParse(d);
        if (!p.success) break;
        const q = p.data.poll.question.length > 48 ? `${p.data.poll.question.slice(0, 47)}…` : p.data.poll.question;
        feed(ctx, { key: 'poll', priority: 2, tone: 'drop', icon: 'note', text: p.data.poll.kind === 'quiz' ? 'quiz is live. phones out' : `poll is up: ${q}` });
        break;
      }
      case 'leaderboard.moves': {
        const p = Moves.safeParse(d);
        const top = p.success ? p.data.top[0] : undefined;
        if (!top) break;
        if (m.topId !== null && m.topId !== top.attendeeId) {
          feed(ctx, { key: 'top1', priority: 2, tone: 'win', icon: 'crown', text: `${nick(top.nickname)} took #1 on the board` });
        }
        m.topId = top.attendeeId;
        break;
      }
      default:
        break;
    }
  }

  // "the room is loud"
  m.loud = m.loud.filter((x) => x.at > now - 10_000);
  const loud = m.loud.reduce((a, b) => a + b.n, 0);
  if (loud >= sizingOf(ctx).loudAt && now - m.lastLoudAt > LOUD_EVERY_MS) {
    m.lastLoudAt = now;
    feed(ctx, { key: 'loud', priority: 1, tone: 'hype', icon: 'flame', text: `the room is loud: ${loud} reactions in 10s` });
  }
}

/** "x starts in 2 min", "x is on now". Rate-limits itself. */
export function scheduleLines(ctx: FeatureContext, force = false): void {
  const m = mem(ctx);
  const now = ctx.now();
  if (!force && now - m.lastScheduleAt < SCHEDULE_EVERY_MS) return;
  m.lastScheduleAt = now;
  const st = buildState(ctx);
  const next = st.activities.find((a) => a.id === st.nextId);
  const soonKey = next ? `${next.id}:${next.startAt}` : null;
  const soon = next ? next.startAt - now : Infinity;
  if (!m.schedulePrimed) {
    m.schedulePrimed = true;
    m.lastNowId = st.nowId;
    if (soonKey && soon <= 150_000) m.announced.add(soonKey);
    return;
  }
  if (st.nowId !== m.lastNowId) {
    m.lastNowId = st.nowId;
    const cur = st.activities.find((a) => a.id === st.nowId);
    if (cur) feed(ctx, { key: `now:${cur.id}`, priority: 2, tone: 'info', icon: 'flag', text: cur.kind === 'break' ? `${cur.title}. stretch, snack, hydrate` : `${cur.title} is on now` });
  }
  if (next && soonKey && soon > 0 && soon <= 150_000 && !m.announced.has(soonKey)) {
    m.announced.add(soonKey);
    const mins = Math.max(1, Math.round(soon / 60_000));
    feed(ctx, { key: `soon:${next.id}`, priority: 2, tone: 'info', icon: 'arrow', text: `${next.title} starts in ${mins} min` });
  }
}

/** Activity in the last minute: points earned (votes, check-ins, stamps, claims, runs) + reactions, taps, misses. */
export function activityPerMin(ctx: FeatureContext): number {
  const now = ctx.now();
  const ledger = one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM points_ledger WHERE at > ?', now - 60_000)?.n ?? 0;
  const fromSec = Math.floor((now - 60_000) / 1000);
  let other = 0;
  for (const [sec, n] of dropMem(ctx).buckets) if (sec > fromSec) other += n;
  return ledger + other;
}

export function hypeState(ctx: FeatureContext): HypeState {
  const m = mem(ctx);
  const s = getSettings(ctx);
  return { ...m.hype, enabled: s.hypeEnabled, target: hypeTargetOf(ctx) };
}

/** Tick: move the meter, and when it maxes out, set the room on fire (and maybe fire an everyone-wins drop). */
export function hypeStep(ctx: FeatureContext, force = false): void {
  const m = mem(ctx);
  const now = ctx.now();
  if (!force && now - m.lastHypeAt < HYPE_EVERY_MS) return;
  m.lastHypeAt = now;
  const s = getSettings(ctx);
  if (!s.hypeEnabled) {
    if (m.hype.enabled) {
      m.hype = { ...m.hype, enabled: false, level: 0 };
      ctx.live.publish('drops.hype', m.hype, 'screens');
    }
    return;
  }
  const perMin = activityPerMin(ctx);
  const target = hypeTargetOf(ctx);
  const level = Math.min(1, perMin / target);
  m.hype = { enabled: true, level, perMin, target, onFireAt: m.hype.onFireAt };

  if (level >= 1 && (m.hype.onFireAt === null || now - m.hype.onFireAt >= HYPE_COOLDOWN_MS)) {
    m.hype.onFireAt = now;
    let dropId: number | null = null;
    if (s.hypeAuto && !liveDrop(ctx)) {
      const d = createDrop(ctx, scaleInput(AUTO_ROOM, presentCount(ctx)), { library: 'auto-room' });
      dropId = fireDrop(ctx, d.id).id;
    }
    ctx.live.publish('drops.on-fire', { at: now, dropId }, 'all');
    feed(ctx, { key: 'on-fire', priority: 3, tone: 'hype', icon: 'flame', text: 'the room is on fire' });
  }

  if (Math.abs(level - m.sentLevel) >= 0.02 || now - m.lastHypeSentAt >= 10_000 || force) {
    m.sentLevel = level;
    m.lastHypeSentAt = now;
    ctx.live.publish('drops.hype', m.hype, 'screens');
  }
}

/** For tests: forget the cursor (start reading from now). */
export function resetPulse(ctx: FeatureContext): void {
  mems.delete(ctx);
  // the drops' own memory keeps the hype buckets; clear them too
  dropMem(ctx).buckets.clear();
}
