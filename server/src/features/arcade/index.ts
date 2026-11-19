// Arcade (spec 5.7): reaction, binary/hex and memory games under a minute each.
//
// Fairness model: the server issues a run (random single-use token + seed + start time), generates the
// content from the seed, and decides the score. Submissions are bounded by what a human can physically do
// (minimum reaction time, minimum time per answer, the seeded delays that cannot be skipped, the time that
// actually passed on the server clock). Memory is checked level by level as you play, so the pattern for
// level n+1 is never sent until level n was repeated correctly. Arcade points are capped per attendee per
// event day. A run is single use: replay, double submit and someone else's token all fail.
import { randomBytes } from 'node:crypto';
import {
  ARCADE_DAILY_CAP,
  ARCADE_DAY_OFFSET_MS,
  ARCADE_GAMES,
  ArcadeResetRequestSchema,
  type ArcadeSettings,
  ArcadeSettingsRequestSchema,
  type ArcadeStats,
  type Best,
  GAME_IDS,
  type GameId,
  type GamesResponse,
  HexbinSubmitSchema,
  MEMORY_MAX_LEVEL,
  MEMORY_PADS,
  MEMORY_SHOW_MS,
  MemoryStepSchema,
  type MemoryStepResponse,
  ReactionSubmitSchema,
  type RunResult,
  type RunStart,
  StartRunRequestSchema,
  type TopBoard,
  TopQuerySchema,
  type TopResponse,
} from '@afterhours/shared/features/arcade';
import type { Ok } from '@afterhours/shared';
import {
  type Db,
  type FeatureContext,
  HttpError,
  RateLimiter,
  all,
  badRequest,
  conflict,
  defineFeature,
  forbidden,
  getAttendee,
  isScreen,
  notFound,
  one,
  parse,
  requireAdmin,
  requireAttendee,
  run,
  tx,
  unauthorized,
} from '../../core';
import { parseAvatar } from '../../core/points/ledger';
import {
  Implausible,
  hexbinPoints,
  hexbinQuestions,
  memoryLabel,
  memoryMinLevelMs,
  memoryPoints,
  memorySequence,
  reactionDelays,
  reactionPoints,
  scoreHexbin,
  scoreReaction,
} from './games';
import { fillHouses, registerRounds, roundsTick } from './rounds';

/** Extra time after a run's nominal end for the network. */
export const GRACE_MS = 4000;
/** Bonus for beating your own previous best (counts against the daily cap like everything else). */
export const PB_BONUS = 2;
export const STARTS_PER_MIN = 8;

interface RunRow {
  id: string;
  attendee_id: number;
  game: GameId;
  seed: number;
  started_at: number;
  expires_at: number;
  status: 'open' | 'done' | 'rejected' | 'abandoned';
  progress: number;
  last_at: number | null;
}

interface State {
  starts: RateLimiter;
  dirty: Set<GameId>;
  lastTopAt: number;
}
const states = new WeakMap<FeatureContext, State>();
function state(ctx: FeatureContext): State {
  let s = states.get(ctx);
  if (!s) states.set(ctx, (s = { starts: new RateLimiter({ limit: STARTS_PER_MIN, windowMs: 60_000, now: ctx.now }), dirty: new Set(), lastTopAt: 0 }));
  return s;
}

// settings --------------------------------------------------------------------

const defaultSettings = (): ArcadeSettings => ({ enabled: true, games: { reaction: true, hexbin: true, memory: true } });
export function readSettings(db: Db): ArcadeSettings {
  const row = one<{ value: string }>(db, "SELECT value FROM arcade_settings WHERE key = 'settings'");
  const d = defaultSettings();
  if (!row) return d;
  try {
    const j = JSON.parse(row.value) as Partial<ArcadeSettings>;
    return { enabled: j.enabled ?? true, games: { ...d.games, ...(j.games ?? {}) } };
  } catch {
    return d;
  }
}
const gameOpen = (s: ArcadeSettings, g: GameId): boolean => s.enabled && s.games[g] !== false;

// daily cap ---------------------------------------------------------------------

export const dayStart = (now: number): number => Math.floor((now + ARCADE_DAY_OFFSET_MS) / 86_400_000) * 86_400_000 - ARCADE_DAY_OFFSET_MS;
export const capRemaining = (ctx: FeatureContext, attendeeId: number): number =>
  Math.max(0, ARCADE_DAILY_CAP - ctx.points.totalFrom(attendeeId, 'arcade', dayStart(ctx.now())));

// lists ---------------------------------------------------------------------------

interface BestRow {
  score: number;
  label: string;
  at: number;
}
const bestOf = (db: Db, id: number, game: GameId): BestRow | undefined =>
  one<BestRow>(db, 'SELECT score, label, at FROM arcade_best WHERE attendee_id = ? AND game = ?', id, game);
const playersOf = (db: Db, game: GameId): number => one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM arcade_best WHERE game = ?', game)?.n ?? 0;
/** 1-based: better score first; on equal scores whoever got there first. */
const rankOf = (db: Db, game: GameId, b: BestRow): number =>
  1 + (one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM arcade_best WHERE game = ? AND (score > ? OR (score = ? AND at < ?))', game, b.score, b.score, b.at)?.n ?? 0);

function topBoard(ctx: FeatureContext, game: GameId, limit: number, meId: number | null): TopBoard {
  const rows = all<{ attendee_id: number; nickname: string; avatar: string | null; score: number; label: string; at: number }>(
    ctx.db,
    `SELECT b.attendee_id, a.nickname, a.avatar, b.score, b.label, b.at
       FROM arcade_best b JOIN attendees a ON a.id = b.attendee_id
      WHERE b.game = ? AND a.profile_complete = 1
      ORDER BY b.score DESC, b.at ASC, b.attendee_id ASC LIMIT ?`,
    game,
    limit,
  );
  const mine = meId === null ? undefined : bestOf(ctx.db, meId, game);
  return {
    game,
    entries: rows.map((r, i) => ({ rank: i + 1, attendeeId: r.attendee_id, nickname: r.nickname, avatar: parseAvatar(r.avatar), score: r.score, label: r.label, at: r.at })),
    players: playersOf(ctx.db, game),
    me: mine ? { rank: rankOf(ctx.db, game, mine), score: mine.score, label: mine.label } : null,
  };
}

// runs ----------------------------------------------------------------------------

const RUN_ID = /^[0-9a-f]{32}$/;
function ownRun(ctx: FeatureContext, id: string, attendeeId: number): RunRow {
  const r = RUN_ID.test(id) ? one<RunRow>(ctx.db, 'SELECT * FROM arcade_runs WHERE id = ? AND attendee_id = ?', id, attendeeId) : undefined;
  if (!r) throw notFound('No such run.'); // same answer for "not yours" and "never existed"
  return r;
}

function openRunOrThrow(ctx: FeatureContext, id: string, attendeeId: number, game: GameId): RunRow {
  const r = ownRun(ctx, id, attendeeId);
  if (r.game !== game) throw badRequest('That run is a different game.');
  if (r.status !== 'open') throw conflict(r.status === 'done' ? 'That run is already scored.' : 'That run is closed.');
  if (ctx.now() > r.expires_at) {
    run(ctx.db, "UPDATE arcade_runs SET status = 'abandoned' WHERE id = ? AND status = 'open'", r.id);
    throw new HttpError(410, 'run_expired', 'Too slow, that run timed out. Start a new one.');
  }
  return r;
}

function reject(ctx: FeatureContext, r: RunRow, why: string): never {
  run(ctx.db, "UPDATE arcade_runs SET status = 'rejected', submitted_at = ? WHERE id = ? AND status = 'open'", ctx.now(), r.id);
  ctx.log.warn({ attendeeId: r.attendee_id, game: r.game, why }, 'arcade run rejected');
  throw new HttpError(422, 'implausible', "That run didn't add up, so it doesn't count. Play it straight and it will.");
}

interface Scored {
  score: number;
  label: string;
  detail: Record<string, number>;
  rawPoints: number;
}

/** Consume the run, record the score, pay capped points, unlock stickers. Everything in one transaction. */
function finalize(ctx: FeatureContext, r: RunRow, scored: Scored): RunResult {
  const now = ctx.now();
  const info = ARCADE_GAMES[r.game];
  const out = tx(ctx.db, () => {
    const closed = run(ctx.db, "UPDATE arcade_runs SET status = 'done', score = ?, submitted_at = ? WHERE id = ? AND status = 'open'", scored.score, now, r.id);
    if (closed.changes !== 1) throw conflict('That run is already scored.');
    const before = bestOf(ctx.db, r.attendee_id, r.game);
    const top = one<{ attendee_id: number; score: number; label: string }>(ctx.db, 'SELECT attendee_id, score, label FROM arcade_best WHERE game = ? ORDER BY score DESC, at ASC LIMIT 1', r.game);
    const newBest = scored.score > 0 && (!before || scored.score > before.score);
    if (newBest) {
      run(
        ctx.db,
        `INSERT INTO arcade_best (attendee_id, game, score, label, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(attendee_id, game) DO UPDATE SET score = excluded.score, label = excluded.label, at = excluded.at`,
        r.attendee_id,
        r.game,
        scored.score,
        scored.label,
        now,
      );
    }
    const raw = scored.score > 0 ? scored.rawPoints + (newBest && before ? PB_BONUS : 0) : 0;
    const remaining = capRemaining(ctx, r.attendee_id);
    const pay = Math.min(raw, remaining);
    if (pay > 0) ctx.points.award({ attendeeId: r.attendee_id, source: `arcade.${r.game}`, ref: r.id, points: pay, label: `${info.title}: ${scored.label}` });
    run(ctx.db, 'UPDATE arcade_runs SET points = ? WHERE id = ?', pay, r.id);
    return { newBest, before, top, raw, pay, remaining: Math.max(0, remaining - pay) };
  });

  const best = bestOf(ctx.db, r.attendee_id, r.game) ?? { score: 0, label: '-', at: now };
  const rank = rankOf(ctx.db, r.game, best);
  const players = playersOf(ctx.db, r.game);
  if (out.newBest) {
    state(ctx).dirty.add(r.game);
    if (rank === 1) {
      const who = one<{ nickname: string | null; avatar: string | null }>(ctx.db, 'SELECT nickname, avatar FROM attendees WHERE id = ?', r.attendee_id);
      const prevTop = out.top && out.top.attendee_id !== r.attendee_id ? one<{ nickname: string | null }>(ctx.db, 'SELECT nickname FROM attendees WHERE id = ?', out.top.attendee_id) : undefined;
      if (who?.nickname) {
        ctx.live.publish(
          'arcade.record',
          {
            game: r.game,
            attendeeId: r.attendee_id,
            nickname: who.nickname,
            avatar: parseAvatar(who.avatar),
            score: scored.score,
            label: scored.label,
            previous: out.top ? { nickname: prevTop?.nickname ?? 'someone', score: out.top.score, label: out.top.label } : null,
          },
          'all',
        );
      }
      ctx.stickers.unlock(r.attendee_id, 'arcade-record');
    }
  }
  unlockStickers(ctx, r, scored);

  return {
    runId: r.id,
    game: r.game,
    score: scored.score,
    label: scored.label,
    points: out.pay,
    rawPoints: out.raw,
    capReached: out.raw > out.pay || out.remaining === 0,
    capRemaining: out.remaining,
    newBest: out.newBest,
    best: { score: best.score, label: best.label },
    rank,
    players,
    percentile: players > 0 ? Math.floor((100 * (players - rank)) / players) : 0,
    detail: scored.detail,
  };
}

function unlockStickers(ctx: FeatureContext, r: RunRow, scored: Scored): void {
  const id = r.attendee_id;
  if (scored.score > 0) ctx.stickers.unlock(id, 'arcade-first');
  if (r.game === 'reaction' && (scored.detail.avgMs ?? 9999) <= 220) ctx.stickers.unlock(id, 'arcade-reflex');
  if (r.game === 'hexbin' && (scored.detail.correct ?? 0) >= 20) ctx.stickers.unlock(id, 'arcade-base');
  if (r.game === 'memory' && scored.score >= 900) ctx.stickers.unlock(id, 'arcade-echo');
  const played = one<{ n: number }>(ctx.db, "SELECT COUNT(DISTINCT game) AS n FROM arcade_runs WHERE attendee_id = ? AND status = 'done' AND score > 0", id)?.n ?? 0;
  if (played >= GAME_IDS.length) ctx.stickers.unlock(id, 'arcade-all-three');
}

const memoryScored = (levels: number): Scored => ({ score: levels * 100, label: memoryLabel(levels), detail: { levels }, rawPoints: memoryPoints(levels) });

/** Once a second: tidy unused tokens, tell projectors which top lists moved (at most every 2 s). */
export function tick(ctx: FeatureContext): void {
  const s = state(ctx);
  const now = ctx.now();
  run(ctx.db, "UPDATE arcade_runs SET status = 'abandoned' WHERE status = 'open' AND expires_at < ?", now - 60_000);
  if (s.dirty.size > 0 && now - s.lastTopAt >= 2000) {
    ctx.live.publish('arcade.top', { games: [...s.dirty] }, 'screens');
    s.dirty.clear();
    s.lastTopAt = now;
  }
  roundsTick(ctx);
}

// feature -----------------------------------------------------------------------------

export const arcade = defineFeature({
  name: 'arcade',

  stickers: [
    { id: 'arcade-first', title: 'insert coin', hint: 'finish a run in the arcade', shape: 'circle', color: 'sun', glyph: 'bolt', feature: 'arcade', order: 30 },
    { id: 'arcade-reflex', title: 'twitchy', hint: 'average under 220 ms in lag spike', shape: 'burst', color: 'lime', glyph: 'flame', feature: 'arcade', order: 31 },
    { id: 'arcade-base', title: 'human compiler', hint: 'get 20 right in base rush', shape: 'square', color: 'sky', glyph: 'robot', feature: 'arcade', order: 32 },
    { id: 'arcade-echo', title: 'big brain', hint: 'clear 9 levels of echo', shape: 'blob', color: 'grape', glyph: 'spark', feature: 'arcade', order: 33 },
    { id: 'arcade-all-three', title: 'triple play', hint: 'score in all three games', shape: 'star', color: 'tangerine', glyph: 'star', feature: 'arcade', order: 34 },
    { id: 'arcade-record', title: 'high scorer', hint: 'take #1 on any arcade list', shape: 'shield', color: 'pink', glyph: 'crown', feature: 'arcade', order: 35 },
    { id: 'arcade-rounds-first', title: 'cracked it', hint: 'clear a level in the arcade rounds', shape: 'ticket', color: 'lime', glyph: 'key', feature: 'arcade', order: 36 },
    { id: 'arcade-rounds-hard', title: 'night shift', hint: 'clear a round 4 level', shape: 'burst', color: 'grape', glyph: 'ghost', feature: 'arcade', order: 37 },
  ],

  routes(app, ctx) {
    registerRounds(app, ctx, () => readSettings(ctx.db).enabled);

    // GET /api/arcade/games: settings, my best + rank per game, today's cap
    app.get('/games', async (req): Promise<GamesResponse> => {
      const me = requireAttendee(req);
      const now = ctx.now();
      const earned = ctx.points.totalFrom(me.attendeeId, 'arcade', dayStart(now));
      return {
        settings: readSettings(ctx.db),
        games: GAME_IDS.map((game) => {
          const b = bestOf(ctx.db, me.attendeeId, game);
          return {
            id: game,
            best: b ? { score: b.score, label: b.label } : null,
            plays: one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM arcade_runs WHERE attendee_id = ? AND game = ? AND status = 'done'", me.attendeeId, game)?.n ?? 0,
            rank: b ? rankOf(ctx.db, game, b) : null,
            players: playersOf(ctx.db, game),
          };
        }),
        daily: { cap: ARCADE_DAILY_CAP, earned, remaining: Math.max(0, ARCADE_DAILY_CAP - earned), resetsAt: dayStart(now) + 86_400_000 },
      };
    });

    // GET /api/arcade/top?limit=10: all three lists (attendee with `me`, projector, console)
    app.get('/top', async (req): Promise<TopResponse> => {
      const me = getAttendee(req);
      if (!me && !isScreen(req)) throw unauthorized();
      const q = parse(TopQuerySchema, req.query);
      return { boards: GAME_IDS.map((g) => topBoard(ctx, g, q.limit, me?.attendeeId ?? null)), now: ctx.now() };
    });

    // POST /api/arcade/runs { game }: get a token, a seed-generated spec and a start time
    app.post('/runs', async (req): Promise<RunStart> => {
      const me = requireAttendee(req);
      const { game } = parse(StartRunRequestSchema, req.body);
      if (!gameOpen(readSettings(ctx.db), game)) throw forbidden('The arcade is closed for that game right now.');
      state(ctx).starts.enforce(`a:${me.attendeeId}`, 'Easy, champ. Catch your breath for a few seconds.');
      const now = ctx.now();
      const seed = randomBytes(4).readUInt32BE(0);
      const id = randomBytes(16).toString('hex');
      const durationMs = ARCADE_GAMES[game].durationMs;
      const expiresAt = now + durationMs + GRACE_MS;
      tx(ctx.db, () => {
        // One live run per game: a fresh start abandons the old token for good.
        run(ctx.db, "UPDATE arcade_runs SET status = 'abandoned' WHERE attendee_id = ? AND game = ? AND status = 'open'", me.attendeeId, game);
        run(ctx.db, 'INSERT INTO arcade_runs (id, attendee_id, game, seed, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', id, me.attendeeId, game, seed, now, expiresAt);
      });
      const base = { runId: id, startedAt: now, expiresAt, now, durationMs };
      if (game === 'reaction') return { ...base, game, spec: { rounds: 5, delaysMs: reactionDelays(seed) } };
      if (game === 'hexbin') return { ...base, game, spec: { questions: hexbinQuestions(seed).map((q) => q.question) } };
      return { ...base, game: 'memory', spec: { pads: MEMORY_PADS, showMs: MEMORY_SHOW_MS, level: 1, sequence: memorySequence(seed).slice(0, 1) } };
    });

    // POST /api/arcade/runs/:id/submit: reaction { reactions } or hexbin { answers }
    app.post('/runs/:id/submit', async (req): Promise<RunResult> => {
      const me = requireAttendee(req);
      const id = (req.params as { id: string }).id;
      const r = ownRun(ctx, id, me.attendeeId);
      if (r.game === 'memory') throw badRequest('Echo is played level by level: use /step.');
      openRunOrThrow(ctx, id, me.attendeeId, r.game);
      const elapsed = ctx.now() - r.started_at;
      let scored: Scored;
      try {
        if (r.game === 'reaction') {
          const b = parse(ReactionSubmitSchema, req.body);
          const s = scoreReaction(r.seed, b.reactions, elapsed);
          scored = { ...s, rawPoints: reactionPoints(s.detail.avgMs ?? 9999) };
        } else {
          const b = parse(HexbinSubmitSchema, req.body);
          const s = scoreHexbin(r.seed, b.answers, elapsed, ARCADE_GAMES.hexbin.durationMs);
          scored = { ...s, rawPoints: hexbinPoints(s.detail.correct ?? 0) };
        }
      } catch (e) {
        if (e instanceof Implausible) reject(ctx, r, e.message);
        throw e;
      }
      return finalize(ctx, r, scored);
    });

    // POST /api/arcade/runs/:id/step { taps }: memory. Repeat the current pattern; get the next one or the result.
    app.post('/runs/:id/step', async (req): Promise<MemoryStepResponse> => {
      const me = requireAttendee(req);
      const id = (req.params as { id: string }).id;
      const { taps } = parse(MemoryStepSchema, req.body);
      const r = openRunOrThrow(ctx, id, me.attendeeId, 'memory');
      const now = ctx.now();
      const level = r.progress + 1;
      const seq = memorySequence(r.seed);
      // Too late for this level to count: the run ends with what was already cleared.
      if (now > r.started_at + ARCADE_GAMES.memory.durationMs + 1500) return { status: 'over', result: finalize(ctx, r, memoryScored(r.progress)) };
      const since = now - (r.last_at ?? r.started_at);
      if (since < memoryMinLevelMs(level)) reject(ctx, r, `level ${level} done in ${since} ms`);
      const expected = seq.slice(0, level);
      const right = taps.length === level && taps.every((p, i) => p === expected[i]);
      if (!right) return { status: 'over', result: finalize(ctx, r, memoryScored(r.progress)) };
      const cleared = level;
      if (cleared >= MEMORY_MAX_LEVEL) {
        run(ctx.db, 'UPDATE arcade_runs SET progress = ?, last_at = ? WHERE id = ?', cleared, now, r.id);
        return { status: 'over', result: finalize(ctx, { ...r, progress: cleared }, memoryScored(cleared)) };
      }
      run(ctx.db, 'UPDATE arcade_runs SET progress = ?, last_at = ? WHERE id = ?', cleared, now, r.id);
      return { status: 'continue', level: cleared + 1, sequence: seq.slice(0, cleared + 1), cleared };
    });

    // POST /api/arcade/runs/:id/finish: memory, time is up (or you quit): bank the levels cleared so far
    app.post('/runs/:id/finish', async (req): Promise<RunResult> => {
      const me = requireAttendee(req);
      const r = openRunOrThrow(ctx, (req.params as { id: string }).id, me.attendeeId, 'memory');
      return finalize(ctx, r, memoryScored(r.progress));
    });

    // ---- console ----

    app.get('/admin/stats', async (req): Promise<ArcadeStats> => {
      requireAdmin(req);
      return {
        settings: readSettings(ctx.db),
        dailyCap: ARCADE_DAILY_CAP,
        games: GAME_IDS.map((game) => {
          const c = one<{ runs: number; players: number; flagged: number; open: number }>(
            ctx.db,
            `SELECT SUM(status = 'done') AS runs, COUNT(DISTINCT CASE WHEN status = 'done' THEN attendee_id END) AS players,
                    SUM(status = 'rejected') AS flagged, SUM(status = 'open') AS open FROM arcade_runs WHERE game = ?`,
            game,
          );
          const top = one<Best>(ctx.db, 'SELECT score, label FROM arcade_best WHERE game = ? ORDER BY score DESC, at ASC LIMIT 1', game);
          return { id: game, runs: c?.runs ?? 0, players: c?.players ?? 0, flagged: c?.flagged ?? 0, open: c?.open ?? 0, best: top ?? null };
        }),
        pointsPaid: one<{ t: number | null }>(ctx.db, "SELECT SUM(points) AS t FROM points_ledger WHERE source LIKE 'arcade.%'")?.t ?? 0,
      };
    });

    // POST /api/arcade/admin/settings { enabled?, games? }
    app.post('/admin/settings', async (req): Promise<ArcadeSettings> => {
      requireAdmin(req);
      const b = parse(ArcadeSettingsRequestSchema, req.body);
      const cur = readSettings(ctx.db);
      const next: ArcadeSettings = { enabled: b.enabled ?? cur.enabled, games: { ...cur.games, ...(b.games ?? {}) } };
      run(ctx.db, "INSERT INTO arcade_settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(next));
      ctx.live.publish('arcade.toggled', next, 'all');
      return next;
    });

    // POST /api/arcade/admin/reset { confirm: 'RESET ARCADE' }: danger zone. Wipes runs, bests and arcade points.
    app.post('/admin/reset', async (req): Promise<Ok> => {
      requireAdmin(req);
      parse(ArcadeResetRequestSchema, req.body);
      tx(ctx.db, () => {
        run(ctx.db, 'DELETE FROM arcade_runs');
        run(ctx.db, 'DELETE FROM arcade_best');
        ctx.points.revokeSource('arcade');
      });
      ctx.points.invalidate();
      const s = state(ctx);
      for (const g of GAME_IDS) s.dirty.add(g);
      return { ok: true };
    });
  },

  tick: { everyMs: 1000, run: tick },

  seed(ctx) {
    // Demo houses: everyone signed in so far gets one, so the rounds hub and console have something to show.
    // Rounds are not released by the seed: the console does that, same as on the day.
    fillHouses(ctx);
    // Believable scores for the crowd, so the lists and the leaderboard look lived in.
    const crowd = all<{ id: number }>(ctx.db, 'SELECT id FROM attendees WHERE profile_complete = 1 ORDER BY id');
    const now = ctx.now();
    const insertRun = (id: number, game: GameId, score: number, points: number, at: number, ref: string) =>
      run(ctx.db, "INSERT OR IGNORE INTO arcade_runs (id, attendee_id, game, seed, started_at, expires_at, status, score, points, submitted_at) VALUES (?, ?, ?, 1, ?, ?, 'done', ?, ?, ?)", ref, id, game, at, at + 50_000, score, points, at + 30_000);
    crowd.forEach((c, i) => {
      const r = (k: number) => ((c.id * 2654435761 + k * 40503) >>> 0) % 1000;
      const games: { game: GameId; score: number; label: string; pts: number }[] = [];
      if (i % 5 !== 4) {
        const avg = 190 + (r(1) % 230);
        games.push({ game: 'reaction', score: 1000 - avg, label: `${avg} ms`, pts: reactionPoints(avg) });
      }
      if (i % 3 !== 2) {
        const right = 6 + (r(2) % 22);
        games.push({ game: 'hexbin', score: right * 100 - (r(3) % 4) * 40, label: `${right} right`, pts: hexbinPoints(right) });
      }
      if (i % 2 === 0) {
        const lv = 3 + (r(4) % 9);
        games.push({ game: 'memory', score: lv * 100, label: memoryLabel(lv), pts: memoryPoints(lv) });
      }
      games.forEach((g, j) => {
        const at = now - (30 - i) * 60_000 + j * 90_000;
        const ref = `seed${c.id.toString(16).padStart(6, '0')}${j}`.padEnd(32, '0');
        insertRun(c.id, g.game, g.score, g.pts, at, ref);
        run(ctx.db, 'INSERT OR REPLACE INTO arcade_best (attendee_id, game, score, label, at) VALUES (?, ?, ?, ?, ?)', c.id, g.game, g.score, g.label, at);
        const pay = Math.min(g.pts, capRemaining(ctx, c.id));
        if (pay > 0) ctx.points.award({ attendeeId: c.id, source: `arcade.${g.game}`, ref, points: pay, label: `${ARCADE_GAMES[g.game].title}: ${g.label}` });
        ctx.stickers.unlock(c.id, 'arcade-first');
      });
    });
  },
});
