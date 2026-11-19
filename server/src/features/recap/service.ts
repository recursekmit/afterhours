// Recap aggregation. Everything here READS: the points ledger, sticker unlocks, attendees (core), and
// each feature's tables through read-only SELECTs. Nothing writes another feature's tables.
//
// Cost model for "300 phones open it at the same moment": the room-wide pieces (rarity, quiz ranks
// and speed percentiles, trail sizes, arcade player counts) are computed once per CACHE_MS and shared;
// each person's own part is a handful of indexed lookups, cached per attendee for CACHE_MS too.
// Each feature section is isolated: if a feature is missing or its tables change shape, that card
// comes back empty instead of the whole recap failing.
import type { StickerDef } from '@afterhours/shared';
import { ARCADE_GAMES, type GameId } from '@afterhours/shared/features/arcade';
import { PUZZLE_GAMES, type PuzzleId } from '@afterhours/shared/features/arcade-rounds';
import {
  type Recap,
  type RecapStatus,
  type RecapTrail,
  type RoomRecap,
  type StickerRarity,
  derivePersonality,
} from '@afterhours/shared/features/recap';
import { type FeatureContext, all, getAttendeeById, one, run } from '../../core';
import { parseAvatar } from '../../core/points/ledger';
import { buildBoard, freezeState } from '../leaderboard';

export const CACHE_MS = 5000;

/** Run a read; on any error (missing feature, changed table) return the fallback. */
function safe<T>(ctx: FeatureContext, what: string, fallback: T, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    ctx.log.debug({ err, what }, 'recap: section unavailable');
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// gating
// ---------------------------------------------------------------------------

interface StateRow {
  console_open: number;
  reveal_open_at: number | null;
  dismissed_reveal_at: number | null;
}

const stateRow = (ctx: FeatureContext): StateRow =>
  one<StateRow>(ctx.db, 'SELECT console_open, reveal_open_at, dismissed_reveal_at FROM recap_state WHERE id = 1') ?? {
    console_open: 0,
    reveal_open_at: null,
    dismissed_reveal_at: null,
  };

/**
 * Current gate. Also latches the reveal: the first time a finished final reveal is seen, the recap
 * opens and stays open (unfreezing the board later does not lock everyone out again).
 */
export function recapStatus(ctx: FeatureContext): RecapStatus {
  const st = stateRow(ctx);
  const freeze = safe(ctx, 'freeze', null, () => freezeState(ctx));
  const reveal = freeze?.reveal ?? null;
  const revealDone = Boolean(reveal?.done && reveal.startedAt !== null);
  let revealOpen = st.reveal_open_at !== null;
  if (revealDone && !revealOpen && reveal?.startedAt != null && reveal.startedAt !== st.dismissed_reveal_at) {
    run(ctx.db, 'UPDATE recap_state SET reveal_open_at = ?, changed_at = ? WHERE id = 1', reveal.startedAt, ctx.now());
    revealOpen = true;
  }
  const consoleOpen = st.console_open === 1;
  const open = consoleOpen || revealOpen;
  return { open, reason: !open ? null : consoleOpen ? 'console' : 'reveal', consoleOpen, revealDone, closing: Boolean(freeze?.frozen) };
}

/** The console switch. Closing also dismisses a reveal-opened recap (until the next reveal). */
export function setRecapOpen(ctx: FeatureContext, open: boolean): RecapStatus {
  if (open) {
    run(ctx.db, 'UPDATE recap_state SET console_open = 1, changed_at = ? WHERE id = 1', ctx.now());
  } else {
    run(
      ctx.db,
      'UPDATE recap_state SET console_open = 0, dismissed_reveal_at = COALESCE(reveal_open_at, dismissed_reveal_at), reveal_open_at = NULL, changed_at = ? WHERE id = 1',
      ctx.now(),
    );
  }
  return recapStatus(ctx);
}

// ---------------------------------------------------------------------------
// shared (room-wide) pieces, computed once per CACHE_MS
// ---------------------------------------------------------------------------

interface Shared {
  at: number;
  attendees: number;
  catalogue: StickerDef[];
  rarity: Map<string, number>;
  quizRank: Map<number, number>;
  quizPlayers: number;
  quizSpeed: Map<number, number>;
  trailStops: Map<number, number>;
  arcadePlayers: Map<string, number>;
}

interface State {
  shared: Shared | null;
  mine: Map<number, { at: number; recap: Recap }>;
  room: RoomRecap | null;
}

const states = new WeakMap<FeatureContext, State>();
function state(ctx: FeatureContext): State {
  let s = states.get(ctx);
  if (!s) states.set(ctx, (s = { shared: null, mine: new Map(), room: null }));
  return s;
}

/** Drop every cache (the console toggle and tests use it). */
export function invalidateRecap(ctx: FeatureContext): void {
  const s = state(ctx);
  s.shared = null;
  s.room = null;
  s.mine.clear();
}

const fresh = (ctx: FeatureContext, at: number | undefined): boolean => at !== undefined && ctx.now() - at < CACHE_MS && ctx.now() >= at;

function rarityCounts(ctx: FeatureContext): Map<string, number> {
  return new Map(all<{ sticker_id: string; n: number }>(ctx.db, 'SELECT sticker_id, COUNT(*) AS n FROM sticker_unlocks GROUP BY sticker_id').map((r) => [r.sticker_id, r.n]));
}

/**
 * Quiz speed: for every revealed quiz, each answer is compared with everyone else's on that question
 * ("slower than you" = took longer). Your number is the average over your correct answers (or over all
 * of them if none were correct). Questions only one person answered do not count.
 */
export function quizSpeedTable(rows: { poll_id: number; attendee_id: number; correct: number | null; elapsed_ms: number }[]): Map<number, number> {
  const byPoll = new Map<number, typeof rows>();
  for (const r of rows) {
    const list = byPoll.get(r.poll_id) ?? [];
    list.push(r);
    byPoll.set(r.poll_id, list);
  }
  const acc = new Map<number, { cs: number; cn: number; as: number; an: number }>();
  for (const list of byPoll.values()) {
    if (list.length < 2) continue;
    const times = list.map((r) => r.elapsed_ms).sort((a, b) => a - b);
    for (const r of list) {
      // how many others took strictly longer: binary search for the first time > mine
      let lo = 0;
      let hi = times.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid]! <= r.elapsed_ms) lo = mid + 1;
        else hi = mid;
      }
      const frac = (times.length - lo) / (times.length - 1);
      const a = acc.get(r.attendee_id) ?? { cs: 0, cn: 0, as: 0, an: 0 };
      a.as += frac;
      a.an++;
      if (r.correct === 1) {
        a.cs += frac;
        a.cn++;
      }
      acc.set(r.attendee_id, a);
    }
  }
  const out = new Map<number, number>();
  for (const [id, a] of acc) out.set(id, Math.round((100 * (a.cn > 0 ? a.cs / a.cn : a.as / a.an))));
  return out;
}

function shared(ctx: FeatureContext): Shared {
  const s = state(ctx);
  if (s.shared && fresh(ctx, s.shared.at)) return s.shared;
  const at = ctx.now();
  const attendees = one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM attendees')?.n ?? 0;

  // Quiz rank from the ledger: everyone's quiz points, highest first, earlier last award wins ties.
  const quizRows = all<{ attendee_id: number; t: number; last: number }>(
    ctx.db,
    "SELECT attendee_id, SUM(points) AS t, MAX(at) AS last FROM points_ledger WHERE source = 'polls.quiz' GROUP BY attendee_id HAVING t > 0 ORDER BY t DESC, last ASC, attendee_id ASC",
  );
  const quizRank = new Map(quizRows.map((r, i) => [r.attendee_id, i + 1]));

  const quizSpeed = safe(ctx, 'quiz speed', new Map<number, number>(), () =>
    quizSpeedTable(
      all<{ poll_id: number; attendee_id: number; correct: number | null; elapsed_ms: number }>(
        ctx.db,
        `SELECT v.poll_id, v.attendee_id, v.correct, v.elapsed_ms FROM poll_votes v JOIN polls p ON p.id = v.poll_id
          WHERE p.kind = 'quiz' AND p.status = 'revealed' AND v.elapsed_ms IS NOT NULL`,
      ),
    ),
  );

  const trailStops = safe(ctx, 'trail sizes', new Map<number, number>(), () =>
    new Map(all<{ trail_id: number; n: number }>(ctx.db, 'SELECT trail_id, COUNT(*) AS n FROM hunt_stops GROUP BY trail_id').map((r) => [r.trail_id, r.n])),
  );
  const arcadePlayers = safe(ctx, 'arcade players', new Map<string, number>(), () =>
    new Map(all<{ game: string; n: number }>(ctx.db, 'SELECT game, COUNT(*) AS n FROM arcade_best GROUP BY game').map((r) => [r.game, r.n])),
  );

  s.shared = { at, attendees, catalogue: ctx.stickers.list(), rarity: rarityCounts(ctx), quizRank, quizPlayers: quizRows.length, quizSpeed, trailStops, arcadePlayers };
  return s.shared;
}

export function stickerRarity(ctx: FeatureContext): StickerRarity {
  const sh = shared(ctx);
  return { attendees: sh.attendees, counts: Object.fromEntries(sh.rarity), at: sh.at };
}

const pctOf = (count: number, of: number): number => {
  if (of <= 0) return 0;
  const p = (count / of) * 100;
  return p < 10 ? Math.round(p * 10) / 10 : Math.round(p);
};

// ---------------------------------------------------------------------------
// the personal recap
// ---------------------------------------------------------------------------

/** "slip 2: the lab path" -> "lab", "the library" -> "library". Used for "you went the lab way". */
export function wayOf(title: string): string {
  const w = title
    .toLowerCase()
    .replace(/^slip\s*\d+\s*:\s*/, '')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/\s+(path|way|route|stop)$/, '')
    .trim();
  return w || title.toLowerCase();
}

interface ProgressRow {
  stop_id: number;
  solved_at: number;
  title: string;
  is_finale: number;
  trail_id: number;
  trail_title: string;
  kind: string;
  order_mode: string;
  trail_pos: number;
}

function trailsOf(ctx: FeatureContext, attendeeId: number, sh: Shared): Recap['trails'] & { morseStamps: number } {
  return safe(ctx, 'trails', { stamps: 0, bonuses: 0, list: [], morseStamps: 0 }, () => {
    const rows = all<ProgressRow>(
      ctx.db,
      `SELECT p.stop_id, p.solved_at, s.title, s.is_finale, s.trail_id, t.title AS trail_title, t.kind, t.order_mode, t.position AS trail_pos
         FROM hunt_progress p JOIN hunt_stops s ON s.id = p.stop_id JOIN hunt_trails t ON t.id = s.trail_id
        WHERE p.attendee_id = ? ORDER BY t.position, p.solved_at, p.stop_id`,
      attendeeId,
    );
    const finished = new Set(
      all<{ trail_id: number }>(ctx.db, 'SELECT trail_id FROM hunt_players WHERE attendee_id = ? AND finished_at IS NOT NULL', attendeeId).map((r) => r.trail_id),
    );
    const byTrail = new Map<number, ProgressRow[]>();
    for (const r of rows) byTrail.set(r.trail_id, [...(byTrail.get(r.trail_id) ?? []), r]);
    const list: RecapTrail[] = [];
    for (const [id, rs] of byTrail) {
      const first = rs[0]!;
      const graph = first.order_mode === 'graph';
      const path = rs.map((r) => r.title);
      // the way: the first stop after the start that is not the finale
      const branch = graph ? rs.slice(1).find((r) => r.is_finale !== 1) : undefined;
      list.push({
        id,
        title: first.trail_title,
        kind: first.kind,
        stamps: rs.length,
        stops: sh.trailStops.get(id) ?? rs.length,
        finished: finished.has(id),
        graph,
        path,
        way: branch ? wayOf(branch.title) : null,
      });
    }
    const bonuses = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM points_ledger WHERE attendee_id = ? AND source = 'hunt' AND ref LIKE 'slip:%'", attendeeId)?.n ?? 0;
    const morseStamps = list.filter((t) => t.kind === 'morse').reduce((n, t) => n + t.stamps, 0);
    return { stamps: rows.length, bonuses, list, morseStamps };
  });
}

function pollsOf(ctx: FeatureContext, attendeeId: number, sh: Shared): Recap['polls'] {
  const votes = safe(ctx, 'votes', 0, () => one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM poll_votes WHERE attendee_id = ?', attendeeId)?.n ?? 0);
  const quiz = safe(ctx, 'quiz', { answered: 0, correct: 0 }, () => {
    const r = one<{ answered: number; correct: number | null }>(
      ctx.db,
      `SELECT COUNT(*) AS answered, SUM(CASE WHEN v.correct = 1 THEN 1 ELSE 0 END) AS correct
         FROM poll_votes v JOIN polls p ON p.id = v.poll_id WHERE v.attendee_id = ? AND p.kind = 'quiz' AND p.status = 'revealed'`,
      attendeeId,
    );
    return { answered: r?.answered ?? 0, correct: r?.correct ?? 0 };
  });
  return {
    votes,
    quiz: {
      ...quiz,
      points: ctx.points.totalFrom(attendeeId, 'polls.quiz'),
      rank: sh.quizRank.get(attendeeId) ?? null,
      players: sh.quizPlayers,
      fasterThan: sh.quizSpeed.get(attendeeId) ?? null,
    },
  };
}

function morseOf(ctx: FeatureContext, attendeeId: number, trailStamps: number): Recap['morse'] {
  return safe(ctx, 'morse', { levels: 0, decodeLevels: 0, encodeLevels: 0, bestWpm: null, trailStamps }, () => {
    const rows = all<{ mode: string; n: number; wpm: number | null }>(
      ctx.db,
      'SELECT mode, COUNT(*) AS n, MAX(best_wpm) AS wpm FROM morse_best WHERE attendee_id = ? AND best_score > 0 GROUP BY mode',
      attendeeId,
    );
    const decodeLevels = rows.find((r) => r.mode === 'decode')?.n ?? 0;
    const encodeLevels = rows.find((r) => r.mode === 'encode')?.n ?? 0;
    const wpms = rows.map((r) => r.wpm).filter((w): w is number => typeof w === 'number' && w > 0);
    return {
      levels: decodeLevels + encodeLevels,
      decodeLevels,
      encodeLevels,
      bestWpm: wpms.length ? Math.round(Math.max(...wpms) * 10) / 10 : null,
      trailStamps,
    };
  });
}

function arcadeOf(ctx: FeatureContext, attendeeId: number, sh: Shared): Recap['arcade'] {
  const bests = safe(ctx, 'arcade', [] as Recap['arcade']['bests'], () =>
    all<{ game: string; score: number; label: string; at: number }>(ctx.db, 'SELECT game, score, label, at FROM arcade_best WHERE attendee_id = ? ORDER BY game', attendeeId).map((b) => ({
      game: b.game,
      title: ARCADE_GAMES[b.game as GameId]?.title ?? b.game,
      label: b.label,
      rank:
        1 + (one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM arcade_best WHERE game = ? AND (score > ? OR (score = ? AND at < ?))', b.game, b.score, b.score, b.at)?.n ?? 0),
      players: sh.arcadePlayers.get(b.game) ?? 1,
    })),
  );
  // Puzzle-hour levels are paid once each through the ledger: source arcade-rounds.<game>, ref level:<id>.
  const levelsCleared =
    one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM points_ledger WHERE attendee_id = ? AND source LIKE 'arcade-rounds.%' AND ref LIKE 'level:%'", attendeeId)?.n ?? 0;
  return { bests, levelsCleared };
}

/** Pretty name for a puzzle-hour source, for the top moment. */
export function sourceTitle(source: string): string {
  const puzzle = source.startsWith('arcade-rounds.') ? (source.slice('arcade-rounds.'.length) as PuzzleId) : null;
  if (puzzle && PUZZLE_GAMES[puzzle]) return PUZZLE_GAMES[puzzle].title;
  const game = source.startsWith('arcade.') ? (source.slice('arcade.'.length) as GameId) : null;
  if (game && ARCADE_GAMES[game]) return ARCADE_GAMES[game].title;
  return source.split('.')[0] ?? source;
}

/** Build one attendee's recap. Throws only if the attendee does not exist. */
export function buildRecap(ctx: FeatureContext, attendeeId: number): Recap | null {
  const s = state(ctx);
  const hit = s.mine.get(attendeeId);
  if (hit && fresh(ctx, hit.at)) return hit.recap;
  const a = getAttendeeById(ctx, attendeeId);
  if (!a) return null;
  const sh = shared(ctx);
  const now = ctx.now();

  const order = 1 + (one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM attendees WHERE first_signin_at < ? OR (first_signin_at = ? AND id < ?)', a.firstSignInAt, a.firstSignInAt, a.id)?.n ?? 0);

  // Sessions: check-ins pay once each through the ledger as attendance / checkin:<activity>.
  const checkins = all<{ label: string | null }>(
    ctx.db,
    "SELECT label FROM points_ledger WHERE attendee_id = ? AND source = 'attendance' AND ref LIKE 'checkin:%' ORDER BY at",
    attendeeId,
  );
  const sessions = { count: checkins.length, titles: checkins.map((c) => (c.label ?? 'a session').replace(/^checked in:\s*/i, '')).slice(0, 8) };

  const trails = trailsOf(ctx, attendeeId, sh);
  const polls = pollsOf(ctx, attendeeId, sh);
  const morse = morseOf(ctx, attendeeId, trails.morseStamps);
  const arcade = arcadeOf(ctx, attendeeId, sh);
  const reactions = safe(ctx, 'reactions', 0, () => one<{ count: number }>(ctx.db, 'SELECT count FROM reactions_by_attendee WHERE attendee_id = ?', attendeeId)?.count ?? 0);

  // Stickers
  const unlocked = ctx.stickers.unlockedBy(attendeeId);
  const mine = sh.catalogue.filter((d) => unlocked[d.id] !== undefined);
  let rarest: Recap['stickers']['rarest'] = null;
  for (const d of mine) {
    const n = Math.max(1, sh.rarity.get(d.id) ?? 1);
    const pct = pctOf(n, sh.attendees);
    if (!rarest || pct < rarest.pct) rarest = { sticker: d, pct };
  }
  const recent = [...mine].sort((x, y) => (unlocked[y.id] ?? 0) - (unlocked[x.id] ?? 0)).slice(0, 6);

  // Standing: the board as everyone sees it (the frozen snapshot during the closing).
  const standing = safe(
    ctx,
    'standing',
    { rank: ctx.points.rankOf(attendeeId), total: ctx.points.total(attendeeId), players: ctx.points.leaderboard(0).players },
    () => {
      const b = buildBoard(ctx, { limit: 1, meId: attendeeId, peek: false });
      return { rank: b.me?.rank ?? null, total: b.me?.liveTotal ?? ctx.points.total(attendeeId), players: b.players };
    },
  );

  // Top moment: the biggest single award. Core freebies (signing in, making a face) only if nothing else.
  const top =
    one<{ source: string; points: number; label: string | null; at: number }>(
      ctx.db,
      "SELECT source, points, label, at FROM points_ledger WHERE attendee_id = ? AND points > 0 AND source NOT IN ('core', 'demo') ORDER BY points DESC, at ASC, id ASC LIMIT 1",
      attendeeId,
    ) ??
    one<{ source: string; points: number; label: string | null; at: number }>(
      ctx.db,
      'SELECT source, points, label, at FROM points_ledger WHERE attendee_id = ? AND points > 0 ORDER BY points DESC, at ASC, id ASC LIMIT 1',
      attendeeId,
    );

  const personality = derivePersonality({
    morseLevels: morse.levels,
    morseStamps: trails.morseStamps,
    huntStamps: trails.stamps - trails.morseStamps,
    checkins: sessions.count,
    arcadeGames: arcade.bests.length,
    arcadeLevels: arcade.levelsCleared,
    quizCorrect: polls.quiz.correct,
    quizFasterThan: polls.quiz.fasterThan,
    votes: polls.votes,
    reactions,
  });

  const recap: Recap = {
    attendee: { id: a.id, nickname: a.nickname ?? a.kitId, avatar: a.avatar ?? parseAvatar(null) },
    generatedAt: now,
    arrival: { at: a.firstSignInAt, order, of: sh.attendees },
    sessions,
    polls,
    trails: { stamps: trails.stamps, bonuses: trails.bonuses, list: trails.list },
    morse,
    arcade,
    reactions,
    stickers: { count: mine.length, total: sh.catalogue.length, rarest, recent },
    standing,
    topMoment: top ? { label: top.label ?? sourceTitle(top.source), points: top.points, at: top.at, source: top.source } : null,
    personality,
  };
  s.mine.set(attendeeId, { at: now, recap });
  if (s.mine.size > 2000) for (const [k, v] of s.mine) if (!fresh(ctx, v.at)) s.mine.delete(k);
  return recap;
}

// ---------------------------------------------------------------------------
// the room
// ---------------------------------------------------------------------------

const count = (ctx: FeatureContext, what: string, sql: string): number =>
  safe(ctx, what, 0, () => one<{ n: number | null }>(ctx.db, sql)?.n ?? 0);

export function roomRecap(ctx: FeatureContext): RoomRecap {
  const s = state(ctx);
  if (s.room && fresh(ctx, s.room.at)) return s.room;
  const sh = shared(ctx);
  let rarest: RoomRecap['rarest'] = null;
  for (const d of sh.catalogue) {
    const n = sh.rarity.get(d.id) ?? 0;
    if (n > 0 && (!rarest || n < rarest.count)) rarest = { sticker: d, count: n, pct: pctOf(n, sh.attendees), holders: [] };
  }
  if (rarest) {
    rarest.holders = all<{ nickname: string; avatar: string | null }>(
      ctx.db,
      `SELECT a.nickname, a.avatar FROM sticker_unlocks u JOIN attendees a ON a.id = u.attendee_id
        WHERE u.sticker_id = ? AND a.profile_complete = 1 AND a.nickname IS NOT NULL ORDER BY u.at LIMIT 6`,
      rarest.sticker.id,
    ).map((r) => ({ nickname: r.nickname, avatar: parseAvatar(r.avatar) }));
  }
  s.room = {
    attendees: sh.attendees,
    stamps: count(ctx, 'stamps', 'SELECT COUNT(*) AS n FROM hunt_progress'),
    morseLetters: count(ctx, 'morse letters', "SELECT SUM(LENGTH(word)) AS n FROM morse_rounds WHERE status = 'passed'"),
    votes: count(ctx, 'votes', 'SELECT COUNT(*) AS n FROM poll_votes'),
    reactions: count(ctx, 'reactions', 'SELECT SUM(count) AS n FROM reactions_totals'),
    checkins: count(ctx, 'checkins', 'SELECT COUNT(*) AS n FROM attendance_checkins'),
    stickers: count(ctx, 'stickers', 'SELECT COUNT(*) AS n FROM sticker_unlocks'),
    points: count(ctx, 'points', 'SELECT SUM(points) AS n FROM points_ledger'),
    rarest,
    at: ctx.now(),
  };
  return s.room;
}
