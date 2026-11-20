// Drops: lifecycle (draft -> scheduled -> live -> closed), claims, room taps, tallies and payouts.
// Everything is decided on the server clock. One live drop at a time.
import {
  type AdminDrop,
  type Challenge,
  type ClaimResponse,
  DROP_ATTEMPTS,
  DROP_LEAD_MS,
  DROP_RESULT_HOLD_MS,
  DROP_TEASE_MS,
  type DropConfig,
  DropConfigSchema,
  type DropInput,
  type DropKind,
  type DropStatus,
  type DropTally,
  type DropWinner,
  type MyClaim,
  type PublicDrop,
  normaliseAnswer,
  speedPoints,
} from '@afterhours/shared/features/drops';
import { wordToPatterns } from '@afterhours/shared/features/morse';
import { type FeatureContext, HttpError, all, conflict, notFound, one, run, tx } from '../../core';
import { parseAvatar } from '../../core/points/ledger';
import { nick, push as feed } from './feed';

export const SOURCE = 'drops';
/** Podium size for speed questions ("won" vs "bonus"). */
export const SPEED_PODIUM = 3;
/** Minimum gap between two tally broadcasts. */
export const TALLY_MS = 600;

export interface DropRow {
  id: number;
  kind: DropKind;
  title: string;
  blurb: string;
  duration_sec: number;
  config: string;
  status: DropStatus;
  library: string | null;
  fire_at: number | null;
  fired_at: number | null;
  opens_at: number | null;
  closes_at: number | null;
  closed_at: number | null;
  count: number;
  achieved: number | null;
  created_at: number;
}

interface ClaimRow {
  correct: number;
  rank: number | null;
  points: number;
  attempts: number;
}

interface Mem {
  /** room: count for the live drop, flushed to the db by the tick */
  room: { dropId: number; count: number; saved: number } | null;
  tallyDirty: boolean;
  lastTallyAt: number;
  /** per-second buckets of "things that happened" that do not land in the points ledger (taps, reactions, misses) */
  buckets: Map<number, number>;
}

const mems = new WeakMap<FeatureContext, Mem>();
export function mem(ctx: FeatureContext): Mem {
  let m = mems.get(ctx);
  if (!m) {
    m = { room: null, tallyDirty: false, lastTallyAt: 0, buckets: new Map() };
    mems.set(ctx, m);
  }
  return m;
}

/** Count n things that happened now, for the hype meter. */
export function bump(ctx: FeatureContext, n = 1, at = ctx.now()): void {
  const m = mem(ctx);
  const sec = Math.floor(at / 1000);
  m.buckets.set(sec, (m.buckets.get(sec) ?? 0) + n);
  if (m.buckets.size > 90) for (const k of m.buckets.keys()) if (k < sec - 70) m.buckets.delete(k);
}

const COLS = 'id, kind, title, blurb, duration_sec, config, status, library, fire_at, fired_at, opens_at, closes_at, closed_at, count, achieved, created_at';

export function getDrop(ctx: FeatureContext, id: number): DropRow | undefined {
  return one<DropRow>(ctx.db, `SELECT ${COLS} FROM drops_drops WHERE id = ?`, id);
}

export function liveDrop(ctx: FeatureContext): DropRow | undefined {
  return one<DropRow>(ctx.db, `SELECT ${COLS} FROM drops_drops WHERE status = 'live'`);
}

/** Live, or closed/cancelled in the last DROP_RESULT_HOLD_MS. */
export function currentDrop(ctx: FeatureContext): DropRow | undefined {
  return (
    liveDrop(ctx) ??
    one<DropRow>(
      ctx.db,
      `SELECT ${COLS} FROM drops_drops WHERE status IN ('closed', 'cancelled') AND closed_at >= ? ORDER BY closed_at DESC, id DESC LIMIT 1`,
      ctx.now() - DROP_RESULT_HOLD_MS,
    )
  );
}

export function nextTeaseAt(ctx: FeatureContext): number | null {
  const now = ctx.now();
  const r = one<{ at: number | null }>(ctx.db, "SELECT MIN(fire_at) AS at FROM drops_drops WHERE status = 'scheduled' AND fire_at >= ?", now - 5000);
  return r?.at != null && r.at - now <= DROP_TEASE_MS ? Math.max(r.at, now) : null;
}

export function configOf(row: DropRow): DropConfig {
  return DropConfigSchema.parse(JSON.parse(row.config));
}

function points(cfg: DropConfig): { top: number; rest: number } {
  switch (cfg.kind) {
    case 'code':
      return { top: cfg.winPoints, rest: cfg.restPoints };
    case 'speed':
      return { top: cfg.topPoints, rest: cfg.floorPoints };
    case 'golden':
      return { top: cfg.bonus, rest: 0 };
    case 'room':
      return { top: cfg.points, rest: 0 };
  }
}

function revealOf(cfg: DropConfig): string {
  switch (cfg.kind) {
    case 'code':
      return cfg.code;
    case 'speed':
      return cfg.choices.length ? (cfg.choices[cfg.correct ?? 0] ?? '') : (cfg.answers[0] ?? '');
    case 'golden':
      return cfg.token;
    case 'room':
      return '';
  }
}

/** What phones and the projector may see. No secret until the drop is over. */
export function toPublic(row: DropRow, cfg = configOf(row)): PublicDrop {
  const over = row.status === 'closed';
  const p = points(cfg);
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    blurb: row.blurb,
    status: row.status,
    firedAt: row.fired_at,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    closedAt: row.closed_at,
    slots: cfg.kind === 'code' ? cfg.winners : cfg.kind === 'golden' || cfg.kind === 'speed' ? 1 : null,
    question: cfg.kind === 'speed' ? cfg.question : null,
    choices: cfg.kind === 'speed' ? (cfg.choices.length ? cfg.choices : null) : null,
    hint: cfg.kind === 'golden' ? cfg.hint || null : null,
    goal: cfg.kind === 'room' ? cfg.goal : null,
    display: cfg.kind === 'code' ? cfg.display : null,
    topPoints: p.top,
    restPoints: p.rest,
    reveal: over && cfg.kind !== 'room' ? revealOf(cfg) : null,
    achieved: row.achieved === null ? null : row.achieved === 1,
  };
}

/** The projector's view of a code drop's challenge (that IS the drop: the room reads it off the big screen). */
export function challengeOf(row: DropRow, cfg = configOf(row)): Challenge | null {
  if (cfg.kind !== 'code' || row.status !== 'live') return null;
  return cfg.display === 'morse' ? { display: 'morse', patterns: wordToPatterns(cfg.code) } : { display: 'plain', text: cfg.code };
}

export function toAdmin(ctx: FeatureContext, row: DropRow): AdminDrop {
  const cfg = configOf(row);
  const c = one<{ claimed: number; players: number }>(
    ctx.db,
    'SELECT COALESCE(SUM(correct), 0) AS claimed, COUNT(*) AS players FROM drops_claims WHERE drop_id = ?',
    row.id,
  ) ?? { claimed: 0, players: 0 };
  const m = mem(ctx);
  return {
    ...toPublic(row, cfg),
    config: cfg,
    durationSec: row.duration_sec,
    fireAt: row.fire_at,
    createdAt: row.created_at,
    claimed: c.claimed,
    players: c.players,
    count: m.room?.dropId === row.id ? m.room.count : row.count,
    library: row.library,
  };
}

export function tallyOf(ctx: FeatureContext, row: DropRow, cfg = configOf(row)): DropTally {
  const c = one<{ claimed: number; players: number }>(
    ctx.db,
    'SELECT COALESCE(SUM(correct), 0) AS claimed, COUNT(*) AS players FROM drops_claims WHERE drop_id = ?',
    row.id,
  ) ?? { claimed: 0, players: 0 };
  const winners = all<{ rank: number; points: number; at: number; nickname: string | null; avatar: string | null }>(
    ctx.db,
    `SELECT c.rank, c.points, c.at, a.nickname, a.avatar FROM drops_claims c JOIN attendees a ON a.id = c.attendee_id
      WHERE c.drop_id = ? AND c.rank IS NOT NULL ORDER BY c.rank LIMIT 8`,
    row.id,
  ).map<DropWinner>((w) => ({ rank: w.rank, points: w.points, at: w.at, nickname: nick(w.nickname ?? 'someone'), avatar: parseAvatar(w.avatar) }));
  const m = mem(ctx);
  return {
    dropId: row.id,
    claimed: c.claimed,
    slots: cfg.kind === 'code' ? cfg.winners : cfg.kind === 'room' ? null : 1,
    count: m.room?.dropId === row.id ? m.room.count : row.count,
    goal: cfg.kind === 'room' ? cfg.goal : null,
    players: c.players,
    winners,
  };
}

// ---- organiser actions ---------------------------------------------------------

export function createDrop(ctx: FeatureContext, input: DropInput, opts: { fireAt?: number | null; library?: string | null } = {}): DropRow {
  const now = ctx.now();
  const fireAt = opts.fireAt ?? null;
  const status: DropStatus = fireAt !== null ? 'scheduled' : 'draft';
  const r = run(
    ctx.db,
    'INSERT INTO drops_drops (kind, title, blurb, duration_sec, config, status, library, fire_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    input.config.kind,
    input.title,
    input.blurb,
    input.durationSec,
    JSON.stringify(input.config),
    status,
    opts.library ?? null,
    fireAt,
    now,
  );
  changed(ctx);
  return getDrop(ctx, r.lastId) as DropRow;
}

export function scheduleDrop(ctx: FeatureContext, id: number, at: number): DropRow {
  const row = getDrop(ctx, id);
  if (!row) throw notFound('No such drop.');
  if (row.status !== 'draft' && row.status !== 'scheduled') throw conflict('Only drafts and scheduled drops can be (re)scheduled.');
  run(ctx.db, "UPDATE drops_drops SET status = 'scheduled', fire_at = ? WHERE id = ?", at, id);
  changed(ctx);
  return getDrop(ctx, id) as DropRow;
}

function changed(ctx: FeatureContext): void {
  ctx.live.publish('drops.changed', { at: ctx.now() }, 'all');
}

/** Fire a draft or scheduled drop now: siren, push, takeover. */
export function fireDrop(ctx: FeatureContext, id: number): DropRow {
  const row = getDrop(ctx, id);
  if (!row) throw notFound('No such drop.');
  if (row.status === 'live') return row;
  if (row.status !== 'draft' && row.status !== 'scheduled') throw conflict('That drop already happened. Make a new one.');
  if (liveDrop(ctx)) throw conflict('One drop at a time. Wait for the live one or cancel it.');
  const now = ctx.now();
  const opensAt = now + DROP_LEAD_MS;
  const closesAt = opensAt + row.duration_sec * 1000;
  run(ctx.db, "UPDATE drops_drops SET status = 'live', fired_at = ?, opens_at = ?, closes_at = ?, count = 0 WHERE id = ?", now, opensAt, closesAt, id);
  const live = getDrop(ctx, id) as DropRow;
  const cfg = configOf(live);
  const m = mem(ctx);
  m.room = cfg.kind === 'room' ? { dropId: id, count: 0, saved: 0 } : null;
  m.tallyDirty = true;

  ctx.live.publish('drops.live', { drop: toPublic(live, cfg) }, 'all');
  ctx.live.publish('drops.challenge', { dropId: id, challenge: challengeOf(live, cfg) }, 'screens');
  changed(ctx);

  const secs = row.duration_sec;
  const window = secs >= 120 ? `${Math.round(secs / 60)} min` : `${secs}s`;
  const headline = cfg.kind === 'golden' ? 'golden slip loose!' : cfg.kind === 'room' ? `everyone wins? ${window}` : `drop live! ${window}`;
  void ctx.push
    .sendPush('all', { title: headline.slice(0, 80), body: row.title.slice(0, 200), url: '/drops', tag: 'drops' })
    .catch((err: unknown) => ctx.log.warn({ err }, 'drop push failed'));

  const label = cfg.kind === 'golden' ? 'a golden slip is hidden somewhere in the venue' : cfg.kind === 'room' ? `${row.title}: ${cfg.goal} reactions, go` : `drop live! ${row.title}`;
  feed(ctx, { key: `drop:${id}:live`, priority: 3, tone: 'drop', icon: cfg.kind === 'golden' ? 'star' : 'bolt', text: label });
  return live;
}

/** End the drop: reveal, room payouts, 'drops.closed'. Idempotent. */
export function closeDrop(ctx: FeatureContext, id: number, reason: 'time' | 'found' | 'goal' | 'cancel'): DropRow | undefined {
  const row = getDrop(ctx, id);
  if (!row || row.status !== 'live') return row;
  const cfg = configOf(row);
  const m = mem(ctx);
  const count = m.room?.dropId === id ? m.room.count : row.count;
  const achieved = cfg.kind === 'room' && reason !== 'cancel' ? (count >= cfg.goal ? 1 : 0) : null;
  const now = ctx.now();
  run(
    ctx.db,
    'UPDATE drops_drops SET status = ?, closed_at = ?, count = ?, achieved = ? WHERE id = ?',
    reason === 'cancel' ? 'cancelled' : 'closed',
    now,
    count,
    achieved,
    id,
  );
  if (m.room?.dropId === id) m.room = null;

  if (cfg.kind === 'room' && achieved === 1) {
    const everyone = all<{ id: number }>(ctx.db, 'SELECT id FROM attendees WHERE profile_complete = 1');
    tx(ctx.db, () => {
      for (const a of everyone) ctx.points.award({ attendeeId: a.id, source: SOURCE, ref: `drop:${id}`, points: cfg.points, label: `the room did it: ${row.title}` });
    });
    feed(ctx, { key: `drop:${id}:room`, priority: 3, tone: 'hype', icon: 'flame', text: `the room did it! everyone +${cfg.points}` });
  } else if (cfg.kind === 'room' && achieved === 0) {
    feed(ctx, { key: `drop:${id}:room`, priority: 2, tone: 'info', icon: 'ghost', text: `so close. ${count}/${cfg.goal}, next time` });
  } else if (cfg.kind === 'golden' && reason === 'time') {
    feed(ctx, { key: `drop:${id}:gold`, priority: 2, tone: 'info', icon: 'ghost', text: 'nobody found the golden slip. it is still out there' });
  } else if (cfg.kind === 'code' && reason === 'time') {
    const c = one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM drops_claims WHERE drop_id = ? AND correct = 1', id)?.n ?? 0;
    if (c > 0) feed(ctx, { key: `drop:${id}:done`, priority: 1, tone: 'info', icon: 'check', text: `${c} cracked ${cfg.code}` });
  }

  const closed = getDrop(ctx, id) as DropRow;
  m.tallyDirty = false;
  ctx.live.publish('drops.closed', { drop: toPublic(closed, cfg), tally: tallyOf(ctx, closed, cfg) }, 'all');
  changed(ctx);
  return closed;
}

export function cancelDrop(ctx: FeatureContext, id: number): DropRow {
  const row = getDrop(ctx, id);
  if (!row) throw notFound('No such drop.');
  if (row.status === 'live') return closeDrop(ctx, id, 'cancel') as DropRow;
  if (row.status === 'draft' || row.status === 'scheduled') {
    run(ctx.db, "UPDATE drops_drops SET status = 'cancelled', closed_at = ? WHERE id = ?", ctx.now(), id);
    changed(ctx);
    return getDrop(ctx, id) as DropRow;
  }
  throw conflict('That drop is already over.');
}

export function deleteDrop(ctx: FeatureContext, id: number): void {
  const row = getDrop(ctx, id);
  if (!row) throw notFound('No such drop.');
  if (row.status === 'live') throw conflict('Cancel it first, it is live.');
  // Claims stay as history in the points ledger; the drop and its claim rows go.
  run(ctx.db, 'DELETE FROM drops_claims WHERE drop_id = ?', id);
  run(ctx.db, 'DELETE FROM drops_drops WHERE id = ?', id);
  changed(ctx);
}

/**
 * Fire what is due and close what ran out. Called by the tick and by every read, so the
 * server clock decides even if a tick is late.
 */
export function settle(ctx: FeatureContext): void {
  const now = ctx.now();
  const live = liveDrop(ctx);
  if (live && live.closes_at !== null && now >= live.closes_at) closeDrop(ctx, live.id, 'time');
  if (!liveDrop(ctx)) {
    const due = one<{ id: number }>(ctx.db, "SELECT id FROM drops_drops WHERE status = 'scheduled' AND fire_at <= ? ORDER BY fire_at, id LIMIT 1", now);
    if (due) fireDrop(ctx, due.id);
  }
}

// ---- attendees ------------------------------------------------------------------

function maxAttempts(cfg: DropConfig): number {
  if (cfg.kind === 'speed' && cfg.choices.length > 0) return 1;
  return DROP_ATTEMPTS[cfg.kind];
}

function isRight(cfg: DropConfig, answer: string): boolean {
  const a = normaliseAnswer(answer);
  switch (cfg.kind) {
    case 'code':
      return a === cfg.code;
    case 'golden':
      return a === cfg.token;
    case 'speed':
      if (cfg.choices.length) return /^\d$/.test(answer.trim()) && Number(answer.trim()) === cfg.correct;
      return a.length > 0 && cfg.answers.some((x) => normaliseAnswer(x) === a);
    case 'room':
      return false;
  }
}

function outcomeOf(cfg: DropConfig, c: ClaimRow): MyClaim {
  const max = maxAttempts(cfg);
  if (c.correct === 1) {
    const rank = c.rank ?? 0;
    const won = cfg.kind === 'code' ? rank <= cfg.winners : cfg.kind === 'speed' ? rank <= SPEED_PODIUM : true;
    return { outcome: won ? 'won' : 'bonus', rank: c.rank, points: c.points, attemptsLeft: 0 };
  }
  const left = Math.max(0, max - c.attempts);
  return { outcome: left === 0 ? 'out' : 'wrong', rank: null, points: 0, attemptsLeft: left };
}

export function myClaim(ctx: FeatureContext, row: DropRow, attendeeId: number): MyClaim | null {
  const c = one<ClaimRow>(ctx.db, 'SELECT correct, rank, points, attempts FROM drops_claims WHERE drop_id = ? AND attendee_id = ?', row.id, attendeeId);
  return c ? outcomeOf(configOf(row), c) : null;
}

const MESSAGES: Record<MyClaim['outcome'], (c: MyClaim) => string> = {
  won: (c) => (c.rank === 1 ? `first! +${c.points}` : `#${c.rank}, +${c.points}`),
  bonus: (c) => `got it, +${c.points}. the top spots went fast`,
  wrong: (c) => `not it. ${c.attemptsLeft} ${c.attemptsLeft === 1 ? 'try' : 'tries'} left`,
  out: () => 'out of tries on this one',
  too_slow: () => 'too slow! it is gone',
  already: () => 'you already got this one',
};

function reply(c: MyClaim): ClaimResponse {
  return { ...c, message: MESSAGES[c.outcome](c) };
}

function nicknameOf(ctx: FeatureContext, attendeeId: number): string {
  return nick(one<{ nickname: string | null }>(ctx.db, 'SELECT nickname FROM attendees WHERE id = ?', attendeeId)?.nickname ?? 'someone');
}

/**
 * One claim. Synchronous from the first read to the last write, so claims that arrive at the
 * same moment are ranked strictly in arrival order (one Node process, one SQLite connection).
 */
export function claim(ctx: FeatureContext, id: number, attendeeId: number, answer: string): ClaimResponse {
  settle(ctx);
  const row = getDrop(ctx, id);
  if (!row || row.status === 'draft' || row.status === 'scheduled') throw notFound('No such drop.');
  if (row.kind === 'room') throw new HttpError(400, 'bad_request', 'Tap the big button for this one.');
  const cfg = configOf(row);
  const now = ctx.now();
  const existing = one<ClaimRow>(ctx.db, 'SELECT correct, rank, points, attempts FROM drops_claims WHERE drop_id = ? AND attendee_id = ?', id, attendeeId);
  if (existing?.correct === 1) return reply({ ...outcomeOf(cfg, existing), outcome: 'already' });
  if (row.status === 'cancelled') return reply({ outcome: 'too_slow', rank: null, points: 0, attemptsLeft: 0 });
  if (row.status === 'live' && row.opens_at !== null && now < row.opens_at) throw conflict('Hold on, it opens in a second.');
  if (row.status !== 'live' || (row.closes_at !== null && now >= row.closes_at)) {
    return reply({ outcome: 'too_slow', rank: null, points: 0, attemptsLeft: 0 });
  }
  const max = maxAttempts(cfg);
  const attempts = existing?.attempts ?? 0;
  if (attempts >= max) return reply(outcomeOf(cfg, existing as ClaimRow));

  if (!isRight(cfg, answer)) {
    run(
      ctx.db,
      `INSERT INTO drops_claims (drop_id, attendee_id, correct, attempts, at) VALUES (?, ?, 0, 1, ?)
       ON CONFLICT(drop_id, attendee_id) DO UPDATE SET attempts = attempts + 1, at = excluded.at`,
      id,
      attendeeId,
      now,
    );
    bump(ctx);
    mem(ctx).tallyDirty = true;
    return reply(outcomeOf(cfg, { correct: 0, rank: null, points: 0, attempts: attempts + 1 }));
  }

  const rank = (one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM drops_claims WHERE drop_id = ? AND correct = 1', id)?.n ?? 0) + 1;
  if (cfg.kind === 'golden' && rank > 1) return reply({ outcome: 'too_slow', rank: null, points: 0, attemptsLeft: 0 });
  const pts = cfg.kind === 'code' ? (rank <= cfg.winners ? cfg.winPoints : cfg.restPoints) : cfg.kind === 'speed' ? speedPoints(rank, cfg.topPoints, cfg.floorPoints) : cfg.kind === 'golden' ? cfg.bonus : 0;
  const result: ClaimRow = { correct: 1, rank, points: pts, attempts: attempts + 1 };
  const out = outcomeOf(cfg, result);
  tx(ctx.db, () => {
    run(
      ctx.db,
      `INSERT INTO drops_claims (drop_id, attendee_id, correct, rank, points, attempts, at) VALUES (?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(drop_id, attendee_id) DO UPDATE SET correct = 1, rank = excluded.rank, points = excluded.points, attempts = excluded.attempts, at = excluded.at`,
      id,
      attendeeId,
      rank,
      pts,
      attempts + 1,
      now,
    );
    if (pts > 0) {
      const label = cfg.kind === 'golden' ? 'found the golden slip' : out.outcome === 'won' ? `drop #${rank}: ${row.title}` : `caught the drop: ${row.title}`;
      ctx.points.award({ attendeeId, source: SOURCE, ref: `drop:${id}`, points: pts, label: label.slice(0, 80) });
    }
    if (cfg.kind === 'golden') ctx.stickers.unlock(attendeeId, 'drops-golden');
    else if (out.outcome === 'won') ctx.stickers.unlock(attendeeId, 'drops-quickdraw');
  });
  mem(ctx).tallyDirty = true;

  if (rank === 1) {
    const who = nicknameOf(ctx, attendeeId);
    const text = cfg.kind === 'golden' ? `golden slip found by ${who}!` : cfg.kind === 'speed' ? `${who} answered first` : `${who} cracked the code first`;
    feed(ctx, { key: `drop:${id}:first`, priority: 3, tone: 'win', icon: cfg.kind === 'golden' ? 'crown' : 'bolt', text });
  }
  if (cfg.kind === 'code' && rank === cfg.winners && row.fired_at !== null) {
    const secs = Math.max(1, Math.round((now - (row.opens_at ?? now)) / 1000));
    feed(ctx, { key: `drop:${id}:full`, priority: 2, tone: 'drop', icon: 'spark', text: `all ${cfg.winners} spots gone in ${secs}s` });
  }
  if (cfg.kind === 'golden') closeDrop(ctx, id, 'found');
  return reply(out);
}

/** Taps on the room drop's button. Returns the new count; closes the drop when the goal is hit. */
export function tap(ctx: FeatureContext, id: number, n: number): number {
  const row = liveDrop(ctx);
  if (!row || row.id !== id || row.kind !== 'room') throw conflict('That drop is not live.');
  const now = ctx.now();
  if (row.opens_at !== null && now < row.opens_at) return roomCount(ctx);
  if (row.closes_at !== null && now >= row.closes_at) {
    settle(ctx);
    return row.count;
  }
  return addRoom(ctx, row, n);
}

/** The live room drop's count right now (memory is ahead of the db between ticks). */
export function roomCount(ctx: FeatureContext): number {
  const m = mem(ctx);
  return m.room?.count ?? liveDrop(ctx)?.count ?? 0;
}

/** Add to the live room drop's count (taps, or reactions seen on the bus). */
export function addRoom(ctx: FeatureContext, row: DropRow, n: number): number {
  const m = mem(ctx);
  if (!m.room || m.room.dropId !== row.id) m.room = { dropId: row.id, count: row.count, saved: row.count };
  m.room.count += n;
  m.tallyDirty = true;
  bump(ctx, n);
  const cfg = configOf(row);
  if (cfg.kind === 'room' && m.room.count >= cfg.goal) {
    const count = m.room.count;
    closeDrop(ctx, row.id, 'goal');
    return count;
  }
  return m.room.count;
}

/** Tick: send the tally if it moved (coalesced), and persist the room count. */
export function flushTally(ctx: FeatureContext, force = false): void {
  const m = mem(ctx);
  const now = ctx.now();
  if (m.room && m.room.count !== m.room.saved) {
    run(ctx.db, "UPDATE drops_drops SET count = ? WHERE id = ? AND status = 'live'", m.room.count, m.room.dropId);
    m.room.saved = m.room.count;
  }
  if (!m.tallyDirty || (!force && now - m.lastTallyAt < TALLY_MS)) return;
  const row = liveDrop(ctx);
  m.tallyDirty = false;
  if (!row) return;
  m.lastTallyAt = now;
  ctx.live.publish('drops.tally', tallyOf(ctx, row), 'all');
}

/** Danger zone: forget every drop and take their points and stickers back. */
export function resetDrops(ctx: FeatureContext): void {
  run(ctx.db, 'DELETE FROM drops_claims');
  run(ctx.db, 'DELETE FROM drops_drops');
  ctx.points.revoke(SOURCE);
  ctx.stickers.revokePrefix('drops-');
  const m = mem(ctx);
  m.room = null;
  m.tallyDirty = false;
  changed(ctx);
}
