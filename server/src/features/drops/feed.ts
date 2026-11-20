// The live feed: a cheerful ticker of what is happening, built from other features' live events
// (read off the bus, never by touching their code) plus drop moments.
//
// Cheap for 300 clients:
// - lines are coalesced by key ("sana, meg and 4 others found stops") inside a flush window,
// - at most one 'drops.feed' event per FLUSH_MS carrying at most MAX_PER_FLUSH lines,
// - at most MAX_PER_MIN lines a minute; low-priority lines are dropped when over budget,
// - lines that waited too long go stale and are dropped.
import type { FeedItem, FeedTone } from '@afterhours/shared/features/drops';
import type { Glyph } from '@afterhours/shared';
import { type FeatureContext, all, run } from '../../core';
import { getSettings } from './settings';

export const FEED_FLUSH_MS = 2500;
export const FEED_MAX_PER_FLUSH = 3;
export const FEED_MAX_PER_MIN = 16;
export const FEED_STALE_MS = 20_000;
export const FEED_KEEP = 30;

/** 3 always gets out (drops, golden finds), 2 usually, 1 only when there is room. */
export type Priority = 1 | 2 | 3;

export interface Line {
  /** Lines with the same key inside one window merge into one. */
  key: string;
  priority: Priority;
  tone: FeedTone;
  icon: Glyph;
  /** Static text, or built from the names that piled up under this key. */
  text: string | ((names: string[], count: number) => string);
  name?: string;
}

interface Pending {
  line: Line;
  names: string[];
  count: number;
  firstAt: number;
}

interface FeedMem {
  pending: Map<string, Pending>;
  sent: number[];
  lastFlushAt: number;
  seq: number;
  hidden: string[];
  /** Publish the muted flag even with no lines (set when an organiser flips it). */
  stateDirty: boolean;
}

const mems = new WeakMap<FeatureContext, FeedMem>();
function mem(ctx: FeatureContext): FeedMem {
  let m = mems.get(ctx);
  if (!m) {
    m = { pending: new Map(), sent: [], lastFlushAt: 0, seq: 0, hidden: [], stateDirty: false };
    mems.set(ctx, m);
  }
  return m;
}

/** Nicknames only, short. */
export function nick(s: string): string {
  const t = s.trim();
  return t.length > 20 ? `${t.slice(0, 19)}…` : t;
}

/** "sana", "sana and meg", "sana, meg and 4 others" */
export function names(list: string[], count: number): string {
  const uniq = [...new Set(list)];
  const shown = uniq.slice(0, 2);
  const others = Math.max(0, count - shown.length);
  if (others === 0) return shown.length === 2 ? `${shown[0]} and ${shown[1]}` : (shown[0] ?? 'someone');
  return `${shown.join(', ')} and ${others} other${others === 1 ? '' : 's'}`;
}

/** Queue a line. Coalesces with anything already waiting under the same key. */
export function push(ctx: FeatureContext, line: Line): void {
  if (getSettings(ctx).feedMuted) return;
  const m = mem(ctx);
  const p = m.pending.get(line.key);
  if (p) {
    p.count++;
    if (line.name && p.names.length < 5) p.names.push(line.name);
    // static text: newest wins (e.g. "the trail has 43 explorers")
    if (typeof line.text === 'string') p.line = line;
    return;
  }
  // Keep the waiting room small: drop the lowest priority, oldest first.
  if (m.pending.size >= 40) {
    const victim = [...m.pending.values()].sort((a, b) => a.line.priority - b.line.priority || a.firstAt - b.firstAt)[0];
    if (victim && victim.line.priority <= line.priority) m.pending.delete(victim.line.key);
    else return;
  }
  m.pending.set(line.key, { line, names: line.name ? [line.name] : [], count: 1, firstAt: ctx.now() });
}

function render(p: Pending): string {
  const t = p.line.text;
  return typeof t === 'string' ? t : t(p.names, p.count);
}

/**
 * Turn waiting lines into at most one 'drops.feed' event. Call from the tick; it rate-limits itself.
 * `force` skips the window (organiser lines, tests).
 */
export function flushFeed(ctx: FeatureContext, force = false): FeedItem[] {
  const m = mem(ctx);
  const now = ctx.now();
  if (!force && now - m.lastFlushAt < FEED_FLUSH_MS) return [];
  const muted = getSettings(ctx).feedMuted;
  m.sent = m.sent.filter((t) => t > now - 60_000);

  for (const [k, p] of m.pending) if (now - p.firstAt > FEED_STALE_MS && p.line.priority < 3) m.pending.delete(k);
  const ordered = [...m.pending.entries()].sort(([, a], [, b]) => b.line.priority - a.line.priority || a.firstAt - b.firstAt);
  const out: FeedItem[] = [];
  for (const [key, p] of ordered) {
    if (out.length >= FEED_MAX_PER_FLUSH) break;
    const budget = FEED_MAX_PER_MIN - m.sent.length - out.length;
    if (budget <= 0 && p.line.priority < 3) continue; // over the minute's budget: only the big moments
    if (budget <= 3 && p.line.priority === 1) continue; // keep the last few slots for things that matter
    m.pending.delete(key);
    out.push({ id: `${now.toString(36)}-${++m.seq}`, at: now, text: render(p).slice(0, 120), tone: p.line.tone, icon: p.line.icon });
  }
  if (out.length === 0 && m.hidden.length === 0 && !m.stateDirty) return [];
  m.lastFlushAt = now;
  for (const it of out) {
    m.sent.push(now);
    run(ctx.db, 'INSERT OR IGNORE INTO drops_feed (id, at, text, tone, icon) VALUES (?, ?, ?, ?, ?)', it.id, it.at, it.text, it.tone, it.icon);
  }
  if (out.length) run(ctx.db, `DELETE FROM drops_feed WHERE id NOT IN (SELECT id FROM drops_feed ORDER BY at DESC, id DESC LIMIT ${FEED_KEEP * 2})`);
  const hidden = m.hidden;
  m.hidden = [];
  m.stateDirty = false;
  ctx.live.publish('drops.feed', { items: muted ? [] : out, hidden, muted }, 'all');
  return out;
}

interface FeedRow {
  id: string;
  at: number;
  text: string;
  tone: FeedTone;
  icon: Glyph;
  hidden: number;
}

/** The last lines, newest last. Attendees and the projector never get hidden ones. */
export function recentFeed(ctx: FeatureContext, withHidden = false): (FeedItem & { hidden: boolean })[] {
  const rows = all<FeedRow>(
    ctx.db,
    `SELECT id, at, text, tone, icon, hidden FROM drops_feed ${withHidden ? '' : 'WHERE hidden = 0'} ORDER BY at DESC, id DESC LIMIT ?`,
    FEED_KEEP,
  );
  return rows.reverse().map((r) => ({ id: r.id, at: r.at, text: r.text, tone: r.tone, icon: r.icon, hidden: r.hidden === 1 }));
}

export function hideLine(ctx: FeatureContext, id: string): boolean {
  const r = run(ctx.db, 'UPDATE drops_feed SET hidden = 1 WHERE id = ? AND hidden = 0', id);
  if (r.changes === 0) return false;
  const m = mem(ctx);
  m.hidden.push(id);
  flushFeed(ctx, true);
  return true;
}

/** An organiser line: goes out right away. */
export function say(ctx: FeatureContext, text: string): void {
  const m = mem(ctx);
  m.pending.set(`say:${++m.seq}`, { line: { key: 'say', priority: 3, tone: 'note', icon: 'note', text }, names: [], count: 1, firstAt: ctx.now() });
  flushFeed(ctx, true);
}

/** The mute switch moved: tell every client now. */
export function feedStateChanged(ctx: FeatureContext): void {
  const m = mem(ctx);
  m.stateDirty = true;
  if (getSettings(ctx).feedMuted) m.pending.clear();
  flushFeed(ctx, true);
}

export function clearFeed(ctx: FeatureContext): void {
  const m = mem(ctx);
  m.pending.clear();
  m.sent = [];
  run(ctx.db, 'DELETE FROM drops_feed');
}

/** For tests and the console. */
export function pendingCount(ctx: FeatureContext): number {
  return mem(ctx).pending.size;
}
