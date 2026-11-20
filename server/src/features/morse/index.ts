// Morse challenge (spec 5.6).
//
// Fairness model:
//  - The word for a round is picked here and stored here. A decode round sends
//    only an on/off timing sequence; the word is revealed once the round is over.
//  - Encode taps are judged here (shared judgeTaps) against the attendee's own
//    measured unit, and checked against the wall clock: a sequence cannot have
//    been tapped faster than the time since the round (or the last attempt) began.
//  - Points: per (mode, level) only a new personal best pays, and only the
//    difference, via ledger refs that embed the new best score. Replays farm nothing.
import { randomBytes, randomInt } from 'node:crypto';
import type { Ok } from '@afterhours/shared';
import {
  DECODE_ANSWER_MS,
  ENCODE_ROUND_MS,
  GuessRequestSchema,
  LADDER,
  LADDER_BONUS,
  LEVEL_COUNT,
  MAX_ATTEMPTS,
  type MorseBoard,
  type MorseBoardRow,
  type MorseMode,
  type MorseOverview,
  type MorseState,
  type LevelProgress,
  type Press,
  ResetRequestSchema,
  type Round,
  type RoundResult,
  SPRINT_PRIZES,
  SetEnabledRequestSchema,
  type SprintBoard,
  type SprintPublic,
  type SprintRow,
  StartRoundRequestSchema,
  StartSprintRequestSchema,
  TapsRequestSchema,
  decodeScore,
  decodeSpeed,
  editDistance,
  encodeScore,
  encodeSpeed,
  judgeTaps,
  levelDef,
  normaliseWord,
  pointsForScore,
  wordToSignal,
} from '@afterhours/shared/features/morse';
import {
  type FeatureContext,
  HttpError,
  RateLimiter,
  all,
  defineFeature,
  getPublicAttendee,
  isAdmin,
  isScreen,
  notFound,
  one,
  parse,
  requireAdmin,
  requireAttendee,
  requireScreen,
  run,
  tx,
  allAttendeeIds,
} from '../../core';
import { WORDS } from './words';

const SOURCE = 'morse';
const SPRINT_SOURCE = 'morse.sprint';
/** A tapped sequence may finish at most this much before the server clock says it could (clock rounding, ms). */
const TAP_CLOCK_SLACK_MS = 60;
/** A decode answer needs the beeps to be mostly over. */
const TOO_EARLY_FRACTION = 0.4;
/** Speed of a "speedy" encode clear for the sticker. */
export const SPEEDY_WPM = 12;
const CACHE_MS = 2000;

export const STICKERS = {
  firstDecode: 'morse-first-decode',
  firstEncode: 'morse-first-encode',
  decoder: 'morse-decoder',
  telegrapher: 'morse-telegrapher',
  speedy: 'morse-speedy',
  sprinter: 'morse-sprinter',
} as const;

// ---------------------------------------------------------------------------
// per-app state (limiters, small caches)
// ---------------------------------------------------------------------------

interface State {
  issueLimiter: RateLimiter;
  answerLimiter: RateLimiter;
  clears: { at: number; decode: number[]; encode: number[] } | null;
  board: { at: number; version: number; rows: MorseBoardRow[] } | null;
  boardVersion: number;
  lastSprintBoardKey: string;
}
const states = new WeakMap<FeatureContext, State>();
function state(ctx: FeatureContext): State {
  let s = states.get(ctx);
  if (!s) {
    s = {
      issueLimiter: new RateLimiter({ limit: 8, windowMs: 30_000, now: ctx.now }),
      answerLimiter: new RateLimiter({ limit: 12, windowMs: 30_000, now: ctx.now }),
      clears: null,
      board: null,
      boardVersion: 0,
      lastSprintBoardKey: '',
    };
    states.set(ctx, s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

interface RoundRow {
  id: string;
  attendee_id: number;
  mode: MorseMode;
  level: number;
  word: string;
  wpm: number;
  issued_at: number;
  answer_from: number;
  expires_at: number;
  status: 'open' | 'passed' | 'failed' | 'expired' | 'abandoned';
  attempts: number;
  last_attempt_at: number | null;
  sprint_id: number | null;
}
interface BestRow {
  mode: MorseMode;
  level: number;
  best_score: number;
  best_wpm: number | null;
  attempts: number;
}
interface SprintRow_ {
  id: number;
  mode: MorseMode;
  level: number;
  started_at: number;
  ends_at: number;
  status: 'running' | 'ended';
}

function isEnabled(ctx: FeatureContext): boolean {
  return one<{ enabled: number }>(ctx.db, 'SELECT enabled FROM morse_config WHERE id = 1')?.enabled === 1;
}
function requireEnabled(ctx: FeatureContext): void {
  if (!isEnabled(ctx)) throw new HttpError(403, 'feature_off', 'Morse is switched off for now. Back in a bit.');
}

function runningSprint(ctx: FeatureContext): SprintRow_ | null {
  const sp = one<SprintRow_>(ctx.db, "SELECT id, mode, level, started_at, ends_at, status FROM morse_sprints WHERE status = 'running' ORDER BY id DESC LIMIT 1");
  return sp ?? null;
}
const sprintPublic = (sp: SprintRow_): SprintPublic => ({ id: sp.id, mode: sp.mode, level: sp.level, startedAt: sp.started_at, endsAt: sp.ends_at });

function bestRows(ctx: FeatureContext, attendeeId: number): BestRow[] {
  return all<BestRow>(ctx.db, 'SELECT mode, level, best_score, best_wpm, attempts FROM morse_best WHERE attendee_id = ?', attendeeId);
}

/** Highest level this attendee may play in a mode: one above the highest cleared (gating makes clears contiguous). */
function unlockedLevel(rows: BestRow[], mode: MorseMode): number {
  let top = 0;
  for (const r of rows) if (r.mode === mode && r.best_score > 0 && r.level > top) top = r.level;
  return Math.min(LEVEL_COUNT, top + 1);
}

function clearsByLevel(ctx: FeatureContext): { decode: number[]; encode: number[] } {
  const s = state(ctx);
  const t = ctx.now();
  if (!s.clears || t - s.clears.at > CACHE_MS) {
    const decode = new Array<number>(LEVEL_COUNT).fill(0);
    const encode = new Array<number>(LEVEL_COUNT).fill(0);
    for (const r of all<{ mode: MorseMode; level: number; n: number }>(
      ctx.db,
      'SELECT mode, level, COUNT(*) AS n FROM morse_best WHERE best_score > 0 GROUP BY mode, level',
    )) {
      (r.mode === 'decode' ? decode : encode)[r.level - 1] = r.n;
    }
    s.clears = { at: t, decode, encode };
  }
  return s.clears;
}

function progress(ctx: FeatureContext, rows: BestRow[], mode: MorseMode): LevelProgress[] {
  const unlocked = unlockedLevel(rows, mode);
  const others = clearsByLevel(ctx)[mode];
  return LADDER.map((def) => {
    const r = rows.find((x) => x.mode === mode && x.level === def.level);
    return {
      level: def.level,
      unlocked: def.level <= unlocked,
      cleared: (r?.best_score ?? 0) > 0,
      bestScore: r?.best_score ?? 0,
      bestWpm: r?.best_wpm ?? null,
      attempts: r?.attempts ?? 0,
      clearedByOthers: others[def.level - 1] ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// rounds
// ---------------------------------------------------------------------------

function toRound(ctx: FeatureContext, r: RoundRow): Round {
  const decode = r.mode === 'decode';
  const signal = decode ? wordToSignal(r.word, r.wpm) : null;
  return {
    id: r.id,
    mode: r.mode,
    level: r.level,
    sprint: r.sprint_id !== null,
    letters: r.word.length,
    word: decode ? null : r.word.toUpperCase(),
    signal,
    wpm: r.wpm,
    startedAt: r.issued_at,
    serverNow: ctx.now(),
    expiresAt: r.expires_at,
    attemptsLeft: MAX_ATTEMPTS[r.mode] - r.attempts,
    answerClockStartsAt: decode ? r.answer_from : null,
  };
}

/** How far back "how often has this word gone out" looks when spreading words over the room. */
export const WORD_SPREAD_WINDOW_MS = 15 * 60_000;

/**
 * The word for a new round, picked per attendee so neighbours never share an answer when the pool allows:
 * 1. never a word someone else is holding in an open round at this level right now, in either mode
 *    (an encode round shows its word on screen, so it would give away a neighbour's decode round);
 * 2. not one of this attendee's last 8 words in this mode;
 * 3. among what is left, the words handed out least at this level in the last 15 minutes, at random.
 * Rules 1 and 2 relax (in that order of keeping) only when the pool is exhausted.
 */
export function pickWord(ctx: FeatureContext, attendeeId: number, mode: MorseMode, level: number): string {
  const pool = WORDS[level] ?? [];
  const now = ctx.now();
  const recent = new Set(
    all<{ word: string }>(ctx.db, 'SELECT word FROM morse_rounds WHERE attendee_id = ? AND mode = ? ORDER BY issued_at DESC LIMIT 8', attendeeId, mode).map((r) => r.word),
  );
  const held = new Set(
    all<{ word: string }>(ctx.db, "SELECT word FROM morse_rounds WHERE status = 'open' AND expires_at > ? AND level = ? AND attendee_id != ?", now, level, attendeeId).map((r) => r.word),
  );
  const uses = new Map(
    all<{ word: string; n: number }>(ctx.db, 'SELECT word, COUNT(*) AS n FROM morse_rounds WHERE level = ? AND issued_at > ? GROUP BY word', level, now - WORD_SPREAD_WINDOW_MS).map((r) => [r.word, r.n]),
  );
  const tiers = [pool.filter((w) => !held.has(w) && !recent.has(w)), pool.filter((w) => !held.has(w)), pool.filter((w) => !recent.has(w)), pool];
  const from = tiers.find((l) => l.length > 0) ?? pool;
  const least = Math.min(...from.map((w) => uses.get(w) ?? 0));
  const best = from.filter((w) => (uses.get(w) ?? 0) === least);
  return best[randomInt(best.length)] as string;
}

export function startRound(ctx: FeatureContext, attendeeId: number, mode: MorseMode, level: number, wantSprint: boolean): Round {
  requireEnabled(ctx);
  const now = ctx.now();
  let sprint: SprintRow_ | null = null;
  if (wantSprint) {
    sprint = runningSprint(ctx);
    if (!sprint || now >= sprint.ends_at) throw new HttpError(409, 'conflict', 'No speed round is running right now.');
    mode = sprint.mode;
    level = sprint.level;
  } else {
    const unlocked = unlockedLevel(bestRows(ctx, attendeeId), mode);
    if (level > unlocked) throw new HttpError(403, 'locked', `Clear ${mode} level ${unlocked} first.`);
  }
  state(ctx).issueLimiter.enforce(`a:${attendeeId}`, 'Easy! Give your ears a second between rounds.');

  const def = levelDef(level);
  const word = pickWord(ctx, attendeeId, mode, level);
  const wpm = mode === 'decode' ? def.decodeWpm : def.encodeWpm;
  const id = randomBytes(9).toString('base64url');
  let answerFrom = now;
  let expires = now + ENCODE_ROUND_MS;
  if (mode === 'decode') {
    const sig = wordToSignal(word, wpm);
    answerFrom = now + sig.leadInMs + sig.totalMs;
    expires = answerFrom + DECODE_ANSWER_MS;
  }
  if (sprint) expires = Math.min(expires, sprint.ends_at);

  tx(ctx.db, () => {
    // One live round per attendee: a new one retires the old one.
    run(ctx.db, "UPDATE morse_rounds SET status = 'abandoned' WHERE attendee_id = ? AND status = 'open'", attendeeId);
    run(
      ctx.db,
      'INSERT INTO morse_rounds (id, attendee_id, mode, level, word, wpm, issued_at, answer_from, expires_at, sprint_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      attendeeId,
      mode,
      level,
      word,
      wpm,
      now,
      answerFrom,
      expires,
      sprint?.id ?? null,
    );
  });
  return toRound(ctx, { id, attendee_id: attendeeId, mode, level, word, wpm, issued_at: now, answer_from: answerFrom, expires_at: expires, status: 'open', attempts: 0, last_attempt_at: null, sprint_id: sprint?.id ?? null });
}

function loadOwnRound(ctx: FeatureContext, attendeeId: number, id: string, mode: MorseMode): RoundRow {
  const r = one<RoundRow>(ctx.db, 'SELECT * FROM morse_rounds WHERE id = ? AND attendee_id = ?', id, attendeeId);
  if (!r) throw notFound('No such round.');
  if (r.mode !== mode) throw new HttpError(409, 'conflict', `That is a ${r.mode} round.`);
  return r;
}

interface Outcome {
  passed: boolean;
  verdict: string;
  score: number;
  speed: number;
  rhythm: number | null;
  wpm: number | null;
  letterOk: boolean[];
  decoded: string | null;
  presses: RoundResult['presses'];
  /** An attempt that does not count against the attendee (e.g. answered before the beeps ended). */
  free?: boolean;
  message: string;
}

function result(ctx: FeatureContext, r: RoundRow, o: Outcome, extra: Partial<RoundResult> & { over: boolean }): RoundResult {
  const rows = bestRows(ctx, r.attendee_id);
  const best = rows.find((x) => x.mode === r.mode && x.level === r.level)?.best_score ?? 0;
  return {
    roundId: r.id,
    mode: r.mode,
    level: r.level,
    passed: o.passed,
    verdict: o.verdict,
    score: o.score,
    pointsAwarded: 0,
    bestScore: best,
    newBest: false,
    firstClear: false,
    speed: o.speed,
    rhythm: o.rhythm,
    wpm: o.wpm,
    letterOk: extra.over ? o.letterOk : [],
    decoded: o.decoded,
    presses: o.presses,
    attemptsLeft: Math.max(0, MAX_ATTEMPTS[r.mode] - r.attempts),
    word: extra.over ? r.word.toUpperCase() : null,
    unlockedLevel: unlockedLevel(rows, r.mode),
    sprintScore: null,
    message: o.message,
    serverNow: ctx.now(),
    ...extra,
  };
}

/** Close the round, then record a pass (ladder or sprint). */
function settle(ctx: FeatureContext, r: RoundRow, o: Outcome): RoundResult {
  const now = ctx.now();
  const attempts = o.free ? r.attempts : r.attempts + 1;
  const over = o.passed || attempts >= MAX_ATTEMPTS[r.mode] || now >= r.expires_at;
  const status = o.passed ? 'passed' : over ? 'failed' : 'open';
  run(ctx.db, 'UPDATE morse_rounds SET attempts = ?, last_attempt_at = ?, status = ? WHERE id = ?', attempts, o.free ? r.last_attempt_at : now, status, r.id);
  const updated: RoundRow = { ...r, attempts, status };
  if (!o.passed) return result(ctx, updated, o, { over });

  if (r.sprint_id !== null) {
    const sp = one<SprintRow_>(ctx.db, 'SELECT id, mode, level, started_at, ends_at, status FROM morse_sprints WHERE id = ?', r.sprint_id);
    if (!sp || sp.status !== 'running' || now >= sp.ends_at) {
      return result(ctx, updated, { ...o, passed: false, verdict: 'sprint_over', score: 0, message: 'speed round just ended, so close.' }, { over: true });
    }
    run(
      ctx.db,
      `INSERT INTO morse_sprint_scores (sprint_id, attendee_id, score, rounds, last_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(sprint_id, attendee_id) DO UPDATE SET score = score + excluded.score, rounds = rounds + 1, last_at = excluded.last_at`,
      sp.id,
      r.attendee_id,
      o.score,
      now,
    );
    const total = one<{ score: number }>(ctx.db, 'SELECT score FROM morse_sprint_scores WHERE sprint_id = ? AND attendee_id = ?', sp.id, r.attendee_id)?.score ?? o.score;
    return result(ctx, updated, o, { over: true, sprintScore: total });
  }

  return result(ctx, updated, o, { over: true, ...recordClear(ctx, r, o) });
}

/** Personal-best bookkeeping, points on improvement, stickers, feed. */
function recordClear(ctx: FeatureContext, r: RoundRow, o: Outcome): Pick<RoundResult, 'pointsAwarded' | 'bestScore' | 'newBest' | 'firstClear' | 'unlockedLevel'> {
  const now = ctx.now();
  const def = levelDef(r.level);
  const prev = one<{ best_score: number; best_wpm: number | null }>(
    ctx.db,
    'SELECT best_score, best_wpm FROM morse_best WHERE attendee_id = ? AND mode = ? AND level = ?',
    r.attendee_id,
    r.mode,
    r.level,
  );
  const prevBest = prev?.best_score ?? 0;
  const newBest = o.score > prevBest;
  const firstClear = prevBest === 0;
  const bestScore = Math.max(prevBest, o.score);
  const bestWpm = Math.max(prev?.best_wpm ?? 0, o.wpm ?? 0) || null;

  tx(ctx.db, () => {
    run(
      ctx.db,
      `INSERT INTO morse_best (attendee_id, mode, level, best_score, best_wpm, attempts, first_clear_at) VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(attendee_id, mode, level) DO UPDATE SET best_score = excluded.best_score, best_wpm = excluded.best_wpm, attempts = attempts + 1`,
      r.attendee_id,
      r.mode,
      r.level,
      bestScore,
      bestWpm,
      now,
    );
    if (newBest) {
      run(ctx.db, 'INSERT INTO morse_feed (attendee_id, mode, level, score, wpm, first_clear, at) VALUES (?, ?, ?, ?, ?, ?, ?)', r.attendee_id, r.mode, r.level, o.score, o.wpm, firstClear ? 1 : 0, now);
    }
  });

  let pointsAwarded = 0;
  if (newBest) {
    const delta = pointsForScore(def.basePoints, o.score) - pointsForScore(def.basePoints, prevBest);
    if (delta > 0) {
      // The ref carries the new best, which only ever rises, so each step pays once.
      const res = ctx.points.award({ attendeeId: r.attendee_id, source: SOURCE, ref: `${r.mode}-${r.level}:${o.score}`, points: delta, label: `morse ${r.mode} level ${r.level}${firstClear ? '' : ' (new best)'}` });
      if (res.awarded) pointsAwarded = delta;
    }
    state(ctx).clears = null;
    state(ctx).boardVersion++;
  }

  // Stickers and ladder bonus (all idempotent).
  const rows = bestRows(ctx, r.attendee_id);
  ctx.stickers.unlock(r.attendee_id, r.mode === 'decode' ? STICKERS.firstDecode : STICKERS.firstEncode);
  const clearedAll = LADDER.every((d) => (rows.find((x) => x.mode === r.mode && x.level === d.level)?.best_score ?? 0) > 0);
  if (clearedAll) {
    ctx.stickers.unlock(r.attendee_id, r.mode === 'decode' ? STICKERS.decoder : STICKERS.telegrapher);
    const b = ctx.points.award({ attendeeId: r.attendee_id, source: SOURCE, ref: `ladder-${r.mode}`, points: LADDER_BONUS, label: `morse ${r.mode} ladder done` });
    if (b.awarded) pointsAwarded += LADDER_BONUS;
  }
  if (r.mode === 'encode' && (o.wpm ?? 0) >= SPEEDY_WPM) ctx.stickers.unlock(r.attendee_id, STICKERS.speedy);

  if (newBest) {
    const who = getPublicAttendee(ctx, r.attendee_id);
    if (who) {
      ctx.live.publish('morse.cleared', { nickname: who.nickname, avatar: who.avatar, mode: r.mode, level: r.level, wpm: o.wpm, score: o.score, firstClear, at: now }, 'screens');
    }
  }
  return { pointsAwarded, bestScore, newBest, firstClear, unlockedLevel: unlockedLevel(rows, r.mode) };
}

function expireIfLate(ctx: FeatureContext, r: RoundRow): RoundResult | null {
  if (r.status !== 'open') {
    return result(ctx, r, { passed: false, verdict: 'closed', score: 0, speed: 0, rhythm: null, wpm: null, letterOk: [], decoded: null, presses: null, message: 'that round is already done. start a new one.' }, { over: true });
  }
  if (ctx.now() >= r.expires_at) {
    run(ctx.db, "UPDATE morse_rounds SET status = 'expired' WHERE id = ?", r.id);
    return result(ctx, { ...r, status: 'expired' }, { passed: false, verdict: 'expired', score: 0, speed: 0, rhythm: null, wpm: null, letterOk: [], decoded: null, presses: null, message: 'time ran out on that one. new round?' }, { over: true });
  }
  return null;
}

export function submitGuess(ctx: FeatureContext, attendeeId: number, roundId: string, raw: string): RoundResult {
  requireEnabled(ctx);
  state(ctx).answerLimiter.enforce(`a:${attendeeId}`, 'Slow down, one guess at a time.');
  const r = loadOwnRound(ctx, attendeeId, roundId, 'decode');
  const late = expireIfLate(ctx, r);
  if (late) return late;
  const now = ctx.now();
  const word = r.word.toUpperCase();
  const g = normaliseWord(raw);
  const letters = word.length;
  const sig = wordToSignal(r.word, r.wpm);

  // Nobody can have heard the word yet: does not count, nothing revealed.
  if (now < r.issued_at + sig.leadInMs + TOO_EARLY_FRACTION * sig.totalMs) {
    return result(ctx, r, { passed: false, verdict: 'too_early', score: 0, speed: 0, rhythm: null, wpm: null, letterOk: [], decoded: null, presses: null, free: true, message: 'let the beeps finish first!' }, { over: false });
  }

  const ok = g === word;
  const speed = ok ? decodeSpeed(now - r.answer_from, letters) : 0;
  const letterOk = [...word].map((c, i) => g[i] === c);
  const close = !ok && editDistance(g, word) <= 1;
  return settle(ctx, r, {
    passed: ok,
    verdict: ok ? 'ok' : 'wrong',
    score: ok ? decodeScore(speed) : 0,
    speed,
    rhythm: null,
    wpm: null,
    letterOk,
    decoded: null,
    presses: null,
    message: ok ? (speed > 0.8 ? 'ears like a bat.' : 'got it.') : close ? 'so close. one letter off.' : 'not quite. listen again.',
  });
}

export function submitTaps(ctx: FeatureContext, attendeeId: number, roundId: string, presses: Press[]): RoundResult {
  requireEnabled(ctx);
  state(ctx).answerLimiter.enforce(`a:${attendeeId}`, 'Slow down, one attempt at a time.');
  const r = loadOwnRound(ctx, attendeeId, roundId, 'encode');
  const late = expireIfLate(ctx, r);
  if (late) return late;
  const now = ctx.now();
  const def = levelDef(r.level);
  const j = judgeTaps(r.word, presses);

  // Wall clock: the sequence cannot have been tapped faster than the time since the round (or the last attempt) began.
  const since = now - (r.last_attempt_at ?? r.issued_at);
  const fastBy = j.spanMs - since - TAP_CLOCK_SLACK_MS;
  const base = { rhythm: j.rhythm, wpm: j.wpm || null, letterOk: j.letterOk, decoded: j.decoded, presses: j.presses };

  if (fastBy > 0) {
    return settle(ctx, r, { ...base, passed: false, verdict: 'too_quick', score: 0, speed: 0, message: 'that was quicker than your thumbs can go. tap it for real.' });
  }
  const messages: Record<string, string> = {
    wrong: j.decoded ? `we read "${j.decoded.trim()}". try again.` : 'that did not read as the word. try again.',
    empty: 'no taps heard.',
    invalid: 'those taps looked glitchy. try again.',
    too_fast: 'whoa, slow down. the key is not on fire.',
    too_slow: 'speed up a touch, we fell asleep.',
    robotic: 'too perfect. are you a robot? tap it by hand.',
    sloppy: 'right letters, wobbly rhythm. steadier!',
  };
  if (j.verdict !== 'ok') {
    return settle(ctx, r, { ...base, passed: false, verdict: j.verdict, score: 0, speed: 0, message: messages[j.verdict] ?? 'try again.' });
  }
  const speed = encodeSpeed(j.wpm, def.encodeWpm);
  const score = encodeScore(j.rhythm, speed);
  return settle(ctx, r, { ...base, passed: true, verdict: 'ok', score, speed, message: j.rhythm > 0.8 ? 'clean sending. proper operator.' : 'got it.' });
}

// ---------------------------------------------------------------------------
// boards
// ---------------------------------------------------------------------------

function sprintBoard(ctx: FeatureContext, sp: SprintRow_, limit: number): SprintBoard {
  const rows = all<{ attendee_id: number; score: number; rounds: number }>(
    ctx.db,
    'SELECT attendee_id, score, rounds FROM morse_sprint_scores WHERE sprint_id = ? ORDER BY score DESC, last_at ASC, attendee_id ASC',
    sp.id,
  );
  return { sprint: sprintPublic(sp), top: toSprintRows(ctx, rows, limit), players: rows.length, serverNow: ctx.now() };
}

function toSprintRows(ctx: FeatureContext, rows: { attendee_id: number; score: number; rounds: number }[], limit: number): SprintRow[] {
  const out: SprintRow[] = [];
  for (const [i, r] of rows.entries()) {
    if (out.length >= limit) break;
    const who = getPublicAttendee(ctx, r.attendee_id);
    if (!who) continue;
    out.push({ rank: i + 1, attendeeId: who.id, nickname: who.nickname, avatar: who.avatar, score: r.score, rounds: r.rounds });
  }
  return out;
}

function morseRanking(ctx: FeatureContext): MorseBoardRow[] {
  const s = state(ctx);
  const t = ctx.now();
  if (s.board && s.board.version === s.boardVersion && t - s.board.at < CACHE_MS) return s.board.rows;
  const pts = all<{ attendee_id: number; pts: number; last: number }>(
    ctx.db,
    "SELECT attendee_id, SUM(points) AS pts, MAX(at) AS last FROM points_ledger WHERE source = ? OR source LIKE ? GROUP BY attendee_id HAVING pts > 0 ORDER BY pts DESC, last ASC",
    SOURCE,
    `${SOURCE}.%`,
  );
  const bests = all<{ attendee_id: number; mode: MorseMode; n: number; wpm: number | null }>(
    ctx.db,
    'SELECT attendee_id, mode, COUNT(*) AS n, MAX(best_wpm) AS wpm FROM morse_best WHERE best_score > 0 GROUP BY attendee_id, mode',
  );
  const byA = new Map<number, { decode: number; encode: number; wpm: number | null }>();
  for (const b of bests) {
    const e = byA.get(b.attendee_id) ?? { decode: 0, encode: 0, wpm: null };
    e[b.mode] = b.n;
    if (b.wpm !== null) e.wpm = Math.max(e.wpm ?? 0, b.wpm);
    byA.set(b.attendee_id, e);
  }
  const rows: MorseBoardRow[] = [];
  for (const p of pts) {
    const who = getPublicAttendee(ctx, p.attendee_id);
    if (!who) continue;
    const b = byA.get(p.attendee_id);
    rows.push({ rank: rows.length + 1, attendeeId: who.id, nickname: who.nickname, avatar: who.avatar, points: p.pts, decodeCleared: b?.decode ?? 0, encodeCleared: b?.encode ?? 0, bestWpm: b?.wpm ?? null });
  }
  s.board = { at: t, version: s.boardVersion, rows };
  return rows;
}

function overview(ctx: FeatureContext): MorseOverview {
  const now = ctx.now();
  const sp = runningSprint(ctx);
  const last = one<SprintRow_>(ctx.db, "SELECT id, mode, level, started_at, ends_at, status FROM morse_sprints WHERE status = 'ended' ORDER BY id DESC LIMIT 1");
  const recent = all<{ attendee_id: number; mode: MorseMode; level: number; score: number; wpm: number | null; first_clear: number; at: number }>(
    ctx.db,
    'SELECT attendee_id, mode, level, score, wpm, first_clear, at FROM morse_feed ORDER BY id DESC LIMIT 12',
  );
  const feed: MorseOverview['recent'] = [];
  for (const f of recent) {
    const who = getPublicAttendee(ctx, f.attendee_id);
    if (who) feed.push({ nickname: who.nickname, avatar: who.avatar, mode: f.mode, level: f.level, wpm: f.wpm, score: f.score, firstClear: f.first_clear === 1, at: f.at });
  }
  let lastSprint: MorseOverview['lastSprint'] = null;
  if (last) {
    const rows = all<{ attendee_id: number; score: number; rounds: number }>(
      ctx.db,
      'SELECT attendee_id, score, rounds FROM morse_sprint_scores WHERE sprint_id = ? ORDER BY score DESC, last_at ASC, attendee_id ASC',
      last.id,
    );
    lastSprint = { sprint: sprintPublic(last), top: toSprintRows(ctx, rows, 10) };
  }
  return {
    enabled: isEnabled(ctx),
    players: one<{ n: number }>(ctx.db, 'SELECT COUNT(DISTINCT attendee_id) AS n FROM morse_rounds')?.n ?? 0,
    activeRounds: one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM morse_rounds WHERE status = 'open' AND expires_at > ?", now)?.n ?? 0,
    clears: clearsByLevel(ctx),
    recent: feed,
    sprint: sp ? sprintBoard(ctx, sp, 10) : null,
    lastSprint,
    serverNow: now,
  };
}

// ---------------------------------------------------------------------------
// speed rounds
// ---------------------------------------------------------------------------

function publishState(ctx: FeatureContext): void {
  const sp = runningSprint(ctx);
  ctx.live.publish('morse.state', { enabled: isEnabled(ctx), sprint: sp ? sprintPublic(sp) : null }, 'all');
}

export function endSprint(ctx: FeatureContext, id: number): void {
  const sp = one<SprintRow_>(ctx.db, 'SELECT id, mode, level, started_at, ends_at, status FROM morse_sprints WHERE id = ?', id);
  if (!sp || sp.status !== 'running') return;
  const now = ctx.now();
  run(ctx.db, "UPDATE morse_sprints SET status = 'ended', ended_at = ? WHERE id = ?", now, id);
  run(ctx.db, "UPDATE morse_rounds SET status = 'expired' WHERE sprint_id = ? AND status = 'open'", id);
  const rows = all<{ attendee_id: number; score: number; rounds: number }>(
    ctx.db,
    'SELECT attendee_id, score, rounds FROM morse_sprint_scores WHERE sprint_id = ? ORDER BY score DESC, last_at ASC, attendee_id ASC',
    id,
  );
  const prizes = [SPRINT_PRIZES.first, SPRINT_PRIZES.second, SPRINT_PRIZES.third];
  rows.forEach((r, i) => {
    const pts = prizes[i] ?? SPRINT_PRIZES.played;
    ctx.points.award({ attendeeId: r.attendee_id, source: SPRINT_SOURCE, ref: `sprint-${id}`, points: pts, label: i < 3 ? `morse speed round #${i + 1}` : 'morse speed round' });
    if (i < 3) ctx.stickers.unlock(r.attendee_id, STICKERS.sprinter);
  });
  state(ctx).boardVersion++;
  ctx.live.publish('morse.sprint-ended', { sprint: sprintPublic({ ...sp, status: 'ended' }), top: toSprintRows(ctx, rows, 10), players: rows.length }, 'all');
  publishState(ctx);
}

/** Runs every second: ends a finished speed round, streams the live top 5 when it changes. */
export function tick(ctx: FeatureContext): void {
  const sp = runningSprint(ctx);
  if (!sp) {
    state(ctx).lastSprintBoardKey = '';
    return;
  }
  if (ctx.now() >= sp.ends_at) {
    endSprint(ctx, sp.id);
    return;
  }
  const board = sprintBoard(ctx, sp, 5);
  const key = board.top.map((r) => `${r.attendeeId}:${r.score}`).join('|') + `#${board.players}`;
  if (key !== state(ctx).lastSprintBoardKey) {
    state(ctx).lastSprintBoardKey = key;
    ctx.live.publish('morse.sprint-board', board, 'all');
  }
}

// ---------------------------------------------------------------------------
// the feature
// ---------------------------------------------------------------------------

export const morse = defineFeature({
  name: 'morse',
  // purge test player: the cached clears and board no longer count them
  onPurge(ctx) {
    const s = state(ctx);
    s.clears = null;
    s.board = null;
    s.boardVersion++;
  },

  stickers: [
    { id: STICKERS.firstDecode, title: 'first dit', hint: 'decode your first morse word', shape: 'circle', color: 'sky', glyph: 'note', feature: 'morse', order: 60 },
    { id: STICKERS.firstEncode, title: 'key tapper', hint: 'send your first word on the telegraph key', shape: 'ticket', color: 'lime', glyph: 'key', feature: 'morse', order: 61 },
    { id: STICKERS.decoder, title: 'bat ears', hint: 'clear all 5 decode levels', shape: 'burst', color: 'grape', glyph: 'wave', feature: 'morse', order: 62 },
    { id: STICKERS.telegrapher, title: 'wire wizard', hint: 'clear all 5 encode levels', shape: 'shield', color: 'tangerine', glyph: 'crown', feature: 'morse', order: 63 },
    { id: STICKERS.speedy, title: 'twitchy thumb', hint: `send at ${SPEEDY_WPM} wpm or faster`, shape: 'star', color: 'sun', glyph: 'bolt', feature: 'morse', order: 64 },
    { id: STICKERS.sprinter, title: 'sprint podium', hint: 'top 3 in a morse speed round', shape: 'heart', color: 'pink', glyph: 'flame', feature: 'morse', order: 65 },
  ],

  routes(app, ctx) {
    // GET /api/morse/state (attendee)
    app.get('/state', async (req): Promise<MorseState> => {
      const me = requireAttendee(req);
      const now = ctx.now();
      const rows = bestRows(ctx, me.attendeeId);
      const open = one<RoundRow>(ctx.db, "SELECT * FROM morse_rounds WHERE attendee_id = ? AND status = 'open' AND expires_at > ? ORDER BY issued_at DESC LIMIT 1", me.attendeeId, now);
      const sp = runningSprint(ctx);
      return {
        enabled: isEnabled(ctx),
        ladder: LADDER.map((d) => ({ ...d })),
        decode: progress(ctx, rows, 'decode'),
        encode: progress(ctx, rows, 'encode'),
        morsePoints: ctx.points.totalFrom(me.attendeeId, SOURCE),
        openRound: open ? toRound(ctx, open) : null,
        sprint: sp ? sprintBoard(ctx, sp, 5) : null,
        players: one<{ n: number }>(ctx.db, 'SELECT COUNT(DISTINCT attendee_id) AS n FROM morse_rounds')?.n ?? 0,
        serverNow: now,
      };
    });

    // POST /api/morse/rounds (attendee)
    app.post('/rounds', async (req): Promise<Round> => {
      const me = requireAttendee(req);
      const b = parse(StartRoundRequestSchema, req.body);
      return startRound(ctx, me.attendeeId, b.mode, b.level, b.sprint === true);
    });

    // POST /api/morse/rounds/:id/guess (attendee, decode)
    app.post<{ Params: { id: string } }>('/rounds/:id/guess', async (req): Promise<RoundResult> => {
      const me = requireAttendee(req);
      const b = parse(GuessRequestSchema, req.body);
      return submitGuess(ctx, me.attendeeId, req.params.id, b.guess);
    });

    // POST /api/morse/rounds/:id/taps (attendee, encode)
    app.post<{ Params: { id: string } }>('/rounds/:id/taps', async (req): Promise<RoundResult> => {
      const me = requireAttendee(req);
      const b = parse(TapsRequestSchema, req.body);
      return submitTaps(ctx, me.attendeeId, req.params.id, b.presses);
    });

    // GET /api/morse/board (attendee, projector or console)
    app.get('/board', async (req): Promise<MorseBoard> => {
      let meId: number | null = null;
      if (!isAdmin(req) && !isScreen(req)) meId = requireAttendee(req).attendeeId;
      const rows = morseRanking(ctx);
      return { top: rows.slice(0, 10), me: meId === null ? null : (rows.find((r) => r.attendeeId === meId) ?? null), players: rows.length };
    });

    // GET /api/morse/screen (projector; the console may preview)
    app.get('/screen', async (req): Promise<MorseOverview> => {
      requireScreen(req);
      return overview(ctx);
    });

    // GET /api/morse/admin (console)
    app.get('/admin', async (req): Promise<MorseOverview> => {
      requireAdmin(req);
      return overview(ctx);
    });

    // PUT /api/morse/admin/enabled (console)
    app.put('/admin/enabled', async (req): Promise<Ok> => {
      requireAdmin(req);
      const { enabled } = parse(SetEnabledRequestSchema, req.body);
      run(ctx.db, 'UPDATE morse_config SET enabled = ? WHERE id = 1', enabled ? 1 : 0);
      publishState(ctx);
      return { ok: true };
    });

    // POST /api/morse/admin/sprint (console): start a speed round
    app.post('/admin/sprint', async (req): Promise<SprintPublic> => {
      requireAdmin(req);
      const b = parse(StartSprintRequestSchema, req.body);
      requireEnabled(ctx);
      if (runningSprint(ctx)) throw new HttpError(409, 'conflict', 'A speed round is already running.');
      const now = ctx.now();
      const r = run(ctx.db, 'INSERT INTO morse_sprints (mode, level, started_at, ends_at) VALUES (?, ?, ?, ?)', b.mode, b.level, now, now + b.durationSec * 1000);
      state(ctx).lastSprintBoardKey = '';
      publishState(ctx);
      return { id: r.lastId, mode: b.mode, level: b.level, startedAt: now, endsAt: now + b.durationSec * 1000 };
    });

    // POST /api/morse/admin/sprint/end (console): end it now and pay the podium
    app.post('/admin/sprint/end', async (req): Promise<Ok> => {
      requireAdmin(req);
      const sp = runningSprint(ctx);
      if (!sp) throw new HttpError(409, 'conflict', 'No speed round is running.');
      endSprint(ctx, sp.id);
      return { ok: true };
    });

    // POST /api/morse/admin/reset (console danger zone, typed confirmation)
    app.post('/admin/reset', async (req): Promise<Ok> => {
      requireAdmin(req);
      parse(ResetRequestSchema, req.body);
      tx(ctx.db, () => {
        for (const t of ['morse_feed', 'morse_sprint_scores', 'morse_sprints', 'morse_best', 'morse_rounds']) run(ctx.db, `DELETE FROM ${t}`);
        ctx.points.revokeSource('morse');
        ctx.stickers.revokePrefix('morse-');
      });
      const s = state(ctx);
      s.clears = null;
      s.board = null;
      s.boardVersion++;
      s.lastSprintBoardKey = '';
      ctx.points.invalidate();
      publishState(ctx);
      ctx.live.publish('leaderboard.changed', { at: ctx.now() }, 'all');
      return { ok: true };
    });
  },

  tick: { everyMs: 1000, run: tick },

  boot(ctx) {
    // After a restart, tidy rounds that ran out while the server was down.
    run(ctx.db, "UPDATE morse_rounds SET status = 'expired' WHERE status = 'open' AND expires_at <= ?", ctx.now());
  },

  seed(ctx) {
    // Give the demo crowd some Morse history so the board, feed and clear counts are alive.
    const ids = allAttendeeIds(ctx).filter((id) => getPublicAttendee(ctx, id));
    const now = ctx.now();
    ids.slice(0, 12).forEach((id, i) => {
      const decodeTo = (i * 3) % 6; // levels cleared 0..5
      const encodeTo = Math.max(0, decodeTo - 1 - (i % 2));
      for (const [mode, to] of [['decode', decodeTo], ['encode', encodeTo]] as const) {
        for (let level = 1; level <= to; level++) {
          const score = 62 + ((i * 7 + level * 5) % 36);
          const wpm = mode === 'encode' ? 4 + ((i + level) % 6) * 1.5 : null;
          run(ctx.db, 'INSERT OR IGNORE INTO morse_best (attendee_id, mode, level, best_score, best_wpm, attempts, first_clear_at) VALUES (?, ?, ?, ?, ?, 1, ?)', id, mode, level, score, wpm, now);
          run(ctx.db, 'INSERT INTO morse_feed (attendee_id, mode, level, score, wpm, first_clear, at) VALUES (?, ?, ?, ?, ?, 1, ?)', id, mode, level, score, wpm, now - (i * 40 + level) * 1000);
          ctx.points.award({ attendeeId: id, source: SOURCE, ref: `${mode}-${level}:${score}`, points: pointsForScore(levelDef(level).basePoints, score), label: `morse ${mode} level ${level}` });
        }
      }
      if (decodeTo > 0) ctx.stickers.unlock(id, STICKERS.firstDecode);
    });
    state(ctx).clears = null;
    state(ctx).boardVersion++;
  },
});

