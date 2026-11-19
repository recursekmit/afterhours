// Hunt engine, generalised to trails: data access, views and the rules that decide points.
// A trail is one sequence of stops (the treasure hunt is trail 1, the Morse trail another).
// Everything that decides a stamp, a hint or a bonus lives here, server side.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { PASSWORD_ALPHABET } from '@afterhours/shared';
import {
  type HuntAttemptResult,
  type HuntBoard,
  type HuntChallenge,
  type HuntCrowd,
  type HuntCurrentStop,
  type HuntFinisher,
  type HuntHintResult,
  type HuntMe,
  type HuntMyFinish,
  type HuntSlipResult,
  type HuntSolvedStop,
  type HuntStatus,
  TRAIL_MORSE_WPM,
  TREASURE_TRAIL_ID,
  type TrailKind,
  type TrailOrderMode,
  type TrailSettings,
  extractHuntCode,
  morseWordOf,
  normaliseAnswer,
  slipMorseKey,
  slipWordKey,
} from '@afterhours/shared/features/hunt';
import { wordToSignal } from '@afterhours/shared/features/morse';
import {
  type FeatureContext,
  RateLimiter,
  all,
  badRequest,
  conflict,
  getPublicAttendee,
  notFound,
  one,
  run,
  tx,
} from '../../core';
import { cooldownFor, hintCost, normaliseCode, rankBonus, speedBonus, stopOrder, stopWorth } from './rules';

export const HUNT_SOURCE = 'hunt';

// ---- rows ----

export interface Trail {
  id: number;
  position: number;
  kind: TrailKind;
  title: string;
  status: HuntStatus;
  orderMode: TrailOrderMode;
  hintsOn: boolean;
  cooldownOn: boolean;
  seed: string;
  openedAt: number | null;
  closedAt: number | null;
}

interface TrailRow {
  id: number;
  position: number;
  kind: TrailKind;
  title: string;
  status: HuntStatus;
  order_mode: TrailOrderMode;
  hints_on: number;
  cooldown_on: number;
  shuffle_seed: string;
  opened_at: number | null;
  closed_at: number | null;
}

export interface Stop {
  id: number;
  trailId: number;
  position: number;
  title: string;
  clue: string;
  clueImage: string | null;
  challenge: HuntChallenge;
  requireScan: boolean;
  onlineFallback: boolean;
  slipId: number | null;
  nextStopId: number | null;
  finale: boolean;
  answers: string[];
  hints: string[];
  points: number;
  glyph: string;
  color: string;
  reveal: string;
  location: string;
  token: string;
  code: string;
}

interface StopRow {
  id: number;
  trail_id: number;
  position: number;
  title: string;
  clue: string;
  clue_image: string | null;
  challenge: HuntChallenge;
  require_scan: number;
  online_fallback: number;
  slip_id: number | null;
  next_stop_id: number | null;
  is_finale: number;
  answers: string;
  hints: string;
  points: number;
  glyph: string;
  color: string;
  reveal: string;
  location: string;
  token: string;
  code: string;
}

interface PlayerRow {
  trail_id: number;
  attendee_id: number;
  started_at: number;
  last_at: number;
  finished_at: number | null;
  finish_rank: number | null;
  elapsed_ms: number | null;
  bonus: number;
  current_stop_id: number | null;
}

function jsonArray(s: string): string[] {
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const toTrail = (r: TrailRow): Trail => ({
  id: r.id,
  position: r.position,
  kind: r.kind,
  title: r.title,
  status: r.status,
  orderMode: r.order_mode,
  hintsOn: r.hints_on === 1,
  cooldownOn: r.cooldown_on === 1,
  seed: r.shuffle_seed,
  openedAt: r.opened_at,
  closedAt: r.closed_at,
});

export function listTrails(ctx: FeatureContext): Trail[] {
  return all<TrailRow>(ctx.db, 'SELECT * FROM hunt_trails ORDER BY position, id').map(toTrail);
}

export function findTrail(ctx: FeatureContext, trailId: number): Trail | null {
  const r = one<TrailRow>(ctx.db, 'SELECT * FROM hunt_trails WHERE id = ?', trailId);
  return r ? toTrail(r) : null;
}

export function getTrail(ctx: FeatureContext, trailId: number): Trail {
  const t = findTrail(ctx, trailId);
  if (!t) throw notFound('No such trail.');
  return t;
}

export function trailSettings(t: Trail): TrailSettings {
  return {
    id: t.id,
    position: t.position,
    kind: t.kind,
    title: t.title,
    status: t.status,
    orderMode: t.orderMode,
    hintsOn: t.hintsOn,
    cooldownOn: t.cooldownOn,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
  };
}

const toStop = (r: StopRow): Stop => ({
  id: r.id,
  trailId: r.trail_id,
  position: r.position,
  title: r.title,
  clue: r.clue,
  clueImage: r.clue_image,
  challenge: r.challenge,
  requireScan: r.require_scan === 1,
  onlineFallback: r.online_fallback === 1,
  slipId: r.slip_id,
  nextStopId: r.next_stop_id,
  finale: r.is_finale === 1,
  answers: jsonArray(r.answers),
  hints: jsonArray(r.hints),
  points: r.points,
  glyph: r.glyph,
  color: r.color,
  reveal: r.reveal,
  location: r.location,
  token: r.token,
  code: r.code,
});

export function loadStops(ctx: FeatureContext, trailId: number = TREASURE_TRAIL_ID): Stop[] {
  return all<StopRow>(ctx.db, 'SELECT * FROM hunt_stops WHERE trail_id = ? ORDER BY position, id', trailId).map(toStop);
}

function findStop(ctx: FeatureContext, where: string, ...args: (string | number)[]): Stop | null {
  const r = one<StopRow>(ctx.db, `SELECT * FROM hunt_stops WHERE ${where}`, ...args);
  return r ? toStop(r) : null;
}

/** The order THIS attendee walks a linear trail's stops (graph trails have no fixed order). */
export function orderFor(trail: Trail, attendeeId: number, stopIds: readonly number[]): number[] {
  return trail.orderMode === 'shuffled' ? stopOrder(trail.seed, attendeeId, stopIds) : [...stopIds];
}

/** Graph trails start at the first stop in authoring order. */
export function graphStart(stops: readonly Stop[]): Stop | null {
  return stops[0] ?? null;
}

/**
 * Where a player is on a trail. Linear trails: the first unsolved stop in their order.
 * Graph trails: the stop they were sent to (stored), unless it is already stamped.
 */
function positionOf(trail: Trail, attendeeId: number, stops: readonly Stop[], solved: ReadonlySet<number>, player: Pick<PlayerRow, 'current_stop_id' | 'finished_at'>): number | null {
  if (player.finished_at !== null) return null;
  if (trail.orderMode === 'graph') {
    const id = player.current_stop_id;
    return id !== null && !solved.has(id) && stops.some((s) => s.id === id) ? id : null;
  }
  return orderFor(trail, attendeeId, stops.map((s) => s.id)).find((x) => !solved.has(x)) ?? null;
}

// ---- per-process runtime ----

/**
 * Live counters per trail, kept in memory and updated incrementally on start and solve so the hot
 * path never rescans every player. Anything structural (stops edited, reset) drops them.
 */
interface CrowdCache {
  here: Map<number, number>;
  solvedBy: Map<number, number>;
  hunting: number;
  finished: number;
  players: number;
}

interface Runtime {
  dirty: Set<number>;
  crowd: Map<number, CrowdCache>;
  /** Typed answers: 8 checks, refilling over 40 s, per attendee. */
  answers: RateLimiter;
  /** Scans that did NOT match your current stop: 10 per minute. */
  scans: RateLimiter;
  hints: RateLimiter;
}

const runtimes = new WeakMap<FeatureContext, Runtime>();
export function runtime(ctx: FeatureContext): Runtime {
  let r = runtimes.get(ctx);
  if (!r) {
    r = {
      dirty: new Set(),
      crowd: new Map(),
      answers: new RateLimiter({ limit: 8, windowMs: 40_000, now: ctx.now }),
      scans: new RateLimiter({ limit: 10, windowMs: 60_000, now: ctx.now }),
      hints: new RateLimiter({ limit: 6, windowMs: 60_000, now: ctx.now }),
    };
    runtimes.set(ctx, r);
  }
  return r;
}

/** A trail's stops or progress changed in a way the counters cannot follow: rebuild them, and tell the tick. */
export function bump(ctx: FeatureContext, trailId?: number): void {
  const rt = runtime(ctx);
  const ids = trailId === undefined ? listTrails(ctx).map((t) => t.id) : [trailId];
  for (const id of ids) {
    rt.crowd.delete(id);
    rt.dirty.add(id);
  }
}

// ---- crowd ----

function buildCache(ctx: FeatureContext, trail: Trail): CrowdCache {
  const stopIds = loadStops(ctx, trail.id).map((s) => s.id);
  const stops = loadStops(ctx, trail.id);
  const players = all<{ attendee_id: number; finished_at: number | null; current_stop_id: number | null }>(
    ctx.db,
    'SELECT attendee_id, finished_at, current_stop_id FROM hunt_players WHERE trail_id = ?',
    trail.id,
  );
  const solvedCount = new Map(
    all<{ attendee_id: number; n: number }>(
      ctx.db,
      'SELECT p.attendee_id, COUNT(*) AS n FROM hunt_progress p JOIN hunt_stops s ON s.id = p.stop_id WHERE s.trail_id = ? GROUP BY p.attendee_id',
      trail.id,
    ).map((r) => [r.attendee_id, r.n]),
  );
  const solvedBy = new Map(
    all<{ stop_id: number; n: number }>(
      ctx.db,
      'SELECT p.stop_id, COUNT(*) AS n FROM hunt_progress p JOIN hunt_stops s ON s.id = p.stop_id WHERE s.trail_id = ? GROUP BY p.stop_id',
      trail.id,
    ).map((r) => [r.stop_id, r.n]),
  );
  const here = new Map<number, number>();
  let finished = 0;
  for (const p of players) {
    if (p.finished_at !== null) {
      finished++;
      continue;
    }
    // Linear: solving only ever happens on the current stop, so solved stops are a prefix of the order.
    const cur = trail.orderMode === 'graph' ? p.current_stop_id : orderFor(trail, p.attendee_id, stopIds)[solvedCount.get(p.attendee_id) ?? 0];
    if (cur !== undefined && cur !== null && stops.some((s) => s.id === cur)) here.set(cur, (here.get(cur) ?? 0) + 1);
  }
  return { here, solvedBy, hunting: players.length - finished, finished, players: players.length };
}

export function crowdOf(ctx: FeatureContext, trailId: number = TREASURE_TRAIL_ID): CrowdCache & { crowd: HuntCrowd } {
  const rt = runtime(ctx);
  let c = rt.crowd.get(trailId);
  if (!c) {
    c = buildCache(ctx, getTrail(ctx, trailId));
    rt.crowd.set(trailId, c);
  }
  const crowd: HuntCrowd = {
    trailId,
    here: [...c.here.entries()]
      .filter(([, count]) => count > 0)
      .map(([stopId, count]) => ({ stopId, count }))
      .sort((a, b) => a.stopId - b.stopId),
    hunting: c.hunting,
    finished: c.finished,
    players: c.players,
    updatedAt: ctx.now(),
  };
  return { ...c, crowd };
}

function bumpMap(m: Map<number, number>, key: number, by: number): void {
  m.set(key, Math.max(0, (m.get(key) ?? 0) + by));
}

/** Follow a start (from = null) or a stamp (to = null when that was the last stop) without rescanning. */
function crowdMove(ctx: FeatureContext, trailId: number, from: number | null, to: number | null, solved: number | null): void {
  const rt = runtime(ctx);
  rt.dirty.add(trailId);
  const c = rt.crowd.get(trailId);
  if (!c) return;
  if (from === null) {
    c.players++;
    c.hunting++;
  } else {
    bumpMap(c.here, from, -1);
  }
  if (to !== null) bumpMap(c.here, to, 1);
  else if (from !== null) {
    c.hunting--;
    c.finished++;
  }
  if (solved !== null) bumpMap(c.solvedBy, solved, 1);
}

// ---- attendee views ----

interface ProgressRow {
  stop_id: number;
  solved_at: number;
  via: 'qr' | 'answer';
  points: number;
  hints_used: number;
}

function myFinish(p: PlayerRow, finishers: number, hintsTotal: number): HuntMyFinish | null {
  if (p.finished_at === null || p.finish_rank === null || p.elapsed_ms === null) return null;
  return {
    rank: p.finish_rank,
    finishedAt: p.finished_at,
    elapsedMs: p.elapsed_ms,
    rankBonus: rankBonus(p.finish_rank),
    speedBonus: speedBonus(p.elapsed_ms),
    finishers,
    usedNoHints: hintsTotal === 0,
  };
}

function playerOf(ctx: FeatureContext, trailId: number, attendeeId: number): PlayerRow | undefined {
  return one<PlayerRow>(ctx.db, 'SELECT * FROM hunt_players WHERE trail_id = ? AND attendee_id = ?', trailId, attendeeId);
}

/** Points this trail paid this attendee (stamps + finish bonuses). */
function trailPoints(ctx: FeatureContext, trail: Trail, attendeeId: number): number {
  const refs = [...loadStops(ctx, trail.id).map((s) => `stop:${s.id}`), finishRef(trail, 'rank'), finishRef(trail, 'speed')];
  if (refs.length === 0) return 0;
  return (
    one<{ t: number | null }>(
      ctx.db,
      `SELECT SUM(points) AS t FROM points_ledger WHERE attendee_id = ? AND source = ? AND ref IN (${refs.map(() => '?').join(',')})`,
      attendeeId,
      HUNT_SOURCE,
      ...refs,
    )?.t ?? 0
  );
}

/** Ledger ref of a finish bonus. Trail 1 keeps the refs it always had. */
export function finishRef(trail: Trail, what: 'rank' | 'speed'): string {
  return trail.id === TREASURE_TRAIL_ID ? `finish-${what}` : `t${trail.id}:finish-${what}`;
}

export function buildMe(ctx: FeatureContext, attendeeId: number, trailId: number = TREASURE_TRAIL_ID): HuntMe {
  const trail = getTrail(ctx, trailId);
  const stops = loadStops(ctx, trailId);
  const cache = crowdOf(ctx, trailId);
  const player = playerOf(ctx, trailId, attendeeId);
  const base = {
    trailId,
    kind: trail.kind,
    orderMode: trail.orderMode,
    hintsOn: trail.hintsOn,
    status: trail.status,
    title: trail.title,
    total: stops.length,
    serverNow: ctx.now(),
    crowd: cache.crowd,
  };
  const pointsEarned = trailPoints(ctx, trail, attendeeId);
  // Before the trail opens, or before this person presses start, nothing about the stops is sent.
  if (!player || trail.status === 'draft') {
    return { ...base, started: false, startedAt: null, solved: [], current: null, finish: null, pointsEarned };
  }

  const order = orderFor(trail, attendeeId, stops.map((s) => s.id));
  const byId = new Map(stops.map((s) => [s.id, s]));
  const progress = new Map(
    all<ProgressRow>(
      ctx.db,
      'SELECT p.stop_id, p.solved_at, p.via, p.points, p.hints_used FROM hunt_progress p JOIN hunt_stops s ON s.id = p.stop_id WHERE p.attendee_id = ? AND s.trail_id = ?',
      attendeeId,
      trailId,
    ).map((r) => [r.stop_id, r]),
  );
  const solved: HuntSolvedStop[] = [];
  if (trail.orderMode === 'graph') {
    // The path this person took, in the order they took it.
    [...progress.values()]
      .sort((a, b) => a.solved_at - b.solved_at)
      .forEach((row, i) => {
        const stop = byId.get(row.stop_id);
        if (stop) solved.push(solvedView(stop, i + 1, row, cache.solvedBy.get(stop.id) ?? 1));
      });
  } else {
    order.forEach((id, i) => {
      const row = progress.get(id);
      const stop = byId.get(id);
      if (row && stop) solved.push(solvedView(stop, i + 1, row, cache.solvedBy.get(id) ?? 1));
    });
  }
  let hintsTotal = 0;
  for (const r of progress.values()) hintsTotal += r.hints_used;

  let current: HuntCurrentStop | null = null;
  if (trail.status === 'open' && player.finished_at === null) {
    const id = positionOf(trail, attendeeId, stops, new Set(progress.keys()), player);
    const stop = id === null ? undefined : byId.get(id);
    const idx = trail.orderMode === 'graph' ? progress.size : order.indexOf(id ?? -1);
    if (stop) current = currentView(ctx, trail, stop, attendeeId, idx, stops.length, cache.here.get(stop.id) ?? 1);
  }
  return {
    ...base,
    started: true,
    startedAt: player.started_at,
    solved,
    current,
    finish: myFinish(player, cache.crowd.finished, hintsTotal),
    pointsEarned,
  };
}

function currentView(ctx: FeatureContext, trail: Trail, stop: Stop, attendeeId: number, idx: number, total: number, hereCount: number): HuntCurrentStop {
  const ss = one<{ hints_used: number; wrong_count: number; locked_until: number; scanned_at: number | null }>(
    ctx.db,
    'SELECT hints_used, wrong_count, locked_until, scanned_at FROM hunt_stop_state WHERE attendee_id = ? AND stop_id = ?',
    attendeeId,
    stop.id,
  );
  const hints = trail.hintsOn ? stop.hints : [];
  const used = Math.min(ss?.hints_used ?? 0, hints.length);
  const now = ctx.now();
  const needsScan = stop.requireScan && stop.challenge !== 'scan' && stop.challenge !== 'slip' && !ss?.scanned_at;
  const slip = stop.challenge === 'slip' && stop.slipId !== null ? one<{ slip_no: number; label: string }>(ctx.db, 'SELECT slip_no, label FROM hunt_slips WHERE id = ?', stop.slipId) : undefined;
  const word = stop.challenge === 'morse' ? morseWordOf(stop.answers[0] ?? '') : '';
  return {
    stopId: stop.id,
    index: idx + 1,
    total,
    challenge: stop.challenge,
    needsScan,
    letters: stop.challenge === 'morse' ? word.length : null,
    // Only the on/off timings (as in a decode round): never the readable word.
    signal: stop.challenge === 'morse' && stop.onlineFallback && word ? wordToSignal(word, TRAIL_MORSE_WPM) : null,
    slip: slip ? { slipNo: slip.slip_no, label: slip.label } : null,
    clue: stop.clue,
    clueImage: stop.clueImage,
    hints: hints.slice(0, used),
    hintsLeft: hints.length - used,
    nextHintCost: used < hints.length ? hintCost(used + 1) : null,
    worth: stopWorth(stop.points, used),
    canType: (stop.challenge === 'riddle' || stop.challenge === 'morse') && stop.answers.length > 0 && !needsScan,
    lockedUntil: (ss?.locked_until ?? 0) > now ? (ss?.locked_until ?? 0) : 0,
    wrongCount: ss?.wrong_count ?? 0,
    hereNow: Math.max(0, hereCount - 1),
    isFinal: trail.orderMode === 'graph' ? stop.finale : idx === total - 1,
  };
}

function solvedView(stop: Stop, index: number, row: ProgressRow, solvedBy: number): HuntSolvedStop {
  return {
    stopId: stop.id,
    index,
    title: stop.title,
    reveal: stop.reveal,
    glyph: stop.glyph as HuntSolvedStop['glyph'],
    color: stop.color as HuntSolvedStop['color'],
    solvedAt: row.solved_at,
    via: row.via,
    points: row.points,
    hintsUsed: row.hints_used,
    solvedBy,
  };
}

export function finishers(ctx: FeatureContext, trailId: number = TREASURE_TRAIL_ID, limit = 50): HuntFinisher[] {
  const rows = all<{ attendee_id: number; finish_rank: number; finished_at: number; elapsed_ms: number; bonus: number }>(
    ctx.db,
    'SELECT attendee_id, finish_rank, finished_at, elapsed_ms, bonus FROM hunt_players WHERE trail_id = ? AND finished_at IS NOT NULL ORDER BY finish_rank LIMIT ?',
    trailId,
    limit,
  );
  const out: HuntFinisher[] = [];
  for (const r of rows) {
    const who = getPublicAttendee(ctx, r.attendee_id);
    if (!who) continue;
    out.push({
      rank: r.finish_rank,
      attendeeId: r.attendee_id,
      nickname: who.nickname,
      avatar: who.avatar,
      finishedAt: r.finished_at,
      elapsedMs: r.elapsed_ms,
      bonus: r.bonus,
    });
  }
  return out;
}

export function stopCount(ctx: FeatureContext, trailId: number): number {
  return one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM hunt_stops WHERE trail_id = ?', trailId)?.n ?? 0;
}

export function buildBoard(ctx: FeatureContext, trailId: number = TREASURE_TRAIL_ID): HuntBoard {
  const trail = getTrail(ctx, trailId);
  return {
    trailId,
    status: trail.status,
    title: trail.title,
    total: stopCount(ctx, trailId),
    crowd: crowdOf(ctx, trailId).crowd,
    finishers: trail.status === 'draft' ? [] : finishers(ctx, trailId),
    serverNow: ctx.now(),
  };
}

// ---- actions ----

function requireOpen(ctx: FeatureContext, trailId: number): Trail {
  const t = getTrail(ctx, trailId);
  const name = trailId === TREASURE_TRAIL_ID ? 'The hunt' : t.title;
  if (t.status === 'draft') throw conflict(`${name} has not opened yet. Hang tight.`);
  if (t.status === 'closed') throw conflict(`${name} is closed. Thanks for playing.`);
  return t;
}

function requirePlayer(ctx: FeatureContext, trail: Trail, attendeeId: number): PlayerRow {
  const p = playerOf(ctx, trail.id, attendeeId);
  if (!p) throw conflict(trail.id === TREASURE_TRAIL_ID ? 'Hit start first.' : `Hit start on ${trail.title} first.`);
  return p;
}

export function startHunt(ctx: FeatureContext, attendeeId: number, trailId: number = TREASURE_TRAIL_ID): HuntMe {
  const trail = requireOpen(ctx, trailId);
  if (stopCount(ctx, trailId) === 0) throw conflict('No stops yet.');
  const now = ctx.now();
  const stops = loadStops(ctx, trailId);
  const first = trail.orderMode === 'graph' ? (graphStart(stops)?.id ?? null) : (orderFor(trail, attendeeId, stops.map((s) => s.id))[0] ?? null);
  const r = run(
    ctx.db,
    'INSERT OR IGNORE INTO hunt_players (trail_id, attendee_id, started_at, last_at, current_stop_id) VALUES (?, ?, ?, ?, ?)',
    trailId,
    attendeeId,
    now,
    now,
    trail.orderMode === 'graph' ? first : null,
  );
  if (r.changes > 0) crowdMove(ctx, trailId, null, first, null);
  return buildMe(ctx, attendeeId, trailId);
}

/** The stop this attendee is on in a trail, or null when they are done. Also returns the solved ids. */
function currentFor(ctx: FeatureContext, attendeeId: number, trail: Trail, stops: Stop[]) {
  const player = playerOf(ctx, trail.id, attendeeId) ?? { current_stop_id: null, finished_at: null };
  const solved = new Set(
    all<{ stop_id: number }>(ctx.db, 'SELECT p.stop_id FROM hunt_progress p JOIN hunt_stops s ON s.id = p.stop_id WHERE p.attendee_id = ? AND s.trail_id = ?', attendeeId, trail.id).map(
      (r) => r.stop_id,
    ),
  );
  const id = positionOf(trail, attendeeId, stops, solved, player);
  return { current: stops.find((s) => s.id === id) ?? null, solved };
}

const MSG_NOT_YOURS = "That's not the sticker you're after right now. Keep it in mind though.";

function reply(ctx: FeatureContext, attendeeId: number, trailId: number, r: { result: 'not_yours' | 'already'; message: string }): HuntAttemptResult {
  return { ...r, me: buildMe(ctx, attendeeId, trailId) };
}

/** A QR or typed sticker code. The trail comes from the sticker; `trailHint` only shapes the reply for unknown codes. */
export function scan(ctx: FeatureContext, attendeeId: number, raw: string, trailHint: number = TREASURE_TRAIL_ID): HuntAttemptResult {
  const code = extractHuntCode(raw);
  const norm = normaliseCode(code);
  const hit = findStop(ctx, 'token = ?', code) ?? (norm.length === 8 ? findStop(ctx, 'code = ?', norm) : null);
  const trailId = hit?.trailId ?? (findTrail(ctx, trailHint) ? trailHint : TREASURE_TRAIL_ID);
  const trail = requireOpen(ctx, trailId);
  const player = requirePlayer(ctx, trail, attendeeId);
  const rt = runtime(ctx);
  if (!rt.scans.allowed(`a:${attendeeId}`)) {
    rt.scans.enforce(`a:${attendeeId}`, 'That is a lot of scanning. Take a breath and read the clue again.');
  }
  if (player.finished_at !== null) return reply(ctx, attendeeId, trailId, { result: 'already', message: `You've already finished ${trail.title}.` });

  const stops = loadStops(ctx, trailId);
  const { current, solved } = currentFor(ctx, attendeeId, trail, stops);
  if (hit && solved.has(hit.id)) return reply(ctx, attendeeId, trailId, { result: 'already', message: 'You already stamped that one.' });
  if (!hit || !current || hit.id !== current.id) {
    // Unknown code and a real sticker for a later stop look exactly the same.
    rt.scans.hit(`a:${attendeeId}`);
    return reply(ctx, attendeeId, trailId, { result: 'not_yours', message: MSG_NOT_YOURS });
  }
  // Scanning proves you found the object. For Morse stops and require-scan stops that opens the
  // answer box (you still have to decode / answer); for the others the scan is the solve.
  if (current.challenge === 'slip') {
    return { result: 'not_yours', message: 'This stop is a slip: scan it with the slip scanner, or type what it says.', me: buildMe(ctx, attendeeId, trailId) };
  }
  if (current.challenge === 'morse' || (current.requireScan && current.challenge !== 'scan')) {
    run(
      ctx.db,
      `INSERT INTO hunt_stop_state (attendee_id, stop_id, scanned_at) VALUES (?, ?, ?)
       ON CONFLICT(attendee_id, stop_id) DO UPDATE SET scanned_at = COALESCE(scanned_at, excluded.scanned_at)`,
      attendeeId,
      current.id,
      ctx.now(),
    );
    return {
      result: 'unlocked',
      message: current.challenge === 'morse' ? 'Found it. Now decode the Morse on it and type the word.' : 'Found it. The answer box is open.',
      stopId: current.id,
      me: buildMe(ctx, attendeeId, trailId),
    };
  }
  return solveStop(ctx, attendeeId, current, 'qr');
}

/** Resolve a stop id to its trail, for answer and hint (an unknown id replies as trail 1). */
function trailOfStop(ctx: FeatureContext, stopId: number): number {
  return one<{ trail_id: number }>(ctx.db, 'SELECT trail_id FROM hunt_stops WHERE id = ?', stopId)?.trail_id ?? TREASURE_TRAIL_ID;
}

export function answer(ctx: FeatureContext, attendeeId: number, stopId: number, text: string): HuntAttemptResult {
  const trailId = trailOfStop(ctx, stopId);
  const trail = requireOpen(ctx, trailId);
  const player = requirePlayer(ctx, trail, attendeeId);
  if (player.finished_at !== null) return reply(ctx, attendeeId, trailId, { result: 'already', message: `You've already finished ${trail.title}.` });
  const stops = loadStops(ctx, trailId);
  const { current, solved } = currentFor(ctx, attendeeId, trail, stops);
  if (solved.has(stopId)) return reply(ctx, attendeeId, trailId, { result: 'already', message: 'You already stamped that one.' });
  if (!current || current.id !== stopId) return reply(ctx, attendeeId, trailId, { result: 'not_yours', message: MSG_NOT_YOURS });
  if (current.challenge === 'slip') throw badRequest('This stop is a slip: scan it, or type what it says, in the slip box.');
  if (current.challenge === 'scan' || current.answers.length === 0) throw badRequest('This one needs its sticker. Go find it.');

  const now = ctx.now();
  const ss = one<{ wrong_count: number; locked_until: number; scanned_at: number | null }>(
    ctx.db,
    'SELECT wrong_count, locked_until, scanned_at FROM hunt_stop_state WHERE attendee_id = ? AND stop_id = ?',
    attendeeId,
    stopId,
  );
  if (current.requireScan && !ss?.scanned_at) throw badRequest('Find the object and scan its QR first. Then the answer box opens.');
  if (ss && ss.locked_until > now) {
    return {
      result: 'locked',
      message: 'Cooling down. Use the time to reread the clue.',
      lockedUntil: ss.locked_until,
      retryAfterMs: ss.locked_until - now,
      me: buildMe(ctx, attendeeId, trailId),
    };
  }
  const guess = normaliseAnswer(text);
  if (guess.length === 0) throw badRequest('Type an answer first.');
  runtime(ctx).answers.enforce(`a:${attendeeId}`, 'Easy on the typing. Think a little, then try again.');

  if (current.answers.some((a) => normaliseAnswer(a) === guess)) return solveStop(ctx, attendeeId, current, 'answer');

  const wrong = (ss?.wrong_count ?? 0) + 1;
  const cooldownMs = trail.cooldownOn ? cooldownFor(wrong) : 0;
  const lockedUntil = trail.cooldownOn ? now + cooldownMs : 0;
  run(
    ctx.db,
    `INSERT INTO hunt_stop_state (attendee_id, stop_id, wrong_count, locked_until) VALUES (?, ?, ?, ?)
     ON CONFLICT(attendee_id, stop_id) DO UPDATE SET wrong_count = excluded.wrong_count, locked_until = excluded.locked_until`,
    attendeeId,
    stopId,
    wrong,
    lockedUntil,
  );
  run(ctx.db, 'UPDATE hunt_players SET last_at = ? WHERE trail_id = ? AND attendee_id = ?', now, trailId, attendeeId);
  return {
    result: 'wrong',
    message:
      current.challenge === 'morse'
        ? 'That is not what the dots and dashes say. Check the chart.'
        : wrong >= 3 && trail.hintsOn
          ? 'Nope. A hint might be cheaper than guessing.'
          : 'Not quite. Have another look.',
    wrongCount: wrong,
    lockedUntil,
    cooldownMs,
    me: buildMe(ctx, attendeeId, trailId),
  };
}

export function revealHint(ctx: FeatureContext, attendeeId: number, stopId: number, n: number): HuntHintResult {
  const trailId = trailOfStop(ctx, stopId);
  const trail = requireOpen(ctx, trailId);
  const player = requirePlayer(ctx, trail, attendeeId);
  if (player.finished_at !== null) throw conflict("You've finished. No more hints needed.");
  if (!trail.hintsOn) throw badRequest('This trail has no hints. You have got this.');
  const stops = loadStops(ctx, trailId);
  const { current } = currentFor(ctx, attendeeId, trail, stops);
  if (!current || current.id !== stopId) throw conflict("That's not your stop right now.");
  if (n > current.hints.length) throw badRequest('No more hints for this one.');
  const used =
    one<{ hints_used: number }>(ctx.db, 'SELECT hints_used FROM hunt_stop_state WHERE attendee_id = ? AND stop_id = ?', attendeeId, stopId)?.hints_used ?? 0;
  if (n > used + 1) throw badRequest('Take the hints one at a time.');
  const text = current.hints[n - 1] as string;
  if (n <= used) return { n, hint: text, cost: 0, me: buildMe(ctx, attendeeId, trailId) }; // already revealed: free, no double charge
  runtime(ctx).hints.enforce(`a:${attendeeId}`, 'Hints are not a firehose. Give it a minute.');
  run(
    ctx.db,
    `INSERT INTO hunt_stop_state (attendee_id, stop_id, hints_used) VALUES (?, ?, ?)
     ON CONFLICT(attendee_id, stop_id) DO UPDATE SET hints_used = excluded.hints_used`,
    attendeeId,
    stopId,
    n,
  );
  run(ctx.db, 'UPDATE hunt_players SET last_at = ? WHERE trail_id = ? AND attendee_id = ?', ctx.now(), trailId, attendeeId);
  return { n, hint: text, cost: hintCost(n), me: buildMe(ctx, attendeeId, trailId) };
}

/** Stickers a trail kind hands out. */
function trailStickers(kind: TrailKind): { first: string | null; finisher: string | null; podium: string | null; clean: string | null } {
  if (kind === 'hunt') return { first: 'hunt-first-stamp', finisher: 'hunt-finisher', podium: 'hunt-podium', clean: 'hunt-clean' };
  if (kind === 'morse') return { first: 'trail-morse-first', finisher: 'trail-morse-done', podium: null, clean: null };
  return { first: null, finisher: null, podium: null, clean: null };
}

/** Stamp a stop for an attendee (already proven to be their current stop). One transaction; idempotent. */
/**
 * Graph trails: where stamping `stop` sends you (`exitTo` overrides the stop's own exit, for slip
 * outcomes), and whether that finishes the trail. Finished = you stamped a stop marked finale.
 * A non-finale stop with no way out also finishes you (failsafe; the console lists it as a dead end).
 */
function graphNext(stop: Stop, stops: readonly Stop[], exitTo: number | null | undefined): { next: number | null; finishes: boolean } {
  if (stop.finale) return { next: null, finishes: true };
  const want = exitTo !== undefined && exitTo !== null ? exitTo : stop.nextStopId;
  const next = want !== null && stops.some((s) => s.id === want && s.id !== stop.id) ? want : null;
  return { next, finishes: next === null };
}

export function solveStop(ctx: FeatureContext, attendeeId: number, stop: Stop, via: 'qr' | 'answer', at = ctx.now(), exitTo?: number | null): HuntAttemptResult {
  const trail = getTrail(ctx, stop.trailId);
  const stops = loadStops(ctx, trail.id);
  const stickers = trailStickers(trail.kind);
  const outcome = tx(ctx.db, () => {
    const used = one<{ hints_used: number }>(ctx.db, 'SELECT hints_used FROM hunt_stop_state WHERE attendee_id = ? AND stop_id = ?', attendeeId, stop.id)?.hints_used ?? 0;
    const hintsUsed = trail.hintsOn ? Math.min(used, stop.hints.length) : 0;
    const points = stopWorth(stop.points, hintsUsed);
    const ins = run(
      ctx.db,
      'INSERT OR IGNORE INTO hunt_progress (attendee_id, stop_id, solved_at, via, points, hints_used) VALUES (?, ?, ?, ?, ?, ?)',
      attendeeId,
      stop.id,
      at,
      via,
      points,
      hintsUsed,
    );
    if (ins.changes === 0) return { fresh: false as const };
    run(ctx.db, 'UPDATE hunt_players SET last_at = ? WHERE trail_id = ? AND attendee_id = ?', at, trail.id, attendeeId);
    ctx.points.award({ attendeeId, source: HUNT_SOURCE, ref: `stop:${stop.id}`, points, label: `stamp: ${stop.title}` });
    if (stickers.first) ctx.stickers.unlock(attendeeId, stickers.first);

    const agg = one<{ n: number; h: number | null }>(
      ctx.db,
      'SELECT COUNT(*) AS n, SUM(p.hints_used) AS h FROM hunt_progress p JOIN hunt_stops s ON s.id = p.stop_id WHERE p.attendee_id = ? AND s.trail_id = ?',
      attendeeId,
      trail.id,
    );
    const solvedCount = agg?.n ?? 0;
    const g = trail.orderMode === 'graph' ? graphNext(stop, stops, exitTo) : null;
    if (g && !g.finishes) run(ctx.db, 'UPDATE hunt_players SET current_stop_id = ? WHERE trail_id = ? AND attendee_id = ?', g.next, trail.id, attendeeId);
    let finishInfo: { rank: number; elapsedMs: number; bonus: number; rb: number; sb: number; noHints: boolean } | null = null;
    if (g ? g.finishes : solvedCount >= stops.length) {
      const startedAt = playerOf(ctx, trail.id, attendeeId)?.started_at ?? at;
      const rank = (one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM hunt_players WHERE trail_id = ? AND finished_at IS NOT NULL', trail.id)?.n ?? 0) + 1;
      const elapsedMs = Math.max(0, at - startedAt);
      const rb = rankBonus(rank);
      const sb = speedBonus(elapsedMs);
      run(
        ctx.db,
        'UPDATE hunt_players SET finished_at = ?, finish_rank = ?, elapsed_ms = ?, bonus = ? WHERE trail_id = ? AND attendee_id = ?',
        at,
        rank,
        elapsedMs,
        rb + sb,
        trail.id,
        attendeeId,
      );
      const name = trail.id === TREASURE_TRAIL_ID ? 'the hunt' : trail.title;
      ctx.points.award({ attendeeId, source: HUNT_SOURCE, ref: finishRef(trail, 'rank'), points: rb, label: `finished ${name} #${rank}` });
      if (sb > 0) ctx.points.award({ attendeeId, source: HUNT_SOURCE, ref: finishRef(trail, 'speed'), points: sb, label: `${name} speed bonus` });
      if (stickers.finisher) ctx.stickers.unlock(attendeeId, stickers.finisher);
      if (rank <= 3 && stickers.podium) ctx.stickers.unlock(attendeeId, stickers.podium);
      const noHints = (agg?.h ?? 0) === 0;
      if (noHints && stickers.clean) ctx.stickers.unlock(attendeeId, stickers.clean);
      finishInfo = { rank, elapsedMs, bonus: rb + sb, rb, sb, noHints };
    }
    return { fresh: true as const, points, hintsUsed, solvedCount, finishInfo, next: g ? g.next : undefined };
  });

  const me = (): HuntMe => buildMe(ctx, attendeeId, trail.id);
  if (!outcome.fresh) {
    // Double tap or replay: the stamp is already there and nothing was paid twice.
    return { result: 'already', message: 'You already stamped that one.', me: me() };
  }
  const order = orderFor(trail, attendeeId, stops.map((s) => s.id));
  const nextId = outcome.next !== undefined ? outcome.next : (order[outcome.solvedCount] ?? null);
  crowdMove(ctx, trail.id, stop.id, outcome.finishInfo ? null : nextId, stop.id);
  const view = me();
  const solvedStop = view.solved.find((s) => s.stopId === stop.id);
  if (!solvedStop) throw new Error('solved stop missing from view');
  const who = getPublicAttendee(ctx, attendeeId);
  if (who) {
    ctx.live.publish('hunt.stamp', { trailId: trail.id, nickname: who.nickname, avatar: who.avatar, solved: outcome.solvedCount, total: stops.length, at }, 'screens');
  }
  let finish: HuntMyFinish | null = null;
  if (outcome.finishInfo) {
    finish = view.finish;
    if (who) {
      ctx.live.publish(
        'hunt.finished',
        {
          trailId: trail.id,
          finisher: {
            rank: outcome.finishInfo.rank,
            attendeeId,
            nickname: who.nickname,
            avatar: who.avatar,
            finishedAt: at,
            elapsedMs: outcome.finishInfo.elapsedMs,
            bonus: outcome.finishInfo.bonus,
          },
          finishedCount: outcome.finishInfo.rank,
        },
        'all',
      );
    }
  }
  return {
    result: 'solved',
    message: outcome.finishInfo ? 'That is every stop. You did it.' : via === 'qr' ? 'Got it. Stamped.' : 'Correct. Stamped.',
    stop: solvedStop,
    finish,
    me: view,
  };
}

// ---- stop authoring helpers ----

export function newToken(): string {
  return randomBytes(16).toString('base64url');
}

export function newCode(ctx: FeatureContext): string {
  for (;;) {
    let c = '';
    for (let i = 0; i < 8; i++) c += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
    if (!one(ctx.db, 'SELECT 1 AS x FROM hunt_stops WHERE code = ?', c)) return c;
  }
}

export function newSeed(): string {
  return randomBytes(16).toString('hex');
}

// ---- Morse slips (docs/SLIPS.md) ----

interface ReadingRow {
  id: number;
  slip_id: number;
  orientation: string;
  word: string | null;
  morse: string | null;
  outcome: 'next' | 'branch' | 'clue' | 'bonus' | 'decoy';
  target_stop_id: number | null;
  target_trail_id: number | null;
  clue: string;
  bonus_points: number;
  message: string;
}

/** The single friendly reply for anything that is not a reading of this slip. Leaks nothing. */
export const SLIP_UNKNOWN = 'nothing there. try turning the slip and scanning another edge.';

/** Per-kit sets: the words this kit's readings carry, drawn once from the pool and stored. */
export function ensureKitWords(ctx: FeatureContext, kitId: string, setId: number): Map<number, { word: string; morse: string }> {
  const set = one<{ mode: string; word_pool: string }>(ctx.db, 'SELECT mode, word_pool FROM hunt_slip_sets WHERE id = ?', setId);
  const out = new Map<number, { word: string; morse: string }>();
  if (!set || set.mode !== 'per_kit') return out;
  const readings = all<{ id: number; morse: string | null }>(
    ctx.db,
    'SELECT r.id, r.morse FROM hunt_slip_readings r JOIN hunt_slips s ON s.id = r.slip_id WHERE s.set_id = ? ORDER BY s.slip_no, r.id',
    setId,
  ).filter((r) => r.morse === null);
  const have = all<{ reading_id: number; word: string; morse: string }>(
    ctx.db,
    `SELECT k.reading_id, k.word, k.morse FROM hunt_kit_slip_words k JOIN hunt_slip_readings r ON r.id = k.reading_id JOIN hunt_slips s ON s.id = r.slip_id
      WHERE k.kit_id = ? AND s.set_id = ?`,
    kitId,
    setId,
  );
  for (const h of have) out.set(h.reading_id, { word: h.word, morse: h.morse });
  const pool = jsonArray(set.word_pool).map((w) => morseWordOf(w)).filter(Boolean);
  if (pool.length === 0) return out;
  const used = new Set([...out.values()].map((v) => v.word));
  for (const r of readings) {
    if (out.has(r.id)) continue;
    // A stable draw per kit and reading; skip words this kit already carries so its edges differ.
    const start = parseInt(createHash('sha256').update(`${kitId}:${r.id}`).digest('hex').slice(0, 8), 16) % pool.length;
    let word = pool[start] as string;
    for (let k = 0; k < pool.length; k++) {
      const w = pool[(start + k) % pool.length] as string;
      if (!used.has(w)) {
        word = w;
        break;
      }
    }
    used.add(word);
    const morse = slipWordKey(word);
    run(ctx.db, 'INSERT OR IGNORE INTO hunt_kit_slip_words (kit_id, reading_id, word, morse) VALUES (?, ?, ?, ?)', kitId, r.id, word, morse);
    out.set(r.id, { word, morse });
  }
  return out;
}

/** The match key of every reading of a slip, as this attendee's kit carries it. */
export function readingKeys(ctx: FeatureContext, slipId: number, kitId: string): { row: ReadingRow; key: string }[] {
  const slip = one<{ set_id: number }>(ctx.db, 'SELECT set_id FROM hunt_slips WHERE id = ?', slipId);
  if (!slip) return [];
  const kitWords = ensureKitWords(ctx, kitId, slip.set_id);
  return all<ReadingRow>(ctx.db, 'SELECT * FROM hunt_slip_readings WHERE slip_id = ? ORDER BY id', slipId).flatMap((row) => {
    if (row.morse) return [{ row, key: slipMorseKey(row.morse) }];
    if (row.word) return [{ row, key: slipWordKey(row.word) }];
    const kw = kitWords.get(row.id);
    return kw ? [{ row, key: kw.morse }] : [];
  });
}

export function submitSlip(ctx: FeatureContext, attendeeId: number, stopId: number, read: { text?: string; morse?: string }): HuntSlipResult {
  const trailId = trailOfStop(ctx, stopId);
  const trail = requireOpen(ctx, trailId);
  const player = requirePlayer(ctx, trail, attendeeId);
  const me = (): ReturnType<typeof buildMe> => buildMe(ctx, attendeeId, trailId);
  const base = { clue: null, points: 0, stamped: null, finish: null, unlockedTrailId: null };
  if (player.finished_at !== null) return { ...base, outcome: 'decoy', message: `You've already finished ${trail.title}.`, me: me() };
  const stops = loadStops(ctx, trailId);
  const { current } = currentFor(ctx, attendeeId, trail, stops);
  if (!current || current.id !== stopId) throw conflict("That's not your stop right now.");
  if (current.challenge !== 'slip' || current.slipId === null) throw badRequest('This stop is not a slip.');

  const keys = new Set<string>();
  if (read.morse) keys.add(slipMorseKey(read.morse));
  if (read.text) keys.add(slipWordKey(read.text));
  keys.delete('');
  const kitId = one<{ kit_id: string }>(ctx.db, 'SELECT kit_id FROM attendees WHERE id = ?', attendeeId)?.kit_id ?? '';
  const hit = readingKeys(ctx, current.slipId, kitId).find((k) => keys.has(k.key));
  const rt = runtime(ctx);
  if (!hit) {
    // Same words for every miss, whatever was read: nothing about the real readings leaks.
    rt.scans.enforce(`slip:${attendeeId}`, 'That is a lot of scanning. Take a breath and turn the slip slowly.');
    return { ...base, outcome: 'unknown', message: SLIP_UNKNOWN, me: me() };
  }
  const r = hit.row;
  run(ctx.db, 'INSERT OR IGNORE INTO hunt_slip_finds (attendee_id, reading_id, at) VALUES (?, ?, ?)', attendeeId, r.id, ctx.now());
  run(ctx.db, 'UPDATE hunt_players SET last_at = ? WHERE trail_id = ? AND attendee_id = ?', ctx.now(), trailId, attendeeId);
  rt.dirty.add(trailId);

  if (r.outcome === 'clue') return { ...base, outcome: 'clue', clue: r.clue, message: r.message || 'a clue, written along that edge.', me: me() };
  if (r.outcome === 'decoy') return { ...base, outcome: 'decoy', message: r.message || 'nope, that edge is a decoy. try another angle.', me: me() };
  if (r.outcome === 'bonus') {
    const a = ctx.points.award({ attendeeId, source: HUNT_SOURCE, ref: `slip:${r.id}`, points: r.bonus_points, label: `slip bonus: ${current.title}` });
    const paid = a.awarded ? r.bonus_points : 0;
    return { ...base, outcome: 'bonus', points: paid, message: r.message || (paid ? `hidden bonus: +${paid}.` : 'you already found this bonus.'), me: me() };
  }
  if (r.outcome === 'branch' && r.target_trail_id !== null) {
    const target = r.target_trail_id;
    const unlocked = ((): number | null => {
      try {
        startHunt(ctx, attendeeId, target);
        return target;
      } catch {
        return null; // that trail is not open (yet)
      }
    })();
    return {
      ...base,
      outcome: 'branch',
      unlockedTrailId: unlocked,
      message: r.message || (unlocked ? 'that edge opened a whole new trail.' : 'that edge points to a trail that is not open yet.'),
      me: me(),
    };
  }
  // next / branch to a stop: stamp this slip stop and go where the reading points.
  const target = r.target_stop_id !== null && stops.some((s) => s.id === r.target_stop_id) ? r.target_stop_id : null;
  const res = solveStop(ctx, attendeeId, current, 'qr', ctx.now(), target);
  return {
    ...base,
    outcome: r.outcome,
    stamped: res.result === 'solved' ? res.stop : null,
    finish: res.result === 'solved' ? res.finish : null,
    message: r.message || (r.outcome === 'branch' ? 'a side path. off you go.' : 'that edge says go. next stop unlocked.'),
    me: res.me,
  };
}
