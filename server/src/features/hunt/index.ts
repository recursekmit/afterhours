// Trails (spec 5.5, generalised): the treasure hunt is trail 1; Morse trails and any other trail the
// organisers create run on the same engine. Stops are riddle, scan, morse or slip (docs/SLIPS.md).
// Trails are shuffled (fixed finale), fixed, or a graph where exits and slip readings pick the path.
//
// Routes (all under /api/hunt). `?trail=` picks the trail and defaults to 1, so the original hunt API
// keeps working unchanged.
//   attendee: GET /trails, GET /?trail=, POST /start {trailId?}, POST /scan {code, trailId?},
//             POST /answer, POST /hint, POST /slip
//   attendee|screen|admin: GET /board?trail=
//   admin: GET|POST /admin/trails, PUT /admin/trails/:id, GET /admin?trail=, PUT /admin/state?trail=,
//          POST /admin/stops?trail=, PUT|DELETE /admin/stops/:id, POST /admin/stops/:id/rotate-token,
//          PUT /admin/order?trail=, GET /admin/stickers?trail=, GET /admin/cards?trail=,
//          GET /admin/progress?trail=, GET /admin/graph?trail=, POST /admin/reset?trail=,
//          GET|POST /admin/slip-sets?trail=, POST /admin/slip-sets/:id/slips, PUT|DELETE /admin/slips/:id,
//          GET /admin/slip-print?set=,
//          unique sets: GET|POST /admin/slip-sets/:id/copies, PUT /admin/slip-sets/:id/mode,
//          POST /admin/slip-copies/:id/release, GET /admin/slip-sets/:id/answer-key.csv
import {
  HuntAdminOrderRequestSchema,
  HuntAdminResetRequestSchema,
  HuntAdminStateRequestSchema,
  type HuntAdmin,
  type HuntAdminProgress,
  type HuntAdminStop,
  type HuntAttemptResult,
  HuntAnswerRequestSchema,
  type HuntBoard,
  HuntHintRequestSchema,
  type HuntHintResult,
  type HuntMe,
  HuntSlipRequestSchema,
  type HuntSlipResult,
  type HuntStickerSheet,
  HuntStopInputSchema,
  type MorseCardSheet,
  type SlipCopies,
  SlipCopiesRequestSchema,
  SlipInputSchema,
  type SlipPrintSheet,
  SlipSetModeRequestSchema,
  SlipSetInputSchema,
  type SlipSetList,
  TREASURE_TRAIL_ID,
  type TrailAdminList,
  TrailCreateRequestSchema,
  type TrailGraph,
  type TrailList,
  TrailUpdateRequestSchema,
  formatHuntCode,
  huntScanUrl,
  isMorseWord,
  morseCardPatterns,
  morseWordOf,
  normaliseAnswer,
  slipMorseKey,
  slipWordKey,
} from '@afterhours/shared/features/hunt';
import { z } from 'zod';
import {
  type FeatureContext,
  all,
  badRequest,
  conflict,
  defineFeature,
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
  HUNT_SOURCE,
  type Stop,
  type Trail,
  answer,
  buildBoard,
  buildMe,
  bump,
  crowdOf,
  ensureKitWords,
  finishRef,
  getTrail,
  listTrails,
  loadStops,
  newCode,
  newSeed,
  newToken,
  orderFor,
  revealHint,
  runtime,
  scan,
  startHunt,
  stopCount,
  submitSlip,
  trailSettings,
  trailTotal,
} from './engine';
import { answerKeyCsv, checkUniqueReadings, claimedCount, convertToUnique, copiesView, copyEdges, getSet, releaseCopy, releaseTrail, syncCopies } from './unique';
import { seedHunt } from './seed';

export const huntStickers = [
  { id: 'hunt-first-stamp', title: 'first stamp', hint: 'collect your first hunt stamp', shape: 'ticket', color: 'lime', glyph: 'map', feature: 'hunt', order: 60 },
  { id: 'hunt-finisher', title: 'hunt done', hint: 'find every stop on the hunt', shape: 'star', color: 'tangerine', glyph: 'flag', feature: 'hunt', order: 61 },
  { id: 'hunt-podium', title: 'top three', hint: 'finish the hunt in the first three', shape: 'burst', color: 'sun', glyph: 'crown', feature: 'hunt', order: 62 },
  { id: 'hunt-clean', title: 'no peeking', hint: 'finish the hunt without a single hint', shape: 'shield', color: 'sky', glyph: 'eye', feature: 'hunt', order: 63 },
  { id: 'trail-morse-first', title: 'dot found', hint: 'decode a morse message hidden around the venue', shape: 'circle', color: 'sky', glyph: 'wave', feature: 'hunt', order: 64 },
  { id: 'trail-morse-done', title: 'wire walker', hint: 'finish a morse trail', shape: 'burst', color: 'grape', glyph: 'bolt', feature: 'hunt', order: 65 },
] as const;

const IdParam = z.object({ id: z.coerce.number().int().positive() });
const TrailQuery = z.object({ trail: z.coerce.number().int().positive().default(TREASURE_TRAIL_ID) });
const StartBody = z.object({ trailId: z.number().int().positive().optional() }).default({});
const ScanBody = z.object({ code: z.string().min(1).max(300), trailId: z.number().int().positive().optional() });
const SetQuery = z.object({ set: z.coerce.number().int().positive() });

const trailOf = (req: { query: unknown }): number => parse(TrailQuery, req.query ?? {}).trail;

function stopToAdmin(ctx: FeatureContext, s: Stop, finale: boolean): HuntAdminStop {
  const cache = crowdOf(ctx, s.trailId);
  return {
    id: s.id,
    trailId: s.trailId,
    position: s.position,
    isFinal: finale,
    challenge: s.challenge,
    requireScan: s.requireScan,
    onlineFallback: s.onlineFallback,
    slipId: s.slipId,
    nextStopId: s.nextStopId,
    finale: s.finale,
    title: s.title,
    clue: s.clue,
    clueImage: s.clueImage,
    answers: s.answers,
    hints: s.hints,
    points: s.points,
    glyph: s.glyph as HuntAdminStop['glyph'],
    color: s.color as HuntAdminStop['color'],
    reveal: s.reveal,
    location: s.location,
    token: s.token,
    code: formatHuntCode(s.code),
    url: huntScanUrl(ctx.config.appUrl, s.token),
    solvedBy: cache.solvedBy.get(s.id) ?? 0,
    hereNow: cache.here.get(s.id) ?? 0,
  };
}

function playerCount(ctx: FeatureContext, trailId: number): number {
  return one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM hunt_players WHERE trail_id = ?', trailId)?.n ?? 0;
}

function buildAdmin(ctx: FeatureContext, trailId: number): HuntAdmin {
  const trail = getTrail(ctx, trailId);
  const stops = loadStops(ctx, trailId);
  const crowd = crowdOf(ctx, trailId).crowd;
  return {
    trail: trailSettings(trail),
    status: trail.status,
    title: trail.title,
    openedAt: trail.openedAt,
    closedAt: trail.closedAt,
    stops: stops.map((s, i) => stopToAdmin(ctx, s, trail.orderMode === 'graph' ? s.finale : i === stops.length - 1)),
    players: crowd.players,
    finished: crowd.finished,
    structureLocked: playerCount(ctx, trailId) > 0,
    serverNow: ctx.now(),
  };
}

function publishState(ctx: FeatureContext, trailId: number): void {
  const t = getTrail(ctx, trailId);
  ctx.live.publish('hunt.state', { trailId, status: t.status, title: t.title, total: trailTotal(t, stopCount(ctx, trailId)) }, 'all');
}

/** Answers must contain letters or digits to be matchable; duplicates (after normalising) are dropped. */
function cleanAnswers(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of list) {
    const n = normaliseAnswer(a);
    if (n.length === 0) throw badRequest(`"${a}" has no letters or numbers to match. Spell it out (";" becomes "semicolon").`);
    if (!seen.has(n)) {
      seen.add(n);
      out.push(a);
    }
  }
  return out;
}

function requireUnlockedStructure(ctx: FeatureContext, trailId: number): void {
  if (playerCount(ctx, trailId) > 0) throw conflict('People already started. Reset the trail before adding, removing or reordering stops.');
}

type StopInput = z.output<typeof HuntStopInputSchema>;

/** Validate a stop against its trail and work out its challenge type. */
function normaliseStop(ctx: FeatureContext, trailId: number, input: StopInput, selfId: number | null) {
  const answers = cleanAnswers(input.answers);
  const challenge = input.challenge ?? (input.slipId !== null ? 'slip' : answers.length > 0 ? 'riddle' : 'scan');
  if (challenge === 'riddle' && answers.length === 0) throw badRequest('A riddle stop needs at least one answer.');
  if (challenge === 'morse') {
    if (answers.length !== 1) throw badRequest('A morse stop has exactly one answer: the word the Morse spells.');
    if (!isMorseWord(answers[0] as string)) throw badRequest('Morse words can only use letters and digits.');
  }
  if (challenge === 'slip') {
    if (input.slipId === null) throw badRequest('Pick the slip for this stop.');
    const slip = one<{ trail_id: number }>(ctx.db, 'SELECT ss.trail_id FROM hunt_slips s JOIN hunt_slip_sets ss ON ss.id = s.set_id WHERE s.id = ?', input.slipId);
    if (!slip) throw badRequest('No such slip.');
  }
  if (input.nextStopId !== null) {
    if (input.nextStopId === selfId) throw badRequest('A stop cannot lead to itself.');
    if (!one(ctx.db, 'SELECT 1 AS x FROM hunt_stops WHERE id = ? AND trail_id = ?', input.nextStopId, trailId)) throw badRequest('The next stop must be on the same trail.');
  }
  return { ...input, answers, challenge, onlineFallback: challenge === 'morse' && input.onlineFallback, requireScan: challenge !== 'scan' && challenge !== 'slip' && input.requireScan };
}

function insertStop(ctx: FeatureContext, trailId: number, input: StopInput): number {
  const s = normaliseStop(ctx, trailId, input, null);
  const pos = (one<{ m: number | null }>(ctx.db, 'SELECT MAX(position) AS m FROM hunt_stops WHERE trail_id = ?', trailId)?.m ?? 0) + 1;
  return run(
    ctx.db,
    `INSERT INTO hunt_stops (trail_id, position, title, clue, clue_image, challenge, require_scan, online_fallback, slip_id, next_stop_id, is_finale,
                             answers, hints, points, glyph, color, reveal, location, token, code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    trailId,
    pos,
    s.title,
    s.clue,
    s.clueImage,
    s.challenge,
    s.requireScan ? 1 : 0,
    s.onlineFallback ? 1 : 0,
    s.slipId,
    s.nextStopId,
    s.finale ? 1 : 0,
    JSON.stringify(s.answers),
    JSON.stringify(s.hints),
    s.points,
    s.glyph,
    s.color,
    s.reveal,
    s.location,
    newToken(),
    newCode(ctx),
  ).lastId;
}

function stopTrail(ctx: FeatureContext, stopId: number): number {
  const r = one<{ trail_id: number }>(ctx.db, 'SELECT trail_id FROM hunt_stops WHERE id = ?', stopId);
  if (!r) throw notFound('No such stop.');
  return r.trail_id;
}

/** Ledger refs a trail pays out (stamps, finish bonuses, slip bonuses on its slips). */
function trailRefs(ctx: FeatureContext, trail: Trail): string[] {
  const stops = loadStops(ctx, trail.id).map((s) => `stop:${s.id}`);
  const slipBonus = all<{ id: number }>(
    ctx.db,
    'SELECT r.id FROM hunt_slip_readings r JOIN hunt_slips s ON s.id = r.slip_id JOIN hunt_slip_sets ss ON ss.id = s.set_id WHERE ss.trail_id = ?',
    trail.id,
  ).map((r) => `slip:${r.id}`);
  return [...stops, finishRef(trail, 'rank'), finishRef(trail, 'speed'), ...slipBonus];
}

// ---- slips (console) ----

function slipSets(ctx: FeatureContext, trailId: number): SlipSetList {
  const finds = new Map(all<{ reading_id: number; n: number }>(ctx.db, 'SELECT reading_id, COUNT(*) AS n FROM hunt_slip_finds GROUP BY reading_id').map((r) => [r.reading_id, r.n]));
  return {
    sets: all<{ id: number; trail_id: number; title: string; mode: 'shared' | 'per_kit' | 'unique'; word_pool: string; copies: number }>(
      ctx.db,
      'SELECT * FROM hunt_slip_sets WHERE trail_id = ? ORDER BY id',
      trailId,
    ).map(
      (st) => ({
        id: st.id,
        trailId: st.trail_id,
        title: st.title,
        mode: st.mode,
        pool: JSON.parse(st.word_pool) as string[],
        copies: st.mode === 'unique' ? st.copies : 0,
        claimed: st.mode === 'unique' ? claimedCount(ctx, st.id) : 0,
        slips: all<{ id: number; slip_no: number; label: string }>(ctx.db, 'SELECT * FROM hunt_slips WHERE set_id = ? ORDER BY slip_no, id', st.id).map((sl) => ({
          id: sl.id,
          slipNo: sl.slip_no,
          label: sl.label,
          readings: all<{
            id: number;
            orientation: 'bottom' | 'right' | 'top' | 'left' | 'extra';
            word: string | null;
            morse: string | null;
            outcome: 'next' | 'branch' | 'clue' | 'bonus' | 'decoy';
            target_stop_id: number | null;
            target_trail_id: number | null;
            clue: string;
            bonus_points: number;
            message: string;
          }>(ctx.db, 'SELECT * FROM hunt_slip_readings WHERE slip_id = ? ORDER BY id', sl.id).map((r) => ({
            id: r.id,
            orientation: r.orientation,
            word: r.word,
            morse: r.morse ?? (r.word ? slipWordKey(r.word) : null),
            outcome: r.outcome,
            targetStopId: r.target_stop_id,
            targetTrailId: r.target_trail_id,
            clue: r.clue,
            bonusPoints: r.bonus_points,
            message: r.message,
            finds: finds.get(r.id) ?? 0,
          })),
        })),
      }),
    ),
  };
}

export function writeSlip(ctx: FeatureContext, setId: number, slipId: number | null, input: z.output<typeof SlipInputSchema>): number {
  const set = one<{ trail_id: number; mode: string }>(ctx.db, 'SELECT trail_id, mode FROM hunt_slip_sets WHERE id = ?', setId);
  if (!set) throw notFound('No such slip set.');
  if (set.mode === 'unique') checkUniqueReadings(input.readings);
  for (const r of input.readings) {
    if (set.mode === 'shared' && r.word === null && r.morse === null) throw badRequest(`The ${r.orientation} edge needs a word (or a sequence).`);
    if ((r.outcome === 'next' || r.outcome === 'branch') && r.targetStopId !== null && !one(ctx.db, 'SELECT 1 AS x FROM hunt_stops WHERE id = ? AND trail_id = ?', r.targetStopId, set.trail_id)) {
      throw badRequest('Readings can only point at stops on the same trail.');
    }
    if (r.outcome === 'branch' && r.targetStopId === null && (r.targetTrailId === null || !one(ctx.db, 'SELECT 1 AS x FROM hunt_trails WHERE id = ?', r.targetTrailId))) {
      throw badRequest('A branch needs a target stop or another trail.');
    }
  }
  const keys = input.readings.map((r) => (r.morse ? slipMorseKey(r.morse) : r.word ? slipWordKey(r.word) : null)).filter((k): k is string => k !== null);
  if (new Set(keys).size !== keys.length) throw badRequest('Two edges of one slip read the same. Give each edge its own word.');
  return tx(ctx.db, () => {
    let id = slipId;
    if (id === null) id = run(ctx.db, 'INSERT INTO hunt_slips (set_id, slip_no, label) VALUES (?, ?, ?)', setId, input.slipNo, input.label).lastId;
    else run(ctx.db, 'UPDATE hunt_slips SET slip_no = ?, label = ? WHERE id = ?', input.slipNo, input.label, id);
    // Readings are updated in place per orientation (not deleted and re-added), so their ids, finds,
    // bonus refs and the words printed on per-kit and unique copies all survive an edit of the outcomes.
    const old = all<{ id: number; orientation: string }>(ctx.db, 'SELECT id, orientation FROM hunt_slip_readings WHERE slip_id = ? ORDER BY id', id);
    const used = new Set<number>();
    for (const r of input.readings) {
      const prev = old.find((o) => o.orientation === r.orientation && !used.has(o.id));
      const values = [
        r.word ? morseWordOf(r.word) : null,
        r.morse ? slipMorseKey(r.morse) : null,
        r.outcome,
        r.targetStopId,
        r.targetTrailId,
        r.clue,
        r.bonusPoints,
        r.message,
      ] as const;
      if (prev) {
        used.add(prev.id);
        run(ctx.db, 'UPDATE hunt_slip_readings SET word = ?, morse = ?, outcome = ?, target_stop_id = ?, target_trail_id = ?, clue = ?, bonus_points = ?, message = ? WHERE id = ?', ...values, prev.id);
      } else {
        run(
          ctx.db,
          `INSERT INTO hunt_slip_readings (slip_id, orientation, word, morse, outcome, target_stop_id, target_trail_id, clue, bonus_points, message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          r.orientation,
          ...values,
        );
      }
    }
    for (const o of old) if (!used.has(o.id)) run(ctx.db, 'DELETE FROM hunt_slip_readings WHERE id = ?', o.id);
    // per-kit draws stay valid only for readings that still draw from the pool
    run(ctx.db, 'DELETE FROM hunt_kit_slip_words WHERE reading_id IN (SELECT id FROM hunt_slip_readings WHERE slip_id = ? AND (word IS NOT NULL OR morse IS NOT NULL))', id);
    // unique sets: copies for a new slip, words for new edges (printed copies keep theirs)
    if (set.mode === 'unique') syncCopies(ctx, setId);
    return id;
  });
}

function slipPrint(ctx: FeatureContext, setId: number): SlipPrintSheet {
  const set = getSet(ctx, setId);
  const slips = all<{ id: number; slip_no: number; label: string }>(ctx.db, 'SELECT * FROM hunt_slips WHERE set_id = ? ORDER BY slip_no, id', setId);
  if (set.mode === 'unique') {
    // every copy in serial order, slips 1..n of one serial together (a kit's matching trio)
    const copies = all<{ id: number; slip_id: number; serial: number }>(
      ctx.db,
      'SELECT c.id, c.slip_id, c.serial FROM hunt_slip_copies c JOIN hunt_slips s ON s.id = c.slip_id WHERE s.set_id = ? ORDER BY c.serial, s.slip_no, s.id',
      setId,
    );
    const bySlip = new Map(slips.map((sl) => [sl.id, sl]));
    return {
      setId: set.id,
      title: set.title,
      mode: set.mode,
      slips: copies.map((c) => {
        const sl = bySlip.get(c.slip_id) as { slip_no: number; label: string };
        const { edges } = copyEdges(ctx, c.id, c.slip_id);
        const edge = (e: 'bottom' | 'right' | 'top' | 'left') => {
          const w = edges[e];
          return w ? { word: w, morse: slipWordKey(w) } : null;
        };
        return { slipNo: sl.slip_no, label: sl.label, kitId: null, serial: c.serial, edges: { bottom: edge('bottom'), right: edge('right'), top: edge('top'), left: edge('left') } };
      }),
    };
  }
  const kits = set.mode === 'per_kit' ? all<{ id: string }>(ctx.db, 'SELECT id FROM kits ORDER BY id').map((k) => k.id) : [null];
  const out: SlipPrintSheet['slips'] = [];
  for (const kitId of kits) {
    const kw = kitId ? ensureKitWords(ctx, kitId, setId) : new Map<number, { word: string; morse: string }>();
    for (const sl of slips) {
      const edges: SlipPrintSheet['slips'][number]['edges'] = { bottom: null, right: null, top: null, left: null };
      for (const r of all<{ id: number; orientation: string; word: string | null }>(ctx.db, "SELECT id, orientation, word FROM hunt_slip_readings WHERE slip_id = ? AND orientation != 'extra'", sl.id)) {
        const word = r.word ?? kw.get(r.id)?.word ?? null;
        if (word) edges[r.orientation as 'bottom' | 'right' | 'top' | 'left'] = { word, morse: slipWordKey(word) };
      }
      out.push({ slipNo: sl.slip_no, label: sl.label, kitId, serial: null, edges });
    }
  }
  return { setId: set.id, title: set.title, mode: set.mode, slips: out };
}

function trailGraph(ctx: FeatureContext, trailId: number): TrailGraph {
  const trail = getTrail(ctx, trailId);
  const stops = loadStops(ctx, trailId);
  const cache = crowdOf(ctx, trailId);
  const sets = slipSets(ctx, trailId);
  const readingsBySlip = new Map(sets.sets.flatMap((st) => st.slips.map((sl) => [sl.id, sl.readings] as const)));
  const unique = new Set(sets.sets.filter((st) => st.mode === 'unique').flatMap((st) => st.slips.map((sl) => sl.id)));
  const edges: TrailGraph['edges'] = [];
  const linear = trail.orderMode !== 'graph';
  stops.forEach((s, i) => {
    if (s.challenge === 'slip' && s.slipId !== null) {
      for (const r of readingsBySlip.get(s.slipId) ?? []) {
        edges.push({
          from: s.id,
          to: r.outcome === 'next' || r.outcome === 'branch' ? (r.targetStopId ?? (linear ? (stops[i + 1]?.id ?? null) : null)) : null,
          toTrailId: r.targetTrailId,
          kind: 'reading',
          label: `${r.orientation}: ${r.word ?? (r.morse ? 'sequence' : unique.has(s.slipId) ? (r.orientation === 'extra' ? 'upside-down top' : 'word per copy') : 'per-kit word')} (${r.outcome})`,
          readingId: r.id,
          outcome: r.outcome,
          count: r.finds,
        });
      }
    }
    const exit = linear ? (stops[i + 1]?.id ?? null) : s.nextStopId;
    if (exit !== null && s.challenge !== 'slip') edges.push({ from: s.id, to: exit, toTrailId: null, kind: 'exit', label: 'stamped', readingId: null, outcome: null, count: cache.solvedBy.get(s.id) ?? 0 });
  });
  const leaves = stops.filter((s) => !edges.some((e) => e.from === s.id && (e.to !== null || e.toTrailId !== null)));
  const deadEnds = linear ? [] : leaves.filter((s) => !s.finale).map((s) => s.id);
  return {
    trailId,
    nodes: stops.map((s, i) => ({
      stopId: s.id,
      title: s.title,
      challenge: s.challenge,
      start: i === 0,
      finale: linear ? i === stops.length - 1 : s.finale,
      hereNow: cache.here.get(s.id) ?? 0,
      solvedBy: cache.solvedBy.get(s.id) ?? 0,
    })),
    edges,
    deadEnds,
  };
}

export const hunt = defineFeature({
  name: 'hunt',
  stickers: [...huntStickers],

  routes(app, ctx) {
    // ---------- attendee ----------

    // GET /api/hunt/trails  -> TrailList (open and closed trails, with my progress)
    app.get('/trails', async (req): Promise<TrailList> => {
      const me = requireAttendee(req);
      const trails = listTrails(ctx).filter((t) => t.status !== 'draft');
      return {
        serverNow: ctx.now(),
        trails: trails.map((t) => {
          const p = one<{ finish_rank: number | null }>(ctx.db, 'SELECT finish_rank FROM hunt_players WHERE trail_id = ? AND attendee_id = ?', t.id, me.attendeeId);
          const solved =
            one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM hunt_progress p JOIN hunt_stops s ON s.id = p.stop_id WHERE p.attendee_id = ? AND s.trail_id = ?', me.attendeeId, t.id)?.n ?? 0;
          const c = crowdOf(ctx, t.id).crowd;
          return { id: t.id, kind: t.kind, title: t.title, status: t.status, total: trailTotal(t, stopCount(ctx, t.id)), started: Boolean(p), solved, finishedRank: p?.finish_rank ?? null, hunting: c.hunting, finished: c.finished };
        }),
      };
    });

    // GET /api/hunt?trail=  -> HuntMe
    app.get('/', async (req): Promise<HuntMe> => {
      const me = requireAttendee(req);
      return buildMe(ctx, me.attendeeId, trailOf(req));
    });

    // POST /api/hunt/start { trailId? }  -> HuntMe (starts the clock; repeating it changes nothing)
    app.post('/start', async (req): Promise<HuntMe> => {
      const me = requireAttendee(req);
      const b = parse(StartBody, req.body ?? {});
      return startHunt(ctx, me.attendeeId, b.trailId ?? TREASURE_TRAIL_ID);
    });

    // POST /api/hunt/scan { code, trailId? }  -> HuntAttemptResult (the trail comes from the sticker)
    app.post('/scan', async (req): Promise<HuntAttemptResult> => {
      const me = requireAttendee(req);
      const b = parse(ScanBody, req.body);
      return scan(ctx, me.attendeeId, b.code, b.trailId);
    });

    // POST /api/hunt/answer { stopId, answer }  -> HuntAttemptResult
    app.post('/answer', async (req): Promise<HuntAttemptResult> => {
      const me = requireAttendee(req);
      const body = parse(HuntAnswerRequestSchema, req.body);
      return answer(ctx, me.attendeeId, body.stopId, body.answer);
    });

    // POST /api/hunt/hint { stopId, n }  -> HuntHintResult
    app.post('/hint', async (req): Promise<HuntHintResult> => {
      const me = requireAttendee(req);
      const body = parse(HuntHintRequestSchema, req.body);
      return revealHint(ctx, me.attendeeId, body.stopId, body.n);
    });

    // POST /api/hunt/slip { stopId, text?, morse? }  -> HuntSlipResult
    app.post('/slip', async (req): Promise<HuntSlipResult> => {
      const me = requireAttendee(req);
      const body = parse(HuntSlipRequestSchema, req.body);
      return submitSlip(ctx, me.attendeeId, body.stopId, body);
    });

    // GET /api/hunt/board?trail= (attendee, projector or console)  -> HuntBoard
    app.get('/board', async (req): Promise<HuntBoard> => {
      if (!getAttendee(req) && !isScreen(req)) throw unauthorized('Sign in first.');
      return buildBoard(ctx, trailOf(req));
    });

    // ---------- console: trails ----------

    app.get('/admin/trails', async (req): Promise<TrailAdminList> => {
      requireAdmin(req);
      return {
        trails: listTrails(ctx).map((t) => {
          const c = crowdOf(ctx, t.id).crowd;
          return { ...trailSettings(t), stops: stopCount(ctx, t.id), players: c.players, finished: c.finished };
        }),
      };
    });

    app.post('/admin/trails', async (req): Promise<HuntAdmin> => {
      requireAdmin(req);
      const b = parse(TrailCreateRequestSchema, req.body);
      const pos = (one<{ m: number | null }>(ctx.db, 'SELECT MAX(position) AS m FROM hunt_trails')?.m ?? 0) + 1;
      const id = run(
        ctx.db,
        'INSERT INTO hunt_trails (position, kind, title, order_mode, hints_on, cooldown_on, subset_k, shuffle_seed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        pos,
        b.kind,
        b.title,
        b.orderMode,
        b.hintsOn ? 1 : 0,
        b.cooldownOn ? 1 : 0,
        b.orderMode === 'graph' ? 0 : b.subsetK,
        newSeed(),
      ).lastId;
      bump(ctx, id);
      return buildAdmin(ctx, id);
    });

    app.put('/admin/trails/:id', async (req): Promise<HuntAdmin> => {
      requireAdmin(req);
      const { id } = parse(IdParam, req.params);
      const b = parse(TrailUpdateRequestSchema, req.body);
      const t = getTrail(ctx, id);
      if (b.orderMode !== undefined && b.orderMode !== t.orderMode) requireUnlockedStructure(ctx, id);
      // K of M changes who walks which stops: only before anyone starts
      if (b.subsetK !== undefined && b.subsetK !== t.subsetK) requireUnlockedStructure(ctx, id);
      const orderMode = b.orderMode ?? t.orderMode;
      const subsetK = b.subsetK ?? t.subsetK;
      if (orderMode === 'graph' && subsetK > 0 && b.subsetK !== undefined) throw badRequest('Graph trails pick their path through exits. "K of the M stops" is for shuffled and fixed trails.');
      run(
        ctx.db,
        'UPDATE hunt_trails SET title = ?, kind = ?, order_mode = ?, hints_on = ?, cooldown_on = ?, subset_k = ? WHERE id = ?',
        b.title ?? t.title,
        b.kind ?? t.kind,
        orderMode,
        (b.hintsOn ?? t.hintsOn) ? 1 : 0,
        (b.cooldownOn ?? t.cooldownOn) ? 1 : 0,
        orderMode === 'graph' ? 0 : subsetK,
        id,
      );
      bump(ctx, id);
      publishState(ctx, id);
      return buildAdmin(ctx, id);
    });

    // ---------- console: one trail (default: the treasure hunt) ----------

    // GET /api/hunt/admin?trail=  -> HuntAdmin (includes answers and tokens: console only)
    app.get('/admin', async (req): Promise<HuntAdmin> => {
      requireAdmin(req);
      return buildAdmin(ctx, trailOf(req));
    });

    // PUT /api/hunt/admin/state?trail= { status?, title? }  -> HuntAdmin
    app.put('/admin/state', async (req): Promise<HuntAdmin> => {
      requireAdmin(req);
      const trailId = trailOf(req);
      const body = parse(HuntAdminStateRequestSchema, req.body);
      const t = getTrail(ctx, trailId);
      const now = ctx.now();
      if (body.title !== undefined) run(ctx.db, 'UPDATE hunt_trails SET title = ? WHERE id = ?', body.title, trailId);
      if (body.status !== undefined && body.status !== t.status) {
        if (body.status === 'open') {
          if (stopCount(ctx, trailId) < 2) throw conflict('Add at least two stops before opening.');
          run(ctx.db, "UPDATE hunt_trails SET status = 'open', opened_at = COALESCE(opened_at, ?), closed_at = NULL WHERE id = ?", now, trailId);
        } else if (body.status === 'closed') {
          run(ctx.db, "UPDATE hunt_trails SET status = 'closed', closed_at = ? WHERE id = ?", now, trailId);
        } else {
          if (playerCount(ctx, trailId) > 0) throw conflict('People already started, so it cannot go back to draft. Close it, or reset.');
          run(ctx.db, "UPDATE hunt_trails SET status = 'draft', opened_at = NULL, closed_at = NULL WHERE id = ?", trailId);
        }
      }
      bump(ctx, trailId);
      publishState(ctx, trailId);
      return buildAdmin(ctx, trailId);
    });

    // POST /api/hunt/admin/stops?trail=  -> HuntAdmin. In linear trails the new stop becomes the finale (last in order).
    app.post('/admin/stops', async (req): Promise<HuntAdmin> => {
      requireAdmin(req);
      const trailId = trailOf(req);
      getTrail(ctx, trailId);
      const input = parse(HuntStopInputSchema, req.body);
      requireUnlockedStructure(ctx, trailId);
      insertStop(ctx, trailId, input);
      bump(ctx, trailId);
      publishState(ctx, trailId);
      return buildAdmin(ctx, trailId);
    });

    // PUT /api/hunt/admin/stops/:id  -> HuntAdmin. Wording, answers, hints, points, links can change any time.
    app.put('/admin/stops/:id', async (req): Promise<HuntAdmin> => {
      requireAdmin(req);
      const { id } = parse(IdParam, req.params);
      const trailId = stopTrail(ctx, id);
      const s = normaliseStop(ctx, trailId, parse(HuntStopInputSchema, req.body), id);
      run(
        ctx.db,
        `UPDATE hunt_stops SET title = ?, clue = ?, clue_image = ?, challenge = ?, require_scan = ?, online_fallback = ?, slip_id = ?, next_stop_id = ?, is_finale = ?,
                answers = ?, hints = ?, points = ?, glyph = ?, color = ?, reveal = ?, location = ?
          WHERE id = ?`,
        s.title,
        s.clue,
        s.clueImage,
        s.challenge,
        s.requireScan ? 1 : 0,
        s.onlineFallback ? 1 : 0,
        s.slipId,
        s.nextStopId,
        s.finale ? 1 : 0,
        JSON.stringify(s.answers),
        JSON.stringify(s.hints),
        s.points,
        s.glyph,
        s.color,
        s.reveal,
        s.location,
        id,
      );
      bump(ctx, trailId);
      return buildAdmin(ctx, trailId);
    });

    // DELETE /api/hunt/admin/stops/:id  -> HuntAdmin
    app.delete('/admin/stops/:id', async (req): Promise<HuntAdmin> => {
      requireAdmin(req);
      const { id } = parse(IdParam, req.params);
      const trailId = stopTrail(ctx, id);
      requireUnlockedStructure(ctx, trailId);
      tx(ctx.db, () => {
        run(ctx.db, 'DELETE FROM hunt_stops WHERE id = ?', id);
        run(ctx.db, 'UPDATE hunt_stops SET next_stop_id = NULL WHERE next_stop_id = ?', id);
        run(ctx.db, 'UPDATE hunt_slip_readings SET target_stop_id = NULL WHERE target_stop_id = ?', id);
        loadStops(ctx, trailId).forEach((s, i) => run(ctx.db, 'UPDATE hunt_stops SET position = ? WHERE id = ?', i + 1, s.id));
      });
      bump(ctx, trailId);
      publishState(ctx, trailId);
      return buildAdmin(ctx, trailId);
    });

    // POST /api/hunt/admin/stops/:id/rotate-token  -> HuntAdmin. Use if a sticker photo leaked: old QR/code stop working.
    app.post('/admin/stops/:id/rotate-token', async (req): Promise<HuntAdmin> => {
      requireAdmin(req);
      const { id } = parse(IdParam, req.params);
      const trailId = stopTrail(ctx, id);
      run(ctx.db, 'UPDATE hunt_stops SET token = ?, code = ? WHERE id = ?', newToken(), newCode(ctx), id);
      bump(ctx, trailId);
      return buildAdmin(ctx, trailId);
    });

    // PUT /api/hunt/admin/order?trail= { ids }  -> HuntAdmin. Authoring order; in linear trails the last stop is the finale.
    app.put('/admin/order', async (req): Promise<HuntAdmin> => {
      requireAdmin(req);
      const trailId = trailOf(req);
      const { ids } = parse(HuntAdminOrderRequestSchema, req.body);
      requireUnlockedStructure(ctx, trailId);
      const current = loadStops(ctx, trailId).map((s) => s.id);
      if (ids.length !== current.length || new Set(ids).size !== ids.length || !ids.every((i) => current.includes(i))) {
        throw badRequest('Send every stop id exactly once.');
      }
      tx(ctx.db, () => ids.forEach((id, i) => run(ctx.db, 'UPDATE hunt_stops SET position = ? WHERE id = ?', i + 1, id)));
      bump(ctx, trailId);
      return buildAdmin(ctx, trailId);
    });

    // GET /api/hunt/admin/stickers?trail=  -> HuntStickerSheet (the web renders url as a QR and prints the code under it)
    app.get('/admin/stickers', async (req): Promise<HuntStickerSheet> => {
      requireAdmin(req);
      const trailId = trailOf(req);
      return {
        title: getTrail(ctx, trailId).title,
        stops: loadStops(ctx, trailId)
          .filter((s) => s.challenge !== 'slip')
          .map((s) => ({
            stopId: s.id,
            position: s.position,
            title: s.title,
            location: s.location,
            token: s.token,
            code: formatHuntCode(s.code),
            url: huntScanUrl(ctx.config.appUrl, s.token),
          })),
      };
    });

    // GET /api/hunt/admin/cards?trail=  -> MorseCardSheet: the Morse cards to stick on objects
    app.get('/admin/cards', async (req): Promise<MorseCardSheet> => {
      requireAdmin(req);
      const trailId = trailOf(req);
      return {
        trailId,
        title: getTrail(ctx, trailId).title,
        cards: loadStops(ctx, trailId)
          .filter((s) => s.challenge === 'morse')
          .map((s) => {
            const word = morseWordOf(s.answers[0] ?? '');
            return {
              stopId: s.id,
              position: s.position,
              title: s.title,
              location: s.location,
              word,
              patterns: morseCardPatterns(word),
              requireScan: s.requireScan,
              code: formatHuntCode(s.code),
              url: huntScanUrl(ctx.config.appUrl, s.token),
            };
          }),
      };
    });

    // GET /api/hunt/admin/progress?trail=  -> HuntAdminProgress
    app.get('/admin/progress', async (req): Promise<HuntAdminProgress> => {
      requireAdmin(req);
      return buildProgress(ctx, trailOf(req));
    });

    // GET /api/hunt/admin/graph?trail=  -> TrailGraph (nodes, edges with live counts, dead ends)
    app.get('/admin/graph', async (req): Promise<TrailGraph> => {
      requireAdmin(req);
      return trailGraph(ctx, trailOf(req));
    });

    // POST /api/hunt/admin/reset?trail= { confirm: 'RESET HUNT' }  -> HuntAdmin
    // Wipes this trail's progress, hint/lock state, finish order, its points and stickers. Keeps the stops. New shuffle seed.
    app.post('/admin/reset', async (req): Promise<HuntAdmin> => {
      requireAdmin(req);
      const trailId = trailOf(req);
      parse(HuntAdminResetRequestSchema, req.body);
      const trail = getTrail(ctx, trailId);
      const refs = trailRefs(ctx, trail);
      tx(ctx.db, () => {
        run(ctx.db, 'DELETE FROM hunt_progress WHERE stop_id IN (SELECT id FROM hunt_stops WHERE trail_id = ?)', trailId);
        run(ctx.db, 'DELETE FROM hunt_stop_state WHERE stop_id IN (SELECT id FROM hunt_stops WHERE trail_id = ?)', trailId);
        run(ctx.db, 'DELETE FROM hunt_players WHERE trail_id = ?', trailId);
        run(
          ctx.db,
          'DELETE FROM hunt_slip_finds WHERE reading_id IN (SELECT r.id FROM hunt_slip_readings r JOIN hunt_slips s ON s.id = r.slip_id JOIN hunt_slip_sets ss ON ss.id = s.set_id WHERE ss.trail_id = ?)',
          trailId,
        );
        for (const ref of refs) ctx.points.revoke(HUNT_SOURCE, ref);
        releaseTrail(ctx, trailId); // unique slip copies are free to claim again
        if (trail.kind === 'hunt') ctx.stickers.revokePrefix('hunt-');
        if (trail.kind === 'morse') ctx.stickers.revokePrefix('trail-morse-');
        run(ctx.db, "UPDATE hunt_trails SET status = 'draft', opened_at = NULL, closed_at = NULL, shuffle_seed = ? WHERE id = ?", newSeed(), trailId);
      });
      runtime(ctx).answers.sweep();
      bump(ctx, trailId);
      publishState(ctx, trailId);
      ctx.live.publish('leaderboard.changed', { at: ctx.now() }, 'all');
      return buildAdmin(ctx, trailId);
    });

    // ---------- console: slips ----------

    app.get('/admin/slip-sets', async (req): Promise<SlipSetList> => {
      requireAdmin(req);
      return slipSets(ctx, trailOf(req));
    });

    app.post('/admin/slip-sets', async (req): Promise<SlipSetList> => {
      requireAdmin(req);
      const trailId = trailOf(req);
      getTrail(ctx, trailId);
      const b = parse(SlipSetInputSchema, req.body);
      const pool = [...new Set(b.pool.map((w) => morseWordOf(w)).filter(Boolean))];
      if (b.pool.some((w) => !isMorseWord(w))) throw badRequest('Pool words can only use letters and digits.');
      run(ctx.db, 'INSERT INTO hunt_slip_sets (trail_id, title, mode, word_pool, copies) VALUES (?, ?, ?, ?, ?)', trailId, b.title, b.mode, JSON.stringify(pool), b.mode === 'unique' ? b.copies : 0);
      return slipSets(ctx, trailId);
    });

    // ---------- console: unique slip copies ----------

    // GET /api/hunt/admin/slip-sets/:id/copies  -> SlipCopies (serial, who claimed each slip's copy, when)
    app.get('/admin/slip-sets/:id/copies', async (req): Promise<SlipCopies> => {
      requireAdmin(req);
      const { id } = parse(IdParam, req.params);
      if (getSet(ctx, id).mode !== 'unique') throw conflict('That set does not print unique copies.');
      return copiesView(ctx, id);
    });

    // POST /api/hunt/admin/slip-sets/:id/copies { copies, regenerate? }  -> SlipCopies
    app.post('/admin/slip-sets/:id/copies', async (req): Promise<SlipCopies> => {
      requireAdmin(req);
      const { id } = parse(IdParam, req.params);
      const b = parse(SlipCopiesRequestSchema, req.body);
      syncCopies(ctx, id, { copies: b.copies, regenerate: b.regenerate });
      return copiesView(ctx, id);
    });

    // PUT /api/hunt/admin/slip-sets/:id/mode { mode: 'unique', copies }  -> SlipSetList (the live-database switch)
    app.put('/admin/slip-sets/:id/mode', async (req): Promise<SlipSetList> => {
      requireAdmin(req);
      const { id } = parse(IdParam, req.params);
      const b = parse(SlipSetModeRequestSchema, req.body);
      const set = getSet(ctx, id);
      convertToUnique(ctx, id, b.copies);
      bump(ctx, set.trail_id);
      return slipSets(ctx, set.trail_id);
    });

    // POST /api/hunt/admin/slip-copies/:id/release  -> SlipCopies (lost slip, or a mistake)
    app.post('/admin/slip-copies/:id/release', async (req): Promise<SlipCopies> => {
      requireAdmin(req);
      const { id } = parse(IdParam, req.params);
      return copiesView(ctx, releaseCopy(ctx, id));
    });

    // GET /api/hunt/admin/slip-sets/:id/answer-key.csv  -> text/csv: the organisers' private serial -> words key
    app.get('/admin/slip-sets/:id/answer-key.csv', async (req, reply) => {
      requireAdmin(req);
      const { id } = parse(IdParam, req.params);
      const set = getSet(ctx, id);
      if (set.mode !== 'unique') throw conflict('That set does not print unique copies.');
      const name = `answer-key-${set.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv`;
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${name}"`)
        .header('cache-control', 'no-store')
        .send(answerKeyCsv(ctx, id));
    });

    app.post('/admin/slip-sets/:id/slips', async (req): Promise<SlipSetList> => {
      requireAdmin(req);
      const { id } = parse(IdParam, req.params);
      const set = one<{ trail_id: number }>(ctx.db, 'SELECT trail_id FROM hunt_slip_sets WHERE id = ?', id);
      if (!set) throw notFound('No such slip set.');
      writeSlip(ctx, id, null, parse(SlipInputSchema, req.body));
      bump(ctx, set.trail_id);
      return slipSets(ctx, set.trail_id);
    });

    app.put('/admin/slips/:id', async (req): Promise<SlipSetList> => {
      requireAdmin(req);
      const { id } = parse(IdParam, req.params);
      const sl = one<{ set_id: number; trail_id: number }>(ctx.db, 'SELECT s.set_id, ss.trail_id FROM hunt_slips s JOIN hunt_slip_sets ss ON ss.id = s.set_id WHERE s.id = ?', id);
      if (!sl) throw notFound('No such slip.');
      writeSlip(ctx, sl.set_id, id, parse(SlipInputSchema, req.body));
      bump(ctx, sl.trail_id);
      return slipSets(ctx, sl.trail_id);
    });

    app.delete('/admin/slips/:id', async (req): Promise<SlipSetList> => {
      requireAdmin(req);
      const { id } = parse(IdParam, req.params);
      const sl = one<{ trail_id: number }>(ctx.db, 'SELECT ss.trail_id FROM hunt_slips s JOIN hunt_slip_sets ss ON ss.id = s.set_id WHERE s.id = ?', id);
      if (!sl) throw notFound('No such slip.');
      if (one(ctx.db, 'SELECT 1 AS x FROM hunt_stops WHERE slip_id = ?', id)) throw conflict('A stop uses this slip. Change the stop first.');
      run(ctx.db, 'DELETE FROM hunt_slips WHERE id = ?', id);
      return slipSets(ctx, sl.trail_id);
    });

    // GET /api/hunt/admin/slip-print?set=  -> SlipPrintSheet (per kit for per-kit sets)
    app.get('/admin/slip-print', async (req): Promise<SlipPrintSheet> => {
      requireAdmin(req);
      return slipPrint(ctx, parse(SetQuery, req.query).set);
    });
  },

  // Broadcast each trail's anonymous crowd counts at most every 1.5 s, and only if something moved.
  tick: {
    everyMs: 1500,
    run(ctx) {
      const rt = runtime(ctx);
      if (rt.dirty.size === 0) return;
      const ids = [...rt.dirty];
      rt.dirty.clear();
      for (const id of ids) {
        const t = listTrails(ctx).find((x) => x.id === id);
        if (!t || t.status === 'draft') continue;
        ctx.live.publish('hunt.crowd', crowdOf(ctx, id).crowd, 'all');
      }
    },
  },

  async seed(ctx) {
    seedHunt(ctx);
  },
});

function buildProgress(ctx: FeatureContext, trailId: number): HuntAdminProgress {
  const trail = getTrail(ctx, trailId);
  const stops = loadStops(ctx, trailId);
  const ids = stops.map((s) => s.id);
  const titles = new Map(stops.map((s) => [s.id, s.title]));
  const solvedCount = new Map(
    all<{ attendee_id: number; n: number }>(
      ctx.db,
      'SELECT p.attendee_id, COUNT(*) AS n FROM hunt_progress p JOIN hunt_stops s ON s.id = p.stop_id WHERE s.trail_id = ? GROUP BY p.attendee_id',
      trailId,
    ).map((r) => [r.attendee_id, r.n]),
  );
  const hints = new Map(
    all<{ attendee_id: number; n: number }>(
      ctx.db,
      'SELECT st.attendee_id, SUM(st.hints_used) AS n FROM hunt_stop_state st JOIN hunt_stops s ON s.id = st.stop_id WHERE s.trail_id = ? GROUP BY st.attendee_id',
      trailId,
    ).map((r) => [r.attendee_id, r.n]),
  );
  const rows = all<{
    attendee_id: number;
    nickname: string | null;
    avatar: string | null;
    name: string | null;
    roll: string | null;
    started_at: number;
    last_at: number;
    finished_at: number | null;
    finish_rank: number | null;
    elapsed_ms: number | null;
    current_stop_id: number | null;
  }>(
    ctx.db,
    `SELECT p.attendee_id, a.nickname, a.avatar, a.name, a.roll, p.started_at, p.last_at, p.finished_at, p.finish_rank, p.elapsed_ms, p.current_stop_id
       FROM hunt_players p JOIN attendees a ON a.id = p.attendee_id
      WHERE p.trail_id = ?
      ORDER BY p.finish_rank IS NULL, p.finish_rank, p.started_at`,
    trailId,
  );
  return {
    total: trailTotal(trail, stops.length),
    rows: rows.map((r) => {
      const solved = solvedCount.get(r.attendee_id) ?? 0;
      const curId = r.finished_at !== null ? null : trail.orderMode === 'graph' ? r.current_stop_id : (orderFor(trail, r.attendee_id, ids)[solved] ?? null);
      return {
        attendeeId: r.attendee_id,
        nickname: r.nickname,
        avatar: r.avatar ? parseAvatar(r.avatar) : null,
        name: r.name,
        roll: r.roll,
        solved,
        currentStopId: curId,
        currentStopTitle: curId === null ? null : (titles.get(curId) ?? null),
        hintsUsed: hints.get(r.attendee_id) ?? 0,
        startedAt: r.started_at,
        lastActiveAt: r.last_at,
        finishedAt: r.finished_at,
        rank: r.finish_rank,
        elapsedMs: r.elapsed_ms,
      };
    }),
    crowd: crowdOf(ctx, trailId).crowd.here.map((h) => ({ stopId: h.stopId, title: titles.get(h.stopId) ?? '', count: h.count })),
  };
}
