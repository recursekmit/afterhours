// Leaderboard screens (spec 5.8). The ledger is core (ctx.points); this feature shapes it for the phone and
// the projector, handles the organiser's freeze + dramatic reveal, and keeps live rank traffic small.
//
// Live traffic budget for 300 phones: core already sends one throttled 'leaderboard.changed'. We add
//  - 'leaderboard.moves': at most one per 2 s, only when the top 10 changed (a few hundred bytes to all),
//  - 'leaderboard.rank': one tiny event only to people whose own score moved their rank (never a broadcast),
// and never broadcast the whole board.
import type { LeaderboardEntry } from '@afterhours/shared';
import {
  type BoardResponse,
  BoardQuerySchema,
  type BoardRow,
  type FreezeState,
  FreezeRequestSchema,
  type HereBoard,
  type HereMe,
  type MyStanding,
  RevealRequestSchema,
  type RevealState,
} from '@afterhours/shared/features/leaderboard';
import {
  type FeatureContext,
  conflict,
  defineFeature,
  getAttendee,
  isAdmin,
  all,
  isScreen,
  one,
  parse,
  requireAdmin,
  run,
  unauthorized,
} from '../../core';

/** Never publish 'moves' more often than this. */
export const MOVES_MIN_GAP_MS = 2000;
/** Per tick cap on personal rank events, so a mass shuffle cannot flood the bus. */
export const MAX_PERSONAL_PER_TICK = 120;
const CACHE_MS = 2000;

type FullRow = Extract<BoardRow, { hidden: false }>;

interface StateRow {
  frozen: number;
  frozen_at: number | null;
  hide_top: number;
  top_n: number;
  step_ms: number;
  suspense_ms: number;
  reveal_started_at: number | null;
  snapshot: string | null;
}

interface State {
  cache: { sig: string; rows: FullRow[] } | null;
  frozen: { sig: string; rows: FullRow[] } | null; // parsed snapshot
  baseline: { ranks: Map<number, number>; totals: Map<number, number>; top: string; ledgerMax: number } | null;
  lastMovesAt: number;
  revealPublished: number;
}

const states = new WeakMap<FeatureContext, State>();
const state = (ctx: FeatureContext): State => {
  let s = states.get(ctx);
  if (!s) states.set(ctx, (s = { cache: null, frozen: null, baseline: null, lastMovesAt: 0, revealPublished: 0 }));
  return s;
};

const stateRow = (ctx: FeatureContext): StateRow =>
  one<StateRow>(ctx.db, 'SELECT * FROM leaderboard_state WHERE id = 1') ?? {
    frozen: 0,
    frozen_at: null,
    hide_top: 1,
    top_n: 10,
    step_ms: 5000,
    suspense_ms: 4000,
    reveal_started_at: null,
    snapshot: null,
  };

const ledgerMax = (ctx: FeatureContext): number => one<{ m: number | null }>(ctx.db, 'SELECT MAX(id) AS m FROM points_ledger')?.m ?? 0;

/** The live full board, in rank order, with `tied` flags. Cached: keyed on the newest ledger row + a 2 s ceiling. */
export function liveRows(ctx: FeatureContext): FullRow[] {
  const s = state(ctx);
  const sig = `${ledgerMax(ctx)}:${Math.floor(ctx.now() / CACHE_MS)}`;
  if (s.cache?.sig === sig) return s.cache.rows;
  const entries: LeaderboardEntry[] = ctx.points.leaderboard(Number.MAX_SAFE_INTEGER, null).entries;
  const rows: FullRow[] = entries.map((e, i) => ({
    hidden: false,
    rank: e.rank,
    attendeeId: e.attendeeId,
    nickname: e.nickname,
    avatar: e.avatar,
    total: e.total,
    tied: entries[i - 1]?.total === e.total || entries[i + 1]?.total === e.total,
  }));
  s.cache = { sig, rows };
  return rows;
}

function snapshotRows(ctx: FeatureContext, st: StateRow): FullRow[] {
  const s = state(ctx);
  const sig = `${st.frozen_at}`;
  if (s.frozen?.sig === sig) return s.frozen.rows;
  let rows: FullRow[];
  try {
    rows = st.snapshot ? (JSON.parse(st.snapshot) as FullRow[]) : [];
  } catch {
    rows = [];
  }
  s.frozen = { sig, rows };
  return rows;
}

/** Server time each place uncovers; index 0 is rank topN, the last is rank 1 (which waits an extra suspense beat). */
export function revealSchedule(st: Pick<StateRow, 'reveal_started_at' | 'top_n' | 'step_ms' | 'suspense_ms'>): number[] | null {
  if (st.reveal_started_at === null) return null;
  return Array.from({ length: st.top_n }, (_, i) => st.reveal_started_at! + i * st.step_ms + (i === st.top_n - 1 && st.top_n > 1 ? st.suspense_ms : 0));
}

function revealState(st: StateRow, now: number): RevealState | null {
  if (!st.frozen || !st.hide_top) return null;
  const schedule = revealSchedule(st);
  const revealed = schedule ? schedule.filter((t) => t <= now).length : 0;
  return { topN: st.top_n, stepMs: st.step_ms, suspenseMs: st.suspense_ms, startedAt: st.reveal_started_at, revealed, schedule, done: revealed >= st.top_n };
}

export function freezeState(ctx: FeatureContext): FreezeState {
  const st = stateRow(ctx);
  return { frozen: st.frozen === 1, frozenAt: st.frozen_at, hideTop: st.hide_top === 1, reveal: revealState(st, ctx.now()) };
}

/** Is this rank still covered? Rank r is uncovered once `revealed` places (from topN down) include it. */
const isCovered = (rank: number, f: FreezeState): boolean => {
  if (!f.frozen || !f.hideTop || !f.reveal || f.reveal.done) return false;
  return rank <= f.reveal.topN && rank <= f.reveal.topN - f.reveal.revealed;
};
const mask = (row: FullRow, f: FreezeState, peek: boolean): BoardRow => (!peek && isCovered(row.rank, f) ? { hidden: true, rank: row.rank } : row);

/** Build the board for one viewer. Pure given the db state; cheap (slices cached rows). */
export function buildBoard(ctx: FeatureContext, opts: { limit: number; meId: number | null; peek: boolean }): BoardResponse {
  const now = ctx.now();
  const st = stateRow(ctx);
  const freeze = freezeState(ctx);
  const source = st.frozen ? snapshotRows(ctx, st) : liveRows(ctx);
  const rows = source.slice(0, opts.limit).map((r) => mask(r, freeze, opts.peek));
  let me: MyStanding | null = null;
  if (opts.meId !== null) {
    const live = ctx.points.total(opts.meId);
    const i = source.findIndex((r) => r.attendeeId === opts.meId);
    const mine = i >= 0 ? source[i] : undefined;
    if (!mine) {
      me = { rank: null, total: live, liveTotal: live, tied: false, hiddenInTop: false, behind: null, nextNickname: null, lead: null, neighbours: [] };
    } else {
      const covered = !opts.peek && isCovered(mine.rank, freeze);
      const above = i > 0 ? source[i - 1] : undefined;
      const below = source[i + 1];
      const aboveCovered = above ? !opts.peek && isCovered(above.rank, freeze) : false;
      me = {
        rank: covered ? null : mine.rank,
        total: mine.total,
        liveTotal: live,
        tied: mine.tied,
        hiddenInTop: covered,
        behind: covered || !above ? null : above.total - mine.total,
        nextNickname: covered || !above || aboveCovered ? null : above.nickname,
        lead: covered || above || !below ? null : mine.total - below.total,
        neighbours: covered ? [] : source.slice(Math.max(0, i - 2), i + 3).map((r) => mask(r, freeze, opts.peek)),
      };
    }
  }
  return { rows, players: source.length, now, asOf: st.frozen ? (st.frozen_at ?? now) : now, freeze, me };
}

// Tick --------------------------------------------------------------------

const top10Sig = (rows: FullRow[]): string => rows.slice(0, 10).map((r) => `${r.attendeeId}:${r.total}`).join(',');

function publishFreeze(ctx: FeatureContext): void {
  ctx.live.publish('leaderboard.freeze', freezeState(ctx), 'all');
}

export function tick(ctx: FeatureContext): void {
  const s = state(ctx);
  const now = ctx.now();
  const st = stateRow(ctx);

  if (st.frozen) {
    // Reveal: the server clock uncovers one place at a time so every screen shows the same moment.
    const f = freezeState(ctx);
    if (f.reveal && f.reveal.startedAt !== null) {
      const rows = snapshotRows(ctx, st);
      while (s.revealPublished < f.reveal.revealed) {
        s.revealPublished++;
        const rank = f.reveal.topN - s.revealPublished + 1;
        const row = rows.find((r) => r.rank === rank);
        if (!row) continue;
        const done = s.revealPublished >= f.reveal.topN;
        ctx.live.publish('leaderboard.reveal', { rank, row, revealed: s.revealPublished, topN: f.reveal.topN, done }, 'all');
        if (done) {
          // Final standings are out: stickers for the top places (idempotent).
          for (const r of rows) {
            if (r.rank > f.reveal.topN) break;
            if (r.rank <= 10) ctx.stickers.unlock(r.attendeeId, 'leaderboard-top10');
            if (r.rank === 1) ctx.stickers.unlock(r.attendeeId, 'leaderboard-champ');
          }
        }
      }
    }
    s.baseline = null; // after unfreeze, re-baseline silently instead of flooding everyone with "you moved"
    return;
  }

  const max = ledgerMax(ctx);
  if (s.baseline && s.baseline.ledgerMax === max) return; // nothing new in the ledger
  const rows = liveRows(ctx);
  const ranks = new Map(rows.map((r) => [r.attendeeId, r.rank]));
  const totals = new Map(rows.map((r) => [r.attendeeId, r.total]));
  const prev = s.baseline;
  if (!prev) {
    s.baseline = { ranks, totals, top: top10Sig(rows), ledgerMax: max };
    return;
  }
  if (now - s.lastMovesAt < MOVES_MIN_GAP_MS) return; // coalesce: keep the old baseline so changes accumulate

  // Personal rank events: only people whose own total went up AND whose rank changed.
  let sent = 0;
  for (const r of rows) {
    if (sent >= MAX_PERSONAL_PER_TICK) break;
    const before = prev.ranks.get(r.attendeeId);
    const beforeTotal = prev.totals.get(r.attendeeId) ?? 0;
    if (r.total > beforeTotal && before !== r.rank) {
      const above = rows[r.rank - 2];
      ctx.live.publish(
        'leaderboard.rank',
        { rank: r.rank, previous: before ?? null, total: r.total, behind: above ? above.total - r.total : null, nextNickname: above?.nickname ?? null },
        { attendeeId: r.attendeeId },
      );
      sent++;
    }
  }

  const top = top10Sig(rows);
  if (top !== prev.top) {
    const moves: { attendeeId: number; from: number | null; to: number }[] = [];
    for (const r of rows.slice(0, 10)) {
      const from = prev.ranks.get(r.attendeeId) ?? null;
      if (from !== r.rank) moves.push({ attendeeId: r.attendeeId, from, to: r.rank });
    }
    ctx.live.publish(
      'leaderboard.moves',
      { top: rows.slice(0, 10).map((r) => ({ rank: r.rank, attendeeId: r.attendeeId, nickname: r.nickname, avatar: r.avatar, total: r.total })), moves, players: rows.length },
      'all',
    );
    s.lastMovesAt = now;
  }
  s.baseline = { ranks, totals, top, ledgerMax: max };
}

// Feature ---------------------------------------------------------------

export const leaderboard = defineFeature({
  name: 'leaderboard',
  // purge test player: rebuild the board without them
  onPurge(ctx, attendeeId) {
    const s = state(ctx);
    s.cache = null;
    run(ctx.db, 'DELETE FROM leaderboard_here WHERE attendee_id = ?', attendeeId);
  },

  stickers: [
    { id: 'leaderboard-top10', title: 'top ten', hint: 'be in the top 10 when the final reveal happens', shape: 'shield', color: 'tangerine', glyph: 'crown', feature: 'leaderboard', order: 60 },
    { id: 'leaderboard-champ', title: 'champion', hint: 'finish #1', shape: 'burst', color: 'sun', glyph: 'crown', feature: 'leaderboard', order: 61 },
  ],

  boot(ctx) {
    // After a restart in the middle of a reveal, do not replay places that already happened.
    const f = freezeState(ctx);
    state(ctx).revealPublished = f.reveal?.revealed ?? 0;
  },

  routes(app, ctx) {
    // GET /api/leaderboard?limit=10[&peek=1]   attendee (with `me`), projector, console
    app.get('/', async (req): Promise<BoardResponse> => {
      const me = getAttendee(req);
      if (!me && !isScreen(req)) throw unauthorized();
      const q = parse(BoardQuerySchema, req.query);
      const peek = isAdmin(req) && (q.peek === '1' || q.peek === 'true');
      return buildBoard(ctx, { limit: q.limit, meId: me?.attendeeId ?? null, peek });
    });

    // "Still here?" for the prizes. GET/POST /api/leaderboard/here (attendee): tap once, stays tapped.
    app.get('/here', async (req): Promise<HereMe> => {
      const me = getAttendee(req);
      if (!me) throw unauthorized();
      const r = one<{ at: number }>(ctx.db, 'SELECT at FROM leaderboard_here WHERE attendee_id = ?', me.attendeeId);
      return { here: Boolean(r), at: r?.at ?? null };
    });
    app.post('/here', async (req): Promise<HereMe> => {
      const me = getAttendee(req);
      if (!me) throw unauthorized();
      run(ctx.db, 'INSERT OR IGNORE INTO leaderboard_here (attendee_id, at) VALUES (?, ?)', me.attendeeId, ctx.now());
      const r = one<{ at: number }>(ctx.db, 'SELECT at FROM leaderboard_here WHERE attendee_id = ?', me.attendeeId);
      ctx.live.publish('leaderboard.here', { here: hereCount(ctx) }, 'all');
      return { here: true, at: r?.at ?? null };
    });
    // GET /api/leaderboard/admin/here (console): the live board, only the people who tapped "I'm here".
    app.get('/admin/here', async (req): Promise<HereBoard> => {
      requireAdmin(req);
      return hereBoard(ctx);
    });
    // POST /api/leaderboard/admin/here/clear { confirm: 'CLEAR' }: start the roll call over.
    app.post('/admin/here/clear', async (req): Promise<HereBoard> => {
      requireAdmin(req);
      if ((req.body as { confirm?: string } | null)?.confirm !== 'CLEAR') throw conflict('Send confirm: CLEAR.');
      run(ctx.db, 'DELETE FROM leaderboard_here');
      ctx.live.publish('leaderboard.here', { here: 0 }, 'all');
      return hereBoard(ctx);
    });

    // POST /api/leaderboard/admin/freeze: board stops moving for everyone; top places are covered until revealed.
    app.post('/admin/freeze', async (req): Promise<FreezeState> => {
      requireAdmin(req);
      const b = parse(FreezeRequestSchema, req.body ?? {});
      const rows = liveRows(ctx);
      const now = ctx.now();
      const topN = Math.max(1, Math.min(b.topN, rows.length || 1));
      run(
        ctx.db,
        `UPDATE leaderboard_state SET frozen = 1, frozen_at = ?, hide_top = ?, top_n = ?, step_ms = ?, suspense_ms = ?, reveal_started_at = NULL, snapshot = ? WHERE id = 1`,
        now,
        b.hideTop ? 1 : 0,
        topN,
        b.stepMs,
        b.suspenseMs,
        JSON.stringify(rows),
      );
      const s = state(ctx);
      s.frozen = null;
      s.revealPublished = 0;
      publishFreeze(ctx);
      return freezeState(ctx);
    });

    // POST /api/leaderboard/admin/reveal { restart? }: start the countdown (ranks topN..1). Needs a freeze.
    app.post('/admin/reveal', async (req): Promise<FreezeState> => {
      requireAdmin(req);
      const b = parse(RevealRequestSchema, req.body ?? {});
      const st = stateRow(ctx);
      if (!st.frozen) throw conflict('Freeze the board first.');
      if (!st.hide_top) throw conflict('This freeze has nothing covered to reveal. Unfreeze and freeze again with the top hidden.');
      if (st.reveal_started_at !== null && !b.restart) throw conflict('The reveal already started.');
      run(ctx.db, 'UPDATE leaderboard_state SET reveal_started_at = ? WHERE id = 1', ctx.now());
      state(ctx).revealPublished = 0;
      publishFreeze(ctx);
      tick(ctx); // uncover the first place right now
      return freezeState(ctx);
    });

    // POST /api/leaderboard/admin/unfreeze
    app.post('/admin/unfreeze', async (req): Promise<FreezeState> => {
      requireAdmin(req);
      run(ctx.db, 'UPDATE leaderboard_state SET frozen = 0, frozen_at = NULL, reveal_started_at = NULL, snapshot = NULL WHERE id = 1');
      const s = state(ctx);
      s.frozen = null;
      s.baseline = null;
      s.cache = null;
      s.revealPublished = 0;
      publishFreeze(ctx);
      return freezeState(ctx);
    });
  },

  tick: { everyMs: 1000, run: tick },

  seed() {
    // Nothing to seed: the board is made of everyone else's points (core crowd, attendance, arcade, ...).
  },
});

/** Used by tests and the console: who is in the top N right now (live, unmasked). */
export function topNow(ctx: FeatureContext, n = 10): FullRow[] {
  return liveRows(ctx).slice(0, n);
}

const hereCount = (ctx: FeatureContext): number => one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM leaderboard_here')?.n ?? 0;

/** Live, unmasked board filtered to the people who tapped "I'm here"; `place` is their order among them. */
export function hereBoard(ctx: FeatureContext): HereBoard {
  const here = new Map(
    all<{ attendee_id: number; at: number; roll: string | null }>(
      ctx.db,
      'SELECT h.attendee_id, h.at, a.roll FROM leaderboard_here h LEFT JOIN attendees a ON a.id = h.attendee_id',
    ).map((r) => [r.attendee_id, r]),
  );
  const live = liveRows(ctx);
  const rows = live
    .filter((r) => here.has(r.attendeeId))
    .map((r, i) => ({ place: i + 1, rank: r.rank, attendeeId: r.attendeeId, nickname: r.nickname, roll: here.get(r.attendeeId)?.roll ?? null, total: r.total, at: here.get(r.attendeeId)!.at }));
  return { rows, here: here.size, players: live.length };
}
