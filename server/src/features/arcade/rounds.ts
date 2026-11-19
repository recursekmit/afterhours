// Arcade rounds (the 7-8 PM puzzle hour): Packet Panic, Patch the Bot and Rebuild the Image.
//
// How it runs: the console releases rounds 1..4 by hand (never on a timer, so the event can run late).
// Each round adds one level per game. A player opens a level and gets an attempt, bound for good to the
// round that was current when it started; reopening the level resumes the same attempt, so a release in the
// middle of a run never swaps anyone's puzzle. Every try is replayed on the server with the shared engines.
//
// Money flows, kept apart on purpose:
//   - individual points: the core ledger, source "arcade-rounds.<game>", ref "level:<id>". One payout per
//     level per person, ever; the ledger's unique key backs that up.
//   - house standings: derived from those same ledger rows, credited to the house stored on the winning
//     attempt at the moment it paid. Players cannot change houses; an organiser reassigning someone later
//     does not move points already earned.
//   - mocktail tokens: earned per first clear at a console-set rate, spent by staff claims. Claims only
//     write arcade_claims, so they never touch points or houses.
import { randomBytes } from 'node:crypto';
import { applyPatch, runBot } from '@afterhours/shared/features/arcade-bot';
import { simulate } from '@afterhours/shared/features/arcade-net';
import { applyFlips, checkClues, netFlips } from '@afterhours/shared/features/arcade-pixels';
import {
  type Attempt,
  ClaimRequestSchema,
  type Hint,
  HintSchema,
  HouseAssignRequestSchema,
  HouseRenameRequestSchema,
  type House,
  type HouseStanding,
  type HousesResponse,
  type LevelSummary,
  PerkRequestSchema,
  type PersonLookup,
  type PuzzleId,
  ROUND_COUNT,
  RULES,
  ReleaseRoundRequestSchema,
  type RewardSettings,
  RewardSettingsRequestSchema,
  type Rewards,
  type RoundsAdmin,
  type RoundsHub,
  RoundsResetRequestSchema,
  StartAttemptRequestSchema,
  type StartAttemptResponse,
  TRY_GAP_MS,
  type TryRequest,
  TryRequestSchema,
  type TryResponse,
  worthAfter,
} from '@afterhours/shared/features/arcade-rounds';
import type { Ok } from '@afterhours/shared';
import type { FastifyInstance } from 'fastify';
import {
  type Db,
  type FeatureContext,
  HttpError,
  all,
  badRequest,
  conflict,
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
import { type Level, LEVELS, levelBody, levelById, levelPoints } from './levels';

export const ROUNDS_SOURCE = 'arcade-rounds';
const sourceOf = (game: PuzzleId) => `${ROUNDS_SOURCE}.${game}`;
const refOf = (levelId: string) => `level:${levelId}`;

interface AttemptRow {
  id: string;
  attendee_id: number;
  level_id: string;
  game: PuzzleId;
  round: number;
  scored: number;
  status: 'open' | 'won';
  tries: number;
  fails: number;
  paid: number;
  house_id: number | null;
  hint: string | null;
  last_try_at: number | null;
}

interface RoundsState {
  housesDirty: boolean;
  lastHousesAt: number;
}
const states = new WeakMap<FeatureContext, RoundsState>();
function state(ctx: FeatureContext): RoundsState {
  let s = states.get(ctx);
  if (!s) states.set(ctx, (s = { housesDirty: false, lastHousesAt: 0 }));
  return s;
}
const housesChanged = (ctx: FeatureContext) => void (state(ctx).housesDirty = true);

// ---- rounds and settings ------------------------------------------------------------------------------

export const currentRound = (db: Db): number => one<{ r: number | null }>(db, 'SELECT MAX(round) AS r FROM arcade_rounds')?.r ?? 0;
const releasedAt = (db: Db, round: number): number | null => one<{ at: number }>(db, 'SELECT released_at AS at FROM arcade_rounds WHERE round = ?', round)?.at ?? null;

const DEFAULT_REWARDS: RewardSettings = { tokensPerClear: 1, mocktailCost: 3 };
export function readRewardSettings(db: Db): RewardSettings {
  const row = one<{ value: string }>(db, "SELECT value FROM arcade_settings WHERE key = 'rewards'");
  if (!row) return DEFAULT_REWARDS;
  try {
    const j = JSON.parse(row.value) as Partial<RewardSettings>;
    return { tokensPerClear: j.tokensPerClear ?? DEFAULT_REWARDS.tokensPerClear, mocktailCost: j.mocktailCost ?? DEFAULT_REWARDS.mocktailCost };
  } catch {
    return DEFAULT_REWARDS;
  }
}

// ---- houses ----------------------------------------------------------------------------------------------

const houses = (db: Db): House[] => all<House>(db, 'SELECT id, name, tone, glyph FROM arcade_houses ORDER BY id');
export const houseOf = (db: Db, attendeeId: number): House | null =>
  one<House>(db, 'SELECT h.id, h.name, h.tone, h.glyph FROM arcade_house_members m JOIN arcade_houses h ON h.id = m.house_id WHERE m.attendee_id = ?', attendeeId) ?? null;

/**
 * Eligible arcade awards: winning attempts whose ledger row still exists. A danger-zone revoke of the ledger
 * takes the house credit and the tokens with it, so the three totals can never disagree.
 */
const ELIGIBLE = `FROM arcade_attempts a
  JOIN points_ledger l ON l.attendee_id = a.attendee_id AND l.source = '${ROUNDS_SOURCE}.' || a.game AND l.ref = 'level:' || a.level_id
  WHERE a.paid > 0`;

export function standings(db: Db): HouseStanding[] {
  const hs = houses(db);
  const pts = all<{ house_id: number; round: number; points: number; wins: number }>(
    db,
    `SELECT a.house_id, a.round, SUM(l.points) AS points, COUNT(*) AS wins ${ELIGIBLE} AND a.house_id IS NOT NULL GROUP BY a.house_id, a.round`,
  );
  const members = new Map(all<{ house_id: number; n: number }>(db, 'SELECT house_id, COUNT(*) AS n FROM arcade_house_members GROUP BY house_id').map((r) => [r.house_id, r.n]));
  const perks = all<{ house_id: number; round: number }>(db, 'SELECT house_id, round FROM arcade_perks ORDER BY round');
  const rows = hs.map((h) => {
    const mine = pts.filter((p) => p.house_id === h.id);
    const byRound = Array.from({ length: ROUND_COUNT }, (_, i) => mine.find((p) => p.round === i + 1)?.points ?? 0);
    return {
      ...h,
      members: members.get(h.id) ?? 0,
      points: mine.reduce((a, p) => a + p.points, 0),
      wins: mine.reduce((a, p) => a + p.wins, 0),
      byRound,
      perks: perks.filter((p) => p.house_id === h.id).map((p) => p.round),
      rank: 0,
    };
  });
  for (const r of rows) r.rank = 1 + rows.filter((o) => o.points > r.points).length;
  return rows;
}

// ---- rewards -----------------------------------------------------------------------------------------------

export function rewardsOf(db: Db, attendeeId: number): Rewards {
  const s = readRewardSettings(db);
  const clears = one<{ n: number }>(db, `SELECT COUNT(*) AS n ${ELIGIBLE} AND a.attendee_id = ?`, attendeeId)?.n ?? 0;
  const spent = one<{ t: number | null }>(db, 'SELECT SUM(tokens) AS t FROM arcade_claims WHERE attendee_id = ?', attendeeId)?.t ?? 0;
  const earned = clears * s.tokensPerClear;
  const kitId = one<{ kit_id: string }>(db, 'SELECT kit_id FROM attendees WHERE id = ?', attendeeId)?.kit_id ?? '';
  return { earned, spent, balance: Math.max(0, earned - spent), mocktailCost: s.mocktailCost, tokensPerClear: s.tokensPerClear, kitId };
}

function personByKit(ctx: FeatureContext, kitId: string): PersonLookup {
  const a = one<{ id: number; kit_id: string; name: string | null; nickname: string | null }>(ctx.db, 'SELECT id, kit_id, name, nickname FROM attendees WHERE kit_id = ? COLLATE NOCASE', kitId.trim());
  if (!a) throw notFound(`No attendee has signed in with kit ${kitId}.`);
  return {
    attendeeId: a.id,
    kitId: a.kit_id,
    name: a.name,
    nickname: a.nickname,
    house: houseOf(ctx.db, a.id),
    rewards: rewardsOf(ctx.db, a.id),
    claims: all<{ at: number; tokens: number }>(ctx.db, 'SELECT at, tokens FROM arcade_claims WHERE attendee_id = ? ORDER BY at DESC', a.id),
  };
}

// ---- attempts ------------------------------------------------------------------------------------------------

const ATTEMPT_ID = /^[0-9a-f]{32}$/;
function ownAttempt(ctx: FeatureContext, id: string, attendeeId: number): AttemptRow {
  const r = ATTEMPT_ID.test(id) ? one<AttemptRow>(ctx.db, 'SELECT * FROM arcade_attempts WHERE id = ? AND attendee_id = ?', id, attendeeId) : undefined;
  if (!r) throw notFound('No such attempt.');
  return r;
}

function hintAvailable(ctx: FeatureContext, r: AttemptRow): boolean {
  if (r.status !== 'open' || r.hint) return false;
  const h = houseOf(ctx.db, r.attendee_id);
  if (!h || !one(ctx.db, 'SELECT 1 AS x FROM arcade_perks WHERE house_id = ? AND round = ?', h.id, r.round)) return false;
  return !one(ctx.db, 'SELECT 1 AS x FROM arcade_hints WHERE attendee_id = ? AND round = ?', r.attendee_id, r.round);
}

function attemptView(ctx: FeatureContext, r: AttemptRow, level: Level): Attempt {
  const base = levelPoints(level);
  return {
    id: r.id,
    levelId: r.level_id,
    game: r.game,
    round: r.round,
    mode: r.scored ? 'scored' : 'replay',
    status: r.status,
    tries: r.tries,
    fails: r.fails,
    worth: r.scored && r.status === 'open' ? worthAfter(base, r.fails) : 0,
    paid: r.paid,
    hint: r.hint ? HintSchema.parse(JSON.parse(r.hint)) : null,
    hintAvailable: hintAvailable(ctx, r),
  };
}

const cleared = (ctx: FeatureContext, attendeeId: number, l: Level) => ctx.points.has(attendeeId, sourceOf(l.game), refOf(l.id));

function summary(ctx: FeatureContext, attendeeId: number, l: Level): LevelSummary {
  return {
    id: l.id,
    game: l.game,
    round: l.round,
    title: l.title,
    points: levelPoints(l),
    status: cleared(ctx, attendeeId, l) ? 'cleared' : 'new',
    inProgress: !!one(ctx.db, "SELECT 1 AS x FROM arcade_attempts WHERE attendee_id = ? AND level_id = ? AND status = 'open'", attendeeId, l.id),
  };
}

const reveal = (l: Level) => (l.game === 'pixels' ? { art: l.art, name: l.artName } : null);

/** Run one try through the shared engine. Pure: no db, no clock. */
export function judge(l: Level, plan: TryRequest['plan']): { ok: boolean; outcome: TryResponse['outcome'] } {
  if (l.game === 'packet' && plan.game === 'packet') {
    const r = simulate(l.network, plan.routes);
    return { ok: r.ok, outcome: { game: 'packet', result: { frames: r.frames, outcomes: r.outcomes } } };
  }
  if (l.game === 'patch' && plan.game === 'patch') {
    if (plan.patch.line >= l.program.length) throw badRequest('That card is not in the program.');
    const program = applyPatch(l.program, plan.patch);
    const runs = l.maps.map((m, map) => ({ map, ...runBot(program, m, l.battery) }));
    return { ok: runs.every((x) => x.ok), outcome: { game: 'patch', result: { runs } } };
  }
  if (l.game === 'pixels' && plan.game === 'pixels') {
    const p = l.puzzle;
    if (plan.taps.some(([r, c]) => r >= p.size || c >= p.size)) throw badRequest('That pixel is off the grid.');
    const flips = netFlips(plan.taps);
    const grid = applyFlips(p.start, flips);
    const check = checkClues(p, grid);
    const matches = grid.every((row, r) => row.every((on, c) => on === (l.art[r]?.[c] === '1')));
    let reason = 'picture restored';
    let ok = check.all && flips.length <= p.maxFlips && matches;
    if (p.tapBudget !== null && plan.taps.length > p.tapBudget) {
      ok = false;
      reason = `out of taps: ${plan.taps.length} used, ${p.tapBudget} allowed`;
    } else if (flips.length > p.maxFlips) reason = `you changed ${flips.length} pixels, only ${p.maxFlips} were wrong`;
    else if (!check.all) {
      const bad = [...check.rows.map((v, i) => (v ? null : `row ${i + 1}`)), ...check.cols.map((v, i) => (v ? null : `column ${String.fromCharCode(65 + i)}`)), ...check.groups.map((v, i) => (v ? null : `group ${i + 1}`))].filter(Boolean);
      reason = `${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ` and ${bad.length - 3} more` : ''} still off`;
    } else if (!matches) reason = 'every clue ticks, but that is not the picture';
    return { ok, outcome: { game: 'pixels', result: { check, flips, reason } } };
  }
  throw badRequest('That plan is for a different game.');
}

function makeHint(l: Level): Hint {
  if (l.game === 'packet') {
    // The arrow that matters most: the last packet's first decision (the one the greedy plan gets wrong).
    const [packetId, choices] = Object.entries(l.solution).at(-1)!;
    const [node, link] = Object.entries(choices)[0]!;
    return { game: 'packet', packetId, node, link };
  }
  if (l.game === 'patch') return { game: 'patch', line: l.solution.line };
  return { game: 'pixels', cell: l.wrong[l.wrong.length - 1]! };
}

// ---- routes ----------------------------------------------------------------------------------------------------

export function registerRounds(app: FastifyInstance, ctx: FeatureContext, arcadeOpen: () => boolean) {
  const db = ctx.db;

  // GET /api/arcade/rounds: released levels with my status, my house, my tokens, the rules.
  app.get('/rounds', async (req): Promise<RoundsHub> => {
    const me = requireAttendee(req);
    const round = currentRound(db);
    const released = LEVELS.filter((l) => l.round <= round);
    const levels = released.map((l) => summary(ctx, me.attendeeId, l));
    const h = houseOf(db, me.attendeeId);
    return {
      open: arcadeOpen(),
      round,
      maxRound: ROUND_COUNT,
      releasedAt: releasedAt(db, round),
      levels,
      pointsLeft: levels.filter((l) => l.status === 'new').reduce((a, l) => a + l.points, 0),
      pointsEarned: ctx.points.totalFrom(me.attendeeId, ROUNDS_SOURCE),
      house: h ? (standings(db).find((s) => s.id === h.id) ?? null) : null,
      rewards: rewardsOf(db, me.attendeeId),
      rules: RULES,
    };
  });

  // GET /api/arcade/rounds/houses: standings for phones, the projector and the console.
  app.get('/rounds/houses', async (req): Promise<HousesResponse> => {
    if (!getAttendee(req) && !isScreen(req)) throw unauthorized();
    return { houses: standings(db), round: currentRound(db), now: ctx.now() };
  });

  // POST /api/arcade/rounds/attempts { levelId }: start, or resume the open attempt on that level.
  app.post('/rounds/attempts', async (req): Promise<StartAttemptResponse> => {
    const me = requireAttendee(req);
    const { levelId } = parse(StartAttemptRequestSchema, req.body);
    const l = levelById(levelId);
    // Unreleased levels look exactly like missing ones.
    if (!l || l.round > currentRound(db)) throw notFound('No such level (yet).');
    const existing = one<AttemptRow>(db, "SELECT * FROM arcade_attempts WHERE attendee_id = ? AND level_id = ? AND status = 'open'", me.attendeeId, l.id);
    let row = existing;
    if (!row) {
      if (!arcadeOpen()) throw forbidden('The arcade is closed right now.');
      const id = randomBytes(16).toString('hex');
      run(
        db,
        'INSERT INTO arcade_attempts (id, attendee_id, level_id, game, round, scored, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        me.attendeeId,
        l.id,
        l.game,
        currentRound(db),
        cleared(ctx, me.attendeeId, l) ? 0 : 1,
        ctx.now(),
      );
      row = one<AttemptRow>(db, 'SELECT * FROM arcade_attempts WHERE id = ?', id)!;
    }
    return { attempt: attemptView(ctx, row, l), level: summary(ctx, me.attendeeId, l), body: levelBody(l), reveal: null };
  });

  // POST /api/arcade/rounds/attempts/:id/try { key, plan }: judge one Send / Run tests / Check.
  app.post('/rounds/attempts/:id/try', async (req): Promise<TryResponse> => {
    const me = requireAttendee(req);
    const body = parse(TryRequestSchema, req.body);
    const r = ownAttempt(ctx, (req.params as { id: string }).id, me.attendeeId);
    // A retried request (flaky wifi, double tap) gets the stored answer and changes nothing.
    const stored = one<{ response: string }>(db, 'SELECT response FROM arcade_tries WHERE attempt_id = ? AND key = ?', r.id, body.key);
    if (stored) return JSON.parse(stored.response) as TryResponse;
    if (r.status === 'won') throw conflict('You already cracked this one. Open the level again to replay it.');
    const l = levelById(r.level_id);
    if (!l) throw notFound('That level is gone.');
    const now = ctx.now();
    if (r.last_try_at !== null && now - r.last_try_at < TRY_GAP_MS) {
      throw new HttpError(429, 'rate_limited', 'Easy, one try at a time.', { retryAfter: 1 });
    }
    const { ok, outcome } = judge(l, body.plan);

    const res = tx(db, (): TryResponse => {
      let points = 0;
      let tokens = 0;
      if (ok) {
        let paid = 0;
        let houseId: number | null = null;
        if (r.scored) {
          const worth = worthAfter(levelPoints(l), r.fails);
          const award = ctx.points.award({ attendeeId: me.attendeeId, source: sourceOf(l.game), ref: refOf(l.id), points: worth, label: `${l.title}: cracked` });
          if (award.awarded) {
            paid = worth;
            points = worth;
            houseId = houseOf(db, me.attendeeId)?.id ?? null;
            tokens = readRewardSettings(db).tokensPerClear;
          }
        }
        run(
          db,
          "UPDATE arcade_attempts SET status = 'won', tries = tries + 1, last_try_at = ?, won_at = ?, paid = ?, house_id = ? WHERE id = ? AND status = 'open'",
          now,
          now,
          paid,
          houseId,
          r.id,
        );
      } else {
        run(db, 'UPDATE arcade_attempts SET tries = tries + 1, fails = fails + ?, last_try_at = ? WHERE id = ?', r.scored ? 1 : 0, now, r.id);
      }
      const after = one<AttemptRow>(db, 'SELECT * FROM arcade_attempts WHERE id = ?', r.id)!;
      const out: TryResponse = { ok, attempt: attemptView(ctx, after, l), points, tokens, outcome, reveal: ok ? reveal(l) : null };
      run(db, 'INSERT INTO arcade_tries (attempt_id, key, response, at) VALUES (?, ?, ?, ?)', r.id, body.key, JSON.stringify(out), now);
      return out;
    });
    if (res.points > 0) {
      housesChanged(ctx);
      ctx.stickers.unlock(me.attendeeId, 'arcade-rounds-first');
      if (l.round === ROUND_COUNT) ctx.stickers.unlock(me.attendeeId, 'arcade-rounds-hard');
    }
    return res;
  });

  // POST /api/arcade/rounds/attempts/:id/hint: spend your house's extra-hint perk for this attempt's round.
  app.post('/rounds/attempts/:id/hint', async (req): Promise<{ attempt: Attempt }> => {
    const me = requireAttendee(req);
    const r = ownAttempt(ctx, (req.params as { id: string }).id, me.attendeeId);
    const l = levelById(r.level_id);
    if (!l) throw notFound('That level is gone.');
    if (r.hint) return { attempt: attemptView(ctx, r, l) };
    if (r.status !== 'open') throw conflict('This one is already solved.');
    if (!hintAvailable(ctx, r)) throw forbidden("No hint for you this round: your house hasn't got the perk, or you've used it.");
    const hint = makeHint(l);
    tx(db, () => {
      run(db, 'INSERT INTO arcade_hints (attendee_id, round, attempt_id, at) VALUES (?, ?, ?, ?)', me.attendeeId, r.round, r.id, ctx.now());
      run(db, 'UPDATE arcade_attempts SET hint = ? WHERE id = ?', JSON.stringify(hint), r.id);
    });
    return { attempt: attemptView(ctx, one<AttemptRow>(db, 'SELECT * FROM arcade_attempts WHERE id = ?', r.id)!, l) };
  });

  // ---- console ----

  app.get('/rounds/admin', async (req): Promise<RoundsAdmin> => {
    requireAdmin(req);
    const stats = all<{ level_id: string; players: number; clears: number; tries: number }>(
      db,
      'SELECT level_id, COUNT(DISTINCT attendee_id) AS players, SUM(paid > 0) AS clears, SUM(tries) AS tries FROM arcade_attempts GROUP BY level_id',
    );
    const claims = one<{ n: number; t: number | null }>(db, 'SELECT COUNT(*) AS n, SUM(tokens) AS t FROM arcade_claims');
    return {
      open: arcadeOpen(),
      round: currentRound(db),
      maxRound: ROUND_COUNT,
      released: all<{ round: number; at: number }>(db, 'SELECT round, released_at AS at FROM arcade_rounds ORDER BY round'),
      houses: standings(db),
      unassigned: one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM attendees a WHERE NOT EXISTS (SELECT 1 FROM arcade_house_members m WHERE m.attendee_id = a.id)')?.n ?? 0,
      rewards: readRewardSettings(db),
      claims: { count: claims?.n ?? 0, tokens: claims?.t ?? 0 },
      levels: LEVELS.map((l) => {
        const s = stats.find((x) => x.level_id === l.id);
        return { id: l.id, game: l.game, round: l.round, title: l.title, players: s?.players ?? 0, clears: s?.clears ?? 0, tries: s?.tries ?? 0 };
      }),
    };
  });

  // POST /api/arcade/rounds/admin/release { round }: release the next round. Must name current + 1, so a double click can't skip one.
  app.post('/rounds/admin/release', async (req): Promise<{ round: number }> => {
    requireAdmin(req);
    const { round } = parse(ReleaseRoundRequestSchema, req.body);
    const cur = currentRound(db);
    if (round !== cur + 1) throw conflict(round <= cur ? `Round ${round} is already out.` : `Release round ${cur + 1} first.`);
    const at = ctx.now();
    run(db, 'INSERT INTO arcade_rounds (round, released_at) VALUES (?, ?)', round, at);
    ctx.live.publish('arcade.round', { round, at, titles: LEVELS.filter((l) => l.round === round).map((l) => l.title) }, 'all');
    housesChanged(ctx);
    return { round };
  });

  // POST /api/arcade/rounds/admin/perk { houseId, round }: one extra hint per member, for one round. One per house per round.
  app.post('/rounds/admin/perk', async (req): Promise<Ok> => {
    requireAdmin(req);
    const { houseId, round } = parse(PerkRequestSchema, req.body);
    const h = houses(db).find((x) => x.id === houseId);
    if (!h) throw notFound('No such house.');
    if (round < currentRound(db)) throw conflict(`Round ${round} is over. Perks are for this round or the next.`);
    const r = run(db, 'INSERT OR IGNORE INTO arcade_perks (house_id, round, granted_at) VALUES (?, ?, ?)', houseId, round, ctx.now());
    if (r.changes === 0) throw conflict(`${h.name} already has the perk for round ${round}.`);
    ctx.live.publish('arcade.perk', { houseId, house: h.name, round }, 'all');
    housesChanged(ctx);
    return { ok: true };
  });

  // POST /api/arcade/rounds/admin/houses/assign { houseId, kitIds }: put these people in this house.
  app.post('/rounds/admin/houses/assign', async (req): Promise<{ assigned: number; unknown: string[] }> => {
    requireAdmin(req);
    const b = parse(HouseAssignRequestSchema, req.body);
    if (!houses(db).some((h) => h.id === b.houseId)) throw notFound('No such house.');
    const unknown: string[] = [];
    let assigned = 0;
    tx(db, () => {
      for (const kit of b.kitIds) {
        const a = one<{ id: number }>(db, 'SELECT id FROM attendees WHERE kit_id = ? COLLATE NOCASE', kit);
        if (!a) {
          unknown.push(kit);
          continue;
        }
        run(
          db,
          'INSERT INTO arcade_house_members (attendee_id, house_id, assigned_at) VALUES (?, ?, ?) ON CONFLICT(attendee_id) DO UPDATE SET house_id = excluded.house_id, assigned_at = excluded.assigned_at',
          a.id,
          b.houseId,
          ctx.now(),
        );
        assigned++;
      }
    });
    housesChanged(ctx);
    return { assigned, unknown };
  });

  // POST /api/arcade/rounds/admin/houses/fill: everyone without a house goes to the smallest one.
  app.post('/rounds/admin/houses/fill', async (req): Promise<{ assigned: number }> => {
    requireAdmin(req);
    const assigned = fillHouses(ctx);
    housesChanged(ctx);
    return { assigned };
  });

  // POST /api/arcade/rounds/admin/houses/:id { name }
  app.post('/rounds/admin/houses/:id', async (req): Promise<Ok> => {
    requireAdmin(req);
    const { name } = parse(HouseRenameRequestSchema, req.body);
    const r = run(db, 'UPDATE arcade_houses SET name = ? WHERE id = ?', name, Number((req.params as { id: string }).id));
    if (r.changes === 0) throw notFound('No such house.');
    housesChanged(ctx);
    return { ok: true };
  });

  // POST /api/arcade/rounds/admin/rewards { tokensPerClear?, mocktailCost? }: the exchange rate, decided on the day.
  app.post('/rounds/admin/rewards', async (req): Promise<RewardSettings> => {
    requireAdmin(req);
    const b = parse(RewardSettingsRequestSchema, req.body);
    const next = { ...readRewardSettings(db), ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) } as RewardSettings;
    run(db, "INSERT INTO arcade_settings (key, value) VALUES ('rewards', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(next));
    return next;
  });

  // GET /api/arcade/rounds/admin/person?kit=AH-001: balance and claims, for the bar.
  app.get('/rounds/admin/person', async (req): Promise<PersonLookup> => {
    requireAdmin(req);
    const kit = String((req.query as { kit?: string }).kit ?? '').slice(0, 20);
    if (!kit) throw badRequest('Which kit?');
    return personByKit(ctx, kit);
  });

  // POST /api/arcade/rounds/admin/claim { kitId, key }: hand over one mocktail. Spends tokens, nothing else.
  app.post('/rounds/admin/claim', async (req): Promise<{ duplicate: boolean; person: PersonLookup }> => {
    requireAdmin(req);
    const b = parse(ClaimRequestSchema, req.body);
    const person = personByKit(ctx, b.kitId);
    const duplicate = tx(db, () => {
      const prev = one<{ attendee_id: number }>(db, 'SELECT attendee_id FROM arcade_claims WHERE key = ?', b.key);
      if (prev) {
        if (prev.attendee_id !== person.attendeeId) throw conflict('That claim key belongs to someone else. Refresh and try again.');
        return true;
      }
      const fresh = rewardsOf(db, person.attendeeId);
      if (fresh.balance < fresh.mocktailCost) throw conflict(`Not enough tokens: ${fresh.balance} of ${fresh.mocktailCost}.`);
      run(db, 'INSERT INTO arcade_claims (key, attendee_id, tokens, at) VALUES (?, ?, ?, ?)', b.key, person.attendeeId, fresh.mocktailCost, ctx.now());
      return false;
    });
    return { duplicate, person: personByKit(ctx, b.kitId) };
  });

  // POST /api/arcade/rounds/admin/reset { confirm: 'RESET ROUNDS' }: rehearsal wipe. Keeps houses, members and the exchange rate.
  app.post('/rounds/admin/reset', async (req): Promise<Ok> => {
    requireAdmin(req);
    parse(RoundsResetRequestSchema, req.body);
    tx(db, () => {
      for (const t of ['arcade_tries', 'arcade_hints', 'arcade_perks', 'arcade_claims', 'arcade_attempts', 'arcade_rounds']) run(db, `DELETE FROM ${t}`);
      ctx.points.revokeSource(ROUNDS_SOURCE);
    });
    ctx.points.invalidate();
    housesChanged(ctx);
    return { ok: true };
  });
}

/** Everyone without a house joins the smallest house (lowest id on ties), in sign-in order. */
export function fillHouses(ctx: FeatureContext): number {
  const counts = new Map(houses(ctx.db).map((h) => [h.id, 0]));
  for (const r of all<{ house_id: number; n: number }>(ctx.db, 'SELECT house_id, COUNT(*) AS n FROM arcade_house_members GROUP BY house_id')) counts.set(r.house_id, r.n);
  const todo = all<{ id: number }>(ctx.db, 'SELECT id FROM attendees a WHERE NOT EXISTS (SELECT 1 FROM arcade_house_members m WHERE m.attendee_id = a.id) ORDER BY id');
  tx(ctx.db, () => {
    for (const a of todo) {
      const [houseId] = [...counts.entries()].sort((x, y) => x[1] - y[1] || x[0] - y[0])[0]!;
      run(ctx.db, 'INSERT INTO arcade_house_members (attendee_id, house_id, assigned_at) VALUES (?, ?, ?)', a.id, houseId, ctx.now());
      counts.set(houseId, (counts.get(houseId) ?? 0) + 1);
    }
  });
  return todo.length;
}

/** From the arcade tick: tell everyone the house standings moved, at most every 2 s. */
export function roundsTick(ctx: FeatureContext): void {
  const s = state(ctx);
  const now = ctx.now();
  if (s.housesDirty && now - s.lastHousesAt >= 2000) {
    s.housesDirty = false;
    s.lastHousesAt = now;
    ctx.live.publish('arcade.houses', { at: now }, 'all');
  }
}

