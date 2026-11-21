// The Cipher Ticket, server side: slips and guilds, the seven trials, points, the projector and console
// views. Pact pairing lives in pact.ts and the last signal in signal.ts.
//
// Fairness: every judgement happens here. Before a trial is solved the phone gets only what it needs to
// play: which slip and edge to read, letter counts after a hint, and the on/off timing of the whisper;
// never the echo, riddle or whisper word, a partner's edge word, the Oracle's words or the last signal.
import {
  type CipherAdmin,
  type CipherMe,
  type CipherRead,
  type CipherScreen,
  type CipherSettings,
  CipherSettingsSchema,
  DEFAULT_CIPHER_SETTINGS,
  EDGE_RUNE,
  type EchoResult,
  type Guild,
  GUILDS,
  GUILD_INFO,
  type GuessResult,
  type GuildStanding,
  SLIP_NAMES,
  type ScanResult,
  type Star,
  TRIALS,
  type TrialId,
  echoStars,
  farnsworthSignal,
  fitsWithTolerance,
} from '@afterhours/shared/features/cipher';
import { slipMorseKey, slipWordKey } from '@afterhours/shared/features/hunt';
import { type Press, UNIT_MAX_MS, UNIT_MIN_MS, editDistance, judgeTaps, normaliseWord, wordToPatterns } from '@afterhours/shared/features/morse';
import { SLIP_EDGES, type SlipEdge, encodeWord, reverseReading } from '@afterhours/shared/morse-slip';
import { type FeatureContext, HttpError, RateLimiter, all, badRequest, conflict, one, run, tx } from '../../core';
import { edgeUnitLimit } from '../hunt/slipwords';
import { copyEdges, matchCopy } from '../hunt/unique';
import { claimSerial, copyDesign, copyIdOf, heldSerial, morseChallengeVisible, morseTicketSet, morseTicketSlips, notOpen, setMorseChallengeVisible } from './adapter';
import { adminPacts, enterPool, pactScan, pactView, pactsSealed, recentPacts, waitingList } from './pact';
import { adminSignal, screenSignal, signalView } from './signal';
import { WHISPER_WORDS, candidates, codeWord } from './words';

export const SOURCE = 'cipher';
/** A tapped sequence may finish at most this much before the server clock says it could (ms). */
const TAP_CLOCK_SLACK_MS = 60;
/** Trial numbers (1-based). */
export const T = { oath: 1, winds: 2, echo: 3, whisper: 4, riddle: 5, pact: 6, signal: 7, done: 8 } as const;

export const STICKERS = {
  oath: 'cipher-oath',
  winds: 'cipher-winds',
  echo: 'cipher-echo',
  whisper: 'cipher-whisper',
  riddle: 'cipher-riddle',
  pact: 'cipher-pact',
  signal: 'cipher-signal',
  master: 'cipher-master',
  champion: 'cipher-champion',
} as const;

// ---------------------------------------------------------------------------
// per-app state
// ---------------------------------------------------------------------------

interface State {
  scans: RateLimiter;
  answers: RateLimiter;
  dirty: boolean;
}
const states = new WeakMap<FeatureContext, State>();
export function state(ctx: FeatureContext): State {
  let s = states.get(ctx);
  if (!s) {
    s = {
      scans: new RateLimiter({ limit: 20, windowMs: 30_000, now: ctx.now }),
      answers: new RateLimiter({ limit: 12, windowMs: 30_000, now: ctx.now }),
      dirty: false,
    };
    states.set(ctx, s);
  }
  return s;
}
/** Counts moved: the tick publishes one throttled 'cipher.changed'. */
export const touch = (ctx: FeatureContext): void => void (state(ctx).dirty = true);

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

export function settings(ctx: FeatureContext): CipherSettings {
  const raw = one<{ settings: string }>(ctx.db, 'SELECT settings FROM cipher_config WHERE id = 1')?.settings ?? '{}';
  let stored: Partial<CipherSettings>;
  try {
    stored = JSON.parse(raw) as Partial<CipherSettings>;
  } catch {
    stored = {};
  }
  const merged = { ...DEFAULT_CIPHER_SETTINGS, ...stored, points: { ...DEFAULT_CIPHER_SETTINGS.points, ...(stored.points ?? {}) }, oracle: { ...DEFAULT_CIPHER_SETTINGS.oracle, ...(stored.oracle ?? {}) } };
  const ok = CipherSettingsSchema.safeParse(merged);
  return ok.success ? ok.data : DEFAULT_CIPHER_SETTINGS;
}

export function saveSettings(ctx: FeatureContext, s: CipherSettings): CipherSettings {
  if (s.whisperMinLetters > s.whisperMaxLetters) throw badRequest('Whisper letters: the minimum is above the maximum.');
  if (s.windsHint1Sec > s.windsHint2Sec) throw badRequest('The second four-winds hint should come after the first.');
  const oracle = { ...s.oracle };
  for (const edge of SLIP_EDGES) {
    const w = normaliseWord(oracle[edge]);
    if (!w) throw badRequest(`The Oracle's ${edge} word is empty.`);
    if (encodeWord(w).units > edgeUnitLimit(edge)) throw badRequest(`The Oracle's ${edge} word "${w}" is too long for that edge of the ticket.`);
    oracle[edge] = w;
  }
  const clean = { ...s, oracle };
  run(ctx.db, 'UPDATE cipher_config SET settings = ? WHERE id = 1', JSON.stringify(clean));
  touch(ctx);
  return clean;
}

/** The console's "show to players" button flips hunt's "show morse challenge to players" switch. */
export function setVisible(ctx: FeatureContext, visible: boolean): void {
  setMorseChallengeVisible(ctx, visible);
  touch(ctx);
}

// ---------------------------------------------------------------------------
// slips
// ---------------------------------------------------------------------------

export interface Ticket {
  setId: number;
  /** slip ids, [I, II, III, IV] */
  slips: number[];
}
export function ticketSet(ctx: FeatureContext): Ticket | null {
  const setId = morseTicketSet(ctx);
  if (setId === null) return null;
  const slips = morseTicketSlips(ctx, setId);
  return slips.length >= 4 ? { setId, slips: slips.slice(0, 4) } : null;
}

export interface PlayerRow {
  attendee_id: number;
  copy_id: number;
  serial: number;
  guild: Guild;
  claimed_at: number;
  trial: number;
  trial_started_at: number;
  w_bottom: number | null;
  w_right: number | null;
  w_top: number | null;
  w_left: number | null;
  cursed: number;
  echo_edge: SlipEdge | null;
  echo_tries: number;
  riddle_rule: 'first' | 'last' | null;
  riddle_hint: number;
  riddle_tries: number;
  whisper_hints: number;
  whisper_tries: number;
  pact_since: number | null;
}

export const getPlayer = (ctx: FeatureContext, attendeeId: number): PlayerRow | undefined => one<PlayerRow>(ctx.db, 'SELECT * FROM cipher_players WHERE attendee_id = ?', attendeeId);

type Edges = Partial<Record<SlipEdge, string>>;

/** The words slip `slipNo` (1..4) of a serial prints per edge (hunt's record of that copy). */
export function slipEdges(ctx: FeatureContext, t: Ticket, serial: number, slipNo: number): Edges {
  const slipId = t.slips[slipNo - 1];
  if (slipId === undefined) return {};
  const copyId = copyIdOf(ctx, slipId, serial);
  return copyId === null ? {} : copyEdges(ctx, copyId, slipId).edges;
}
const allWords = (ctx: FeatureContext, t: Ticket, serial: number): string[] => [1, 2, 3, 4].flatMap((n) => Object.values(slipEdges(ctx, t, serial, n)) as string[]);

const hash = (n: number, salt: number) => ((n * 2654435761 + salt * 40503) >>> 0) % 1000003;

/** The echo's edge of slip II: one carrying a ~3-letter word (the short edges carry three letters). */
function pickEchoEdge(edges: Edges, attendeeId: number): SlipEdge | null {
  const have = SLIP_EDGES.filter((e) => edges[e]);
  if (have.length === 0) return null;
  const three = have.filter((e) => edges[e]!.length === 3);
  const pool = three.length > 0 ? three : [...have].sort((a, b) => edges[a]!.length - edges[b]!.length).slice(0, 1);
  return pool[hash(attendeeId, 3) % pool.length] as SlipEdge;
}

/** The riddle's answer: the slip III word that comes first (or last) alphabetically. */
export function riddleAnswer(edges: Edges, rule: 'first' | 'last'): { word: string; edge: SlipEdge } | null {
  const xs = SLIP_EDGES.filter((e) => edges[e]).map((e) => ({ edge: e, word: edges[e]! }));
  if (xs.length === 0) return null;
  xs.sort((a, b) => (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
  return (rule === 'first' ? xs[0] : xs[xs.length - 1]) ?? null;
}

/** The whisper word of a serial (keyed by slip I's copy): drawn once, unique, printed on none of its slips. */
export function ensureWhisper(ctx: FeatureContext, copyId: number, avoid: readonly string[]): string {
  const have = one<{ word: string }>(ctx.db, 'SELECT word FROM cipher_whispers WHERE copy_id = ?', copyId);
  if (have) return have.word;
  const s = settings(ctx);
  const skip = new Set(avoid.map((w) => w.toUpperCase()));
  const tryWord = (w: string): boolean => !skip.has(w) && run(ctx.db, 'INSERT OR IGNORE INTO cipher_whispers (copy_id, word) VALUES (?, ?)', copyId, w).changes === 1;
  for (const w of candidates(WHISPER_WORDS, s.whisperMinLetters, s.whisperMaxLetters)) if (tryWord(w)) return w;
  for (let i = 0; i < 400; i++) {
    const n = s.whisperMinLetters + (i % (s.whisperMaxLetters - s.whisperMinLetters + 1));
    const w = codeWord(n);
    if (tryWord(w)) return w;
  }
  throw conflict('Could not draw a whisper word. Try again.');
}

const whisperWord = (ctx: FeatureContext, p: PlayerRow, t: Ticket): string => ensureWhisper(ctx, p.copy_id, allWords(ctx, t, p.serial));

/** Create the cipher player for a reserved serial (idempotent). */
function addPlayer(ctx: FeatureContext, attendeeId: number, t: Ticket, serial: number): PlayerRow | null {
  const copyId = copyIdOf(ctx, t.slips[0] as number, serial);
  if (copyId === null) return null;
  const at = ctx.now();
  run(
    ctx.db,
    `INSERT OR IGNORE INTO cipher_players (attendee_id, copy_id, serial, guild, claimed_at, trial, trial_started_at, echo_edge, riddle_rule)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    attendeeId,
    copyId,
    serial,
    copyDesign(ctx, copyId, serial, 1),
    at,
    at,
    pickEchoEdge(slipEdges(ctx, t, serial, 2), attendeeId),
    hash(attendeeId, 7) % 2 === 0 ? 'first' : 'last',
  );
  ensureWhisper(ctx, copyId, allWords(ctx, t, serial));
  touch(ctx);
  return getPlayer(ctx, attendeeId) ?? null;
}

/**
 * The player, created lazily when they already hold a slip of a serial (claimed through the morse trail,
 * say): the rest of that serial is reserved for them too, if it is free.
 */
export function ensurePlayer(ctx: FeatureContext, attendeeId: number, t: Ticket | null = ticketSet(ctx)): PlayerRow | null {
  const p = getPlayer(ctx, attendeeId);
  if (p || !t) return p ?? null;
  const serial = heldSerial(ctx, attendeeId, t.slips);
  if (serial === null) return null;
  claimSerial(ctx, attendeeId, t.slips, serial);
  return addPlayer(ctx, attendeeId, t, serial);
}

// ---------------------------------------------------------------------------
// reading keys
// ---------------------------------------------------------------------------

export function keysOf(read: CipherRead): Set<string> {
  const keys = new Set<string>();
  if (read.morse?.trim()) keys.add(slipMorseKey(read.morse));
  if (read.text?.trim()) {
    try {
      keys.add(slipWordKey(normaliseWord(read.text)));
    } catch {
      /* a character with no Morse: no key */
    }
  }
  keys.delete('');
  return keys;
}

/** Which edge of these edges a reading is: the edge itself, or (withCursed) the top read upside down. */
export function whichEdge(edges: Edges, keys: Set<string>, withCursed = false): { edge: SlipEdge; cursed: boolean } | null {
  for (const e of SLIP_EDGES) {
    const w = edges[e];
    if (w && keys.has(slipWordKey(w))) return { edge: e, cursed: false };
  }
  const top = edges.top;
  if (withCursed && top && keys.has(slipMorseKey(reverseReading(slipWordKey(top))))) return { edge: 'top', cursed: true };
  return null;
}

/** Which of the player's own slips (1..4) and edge a reading is. Slip I's upside-down top is cursed. */
function whichOfMine(ctx: FeatureContext, t: Ticket, serial: number, keys: Set<string>): { slip: number; edge: SlipEdge; cursed: boolean } | null {
  for (let n = 1; n <= 4; n++) {
    const hit = whichEdge(slipEdges(ctx, t, serial, n), keys, n === 1);
    if (hit) return { slip: n, ...hit };
  }
  return null;
}

/** Which printed copy (any slip) a reading belongs to: its serial, or null. */
function matchAnySlip(ctx: FeatureContext, t: Ticket, keys: Set<string>): { serial: number; slip: number } | null {
  for (const [i, slipId] of t.slips.entries()) {
    const hit = matchCopy(ctx, slipId, keys);
    if (hit) return { serial: hit.serial, slip: i + 1 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// sealing a trial
// ---------------------------------------------------------------------------

const TRIAL_LABEL: Record<TrialId, string> = {
  oath: 'cipher: sworn in',
  winds: 'cipher: the four winds',
  echo: 'cipher: the echo',
  whisper: 'cipher: the whisper',
  riddle: 'cipher: the riddle',
  pact: 'cipher: the pact',
  signal: 'cipher: the last signal',
};

/**
 * Seal trial `n` (1-based) for a player: once (the seal's primary key), points through the idempotent
 * ledger, the trial's sticker, the next trial's clock starts. Returns the points paid, or null if it was
 * not the player's trial (or already sealed).
 */
export function seal(ctx: FeatureContext, attendeeId: number, n: number, opts: { stars?: number; points: number; speed?: boolean } = { points: 0 }): number | null {
  const s = settings(ctx);
  const id = TRIALS[n - 1] as TrialId;
  return tx(ctx.db, () => {
    const p = getPlayer(ctx, attendeeId);
    if (!p || p.trial !== n) return null;
    const now = ctx.now();
    const fast = opts.speed !== false && n >= T.winds && n <= T.pact && now - p.trial_started_at <= s.parSec * 1000;
    const stars = opts.stars ?? (fast || n === T.oath ? 3 : 2);
    const r = run(ctx.db, 'INSERT OR IGNORE INTO cipher_seals (attendee_id, trial, at, stars, points, fast) VALUES (?, ?, ?, ?, ?, ?)', attendeeId, n, now, stars, 0, fast ? 1 : 0);
    if (r.changes === 0) return null;
    let paid = 0;
    if (opts.points > 0 && ctx.points.award({ attendeeId, source: SOURCE, ref: id, points: opts.points, label: TRIAL_LABEL[id] }).awarded) paid += opts.points;
    if (fast && s.points.speed > 0 && ctx.points.award({ attendeeId, source: SOURCE, ref: `speed:${id}`, points: s.points.speed, label: `${TRIAL_LABEL[id]}, fast` }).awarded) paid += s.points.speed;
    run(ctx.db, 'UPDATE cipher_seals SET points = ? WHERE attendee_id = ? AND trial = ?', paid, attendeeId, n);
    run(ctx.db, 'UPDATE cipher_players SET trial = ?, trial_started_at = ?, pact_since = NULL WHERE attendee_id = ?', n + 1, now, attendeeId);
    ctx.stickers.unlock(attendeeId, STICKERS[id]);
    if (n === TRIALS.length) ctx.stickers.unlock(attendeeId, STICKERS.master);
    touch(ctx);
    if (n + 1 === T.pact) enterPool(ctx, attendeeId);
    return paid;
  });
}

function sealedTrials(ctx: FeatureContext, attendeeId: number): Map<number, { at: number; stars: number; points: number; fast: number }> {
  return new Map(all<{ trial: number; at: number; stars: number; points: number; fast: number }>(ctx.db, 'SELECT trial, at, stars, points, fast FROM cipher_seals WHERE attendee_id = ?', attendeeId).map((r) => [r.trial, r]));
}

const foundEdges = (p: PlayerRow) => ({ bottom: p.w_bottom !== null, right: p.w_right !== null, top: p.w_top !== null, left: p.w_left !== null });

/** If all four winds are found while on trial 2, seal it. */
function maybeSealWinds(ctx: FeatureContext, attendeeId: number): number {
  const p = getPlayer(ctx, attendeeId);
  if (!p || p.trial !== T.winds) return 0;
  const f = foundEdges(p);
  if (!(f.bottom && f.right && f.top && f.left)) return 0;
  return seal(ctx, attendeeId, T.winds, { points: 0 }) ?? 0;
}

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

export function requireVisible(ctx: FeatureContext): Ticket {
  if (!morseChallengeVisible(ctx)) throw notOpen();
  const t = ticketSet(ctx);
  if (!t) throw new HttpError(409, 'cipher_unready', 'The cipher slips are not set up yet. Ask an organiser.');
  return t;
}

function requirePlayer(ctx: FeatureContext, attendeeId: number, t: Ticket): PlayerRow {
  const p = ensurePlayer(ctx, attendeeId, t);
  if (!p) throw conflict('Scan one of your slips first: any edge of any slip claims all four.');
  return p;
}

// ---------------------------------------------------------------------------
// trial 1 + 2 (+ the pact's scans): one scan endpoint
// ---------------------------------------------------------------------------

export function scan(ctx: FeatureContext, attendeeId: number, read: CipherRead): ScanResult {
  const t = requireVisible(ctx);
  const s = settings(ctx);
  const st = state(ctx);
  const keys = keysOf(read);
  const slow = () => st.scans.enforce(`scan:${attendeeId}`, 'That is a lot of scanning. Breathe, and turn the slip slowly.');
  const result = (outcome: ScanResult['outcome'], message: string, edge: SlipEdge | null = null, points = 0): ScanResult => ({ outcome, edge, message, points, me: buildMe(ctx, attendeeId) });
  if (keys.size === 0) {
    slow();
    return result('unknown', 'nothing there. turn the slip and try another edge.');
  }

  let p = ensurePlayer(ctx, attendeeId, t);
  if (!p) {
    // the claim: the first person whose reading matches any slip of a serial reserves all four
    const hit = matchAnySlip(ctx, t, keys);
    if (!hit) {
      slow();
      return result('unknown', 'nothing there. try another edge of one of your slips.');
    }
    const c = claimSerial(ctx, attendeeId, t.slips, hit.serial);
    if (c.kind !== 'mine') {
      slow();
      return result('taken', c.kind === 'taken' ? 'these slips already belong to someone else. scan your own.' : `you already hold set no. ${pad(c.serial)}. scan one of those.`);
    }
    p = addPlayer(ctx, attendeeId, t, c.serial);
    if (!p) return result('unknown', 'nothing there. try another edge.');
    const which = whichOfMine(ctx, t, p.serial, keys);
    let pts = 0;
    if (which?.slip === 1) pts = lightRune(ctx, p, which.edge, which.cursed);
    return result('claimed', `slips I to IV of set no. ${pad(c.serial)} are yours. slip I is printed for ${GUILD_INFO[p.guild].title}.`, which?.slip === 1 ? which.edge : null, pts);
  }

  const mine = whichOfMine(ctx, t, p.serial, keys);
  if (p.trial === T.pact && s.pactOpen) {
    const r = pactScan(ctx, p, keys, mine?.slip ?? null);
    if (r) return result(r.outcome, r.message, r.edge, r.points);
  }
  if (mine) {
    if (mine.slip === 1 && p.trial <= T.winds) {
      const wasFound = foundEdges(p)[mine.edge];
      const pts = lightRune(ctx, p, mine.edge, mine.cursed);
      const sealedPts = maybeSealWinds(ctx, attendeeId);
      const wind = EDGE_RUNE[mine.edge].wind;
      if (mine.cursed) return result('cursed', `cursed! you read slip I's top strip upside down. ${wasFound ? 'the north wind is already yours.' : 'it still counts: the north wind is yours.'}`, 'top', pts + sealedPts);
      if (wasFound) return result('again', `${wind} again. you have that one: try another edge.`, mine.edge, sealedPts);
      return result('rune', getPlayer(ctx, attendeeId)!.trial > T.winds ? `${wind}! all four winds are yours.` : `${wind}! a rune lights up.`, mine.edge, pts + sealedPts);
    }
    if (p.trial <= T.winds) return result('again', `that is your slip ${SLIP_NAMES[mine.slip - 1]}. the four winds blow on slip I.`, null);
    return result('again', `that is your slip ${SLIP_NAMES[mine.slip - 1]}. nothing to scan for this trial.`, null);
  }
  slow();
  const other = matchAnySlip(ctx, t, keys);
  if (other) return result('not_yours', 'that slip is not yours. scan your own.');
  return result('unknown', 'nothing there. turn the slip and try another edge.');
}

const pad = (n: number) => String(n).padStart(3, '0');

/** Light a rune of slip I (idempotent). The cursed top lights the north rune too. Returns points paid. */
function lightRune(ctx: FeatureContext, p: PlayerRow, edge: SlipEdge, cursed: boolean): number {
  const col = `w_${edge}`;
  run(ctx.db, `UPDATE cipher_players SET ${col} = COALESCE(${col}, ?)${cursed ? ', cursed = 1' : ''} WHERE attendee_id = ?`, ctx.now(), p.attendee_id);
  touch(ctx);
  const pts = settings(ctx).points.rune;
  return pts > 0 && ctx.points.award({ attendeeId: p.attendee_id, source: SOURCE, ref: `rune:${edge}`, points: pts, label: `cipher: ${EDGE_RUNE[edge].wind}` }).awarded ? pts : 0;
}

/** Trial 1: the oath, after the slips are claimed. */
export function swear(ctx: FeatureContext, attendeeId: number): CipherMe {
  const t = requireVisible(ctx);
  const p = requirePlayer(ctx, attendeeId, t);
  if (p.trial === T.oath) {
    seal(ctx, attendeeId, T.oath, { points: settings(ctx).points.oath, stars: 3 });
    maybeSealWinds(ctx, attendeeId);
  }
  return buildMe(ctx, attendeeId);
}

// ---------------------------------------------------------------------------
// trial 3: the echo (decode slip II's named edge, tap it)
// ---------------------------------------------------------------------------

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** judgeTaps, plus the forgiving tolerance: a press-for-press fit of the word at the tapper's own unit. */
export function judgeEcho(word: string, presses: readonly Press[], s: Pick<CipherSettings, 'echoTolerance' | 'echoStar2' | 'echoStar3'>) {
  const j = judgeTaps(word, presses);
  let passed = j.verdict === 'ok' || j.verdict === 'sloppy';
  let lenient = false;
  if (!passed && (j.verdict === 'wrong' || j.verdict === 'too_fast' || j.verdict === 'too_slow')) {
    const kinds = wordToPatterns(word).join('');
    if (presses.length === kinds.length) {
      const u = median(presses.map(([d, up], i) => (kinds[i] === '.' ? up - d : (up - d) / 3)));
      if (u >= UNIT_MIN_MS && u <= UNIT_MAX_MS && fitsWithTolerance(word, presses, u, s.echoTolerance)) {
        passed = true;
        lenient = true;
      }
    }
  }
  const stars = echoStars(passed, lenient ? Math.min(j.rhythm, s.echoStar2 - 0.01) : j.rhythm, s);
  return { j, passed, stars, decoded: passed ? normaliseWord(word) : j.decoded, letterOk: passed ? [...normaliseWord(word)].map(() => true) : j.letterOk };
}

function echoWord(ctx: FeatureContext, p: PlayerRow, t: Ticket): string | null {
  return p.echo_edge ? (slipEdges(ctx, t, p.serial, 2)[p.echo_edge] ?? null) : null;
}

export function echo(ctx: FeatureContext, attendeeId: number, presses: Press[]): EchoResult {
  const t = requireVisible(ctx);
  const p = requirePlayer(ctx, attendeeId, t);
  const s = settings(ctx);
  const word = echoWord(ctx, p, t);
  if (p.trial !== T.echo || !word) throw conflict(p.trial < T.echo ? 'Finish the four winds first.' : 'The echo is already sealed.');
  state(ctx).answers.enforce(`echo:${attendeeId}`, 'Slow down a little, then tap it again.');
  const span = (presses[presses.length - 1] as Press)[1] - (presses[0] as Press)[0];
  if (span > ctx.now() - p.trial_started_at + TAP_CLOCK_SLACK_MS) throw badRequest('Those taps took longer than this trial has been open. Tap it again.');
  const r = judgeEcho(word, presses, s);
  let sealed = false;
  let points = 0;
  let message: string;
  if (r.passed) {
    points = seal(ctx, attendeeId, T.echo, { stars: r.stars, points: r.stars * s.points.echoStar }) ?? 0;
    sealed = true;
    message = r.stars === 3 ? `${word}, a perfect echo. the brass sings.` : r.stars === 2 ? `${word}, a clean echo. good rhythm.` : `${word}. the wire heard you. echo sealed.`;
  } else {
    const tries = p.echo_tries + 1;
    run(ctx.db, 'UPDATE cipher_players SET echo_tries = ? WHERE attendee_id = ?', tries, attendeeId);
    if (tries >= s.echoTries) {
      points = seal(ctx, attendeeId, T.echo, { stars: 0, points: 0, speed: false }) ?? 0;
      sealed = true;
      message = `the wire forgives you: it was ${word}. echo sealed without a star; on to the whisper.`;
    } else {
      const left = s.echoTries - tries;
      message = r.j.verdict === 'robotic' ? 'too perfect to be a thumb. tap it yourself.' : `we read ${r.decoded || '...'}. check slip II again. ${left} ${left === 1 ? 'try' : 'tries'} left.`;
    }
  }
  const me = buildMe(ctx, attendeeId);
  return { passed: r.passed, stars: r.stars, verdict: r.j.verdict, decoded: r.decoded, rhythm: r.j.rhythm, letterOk: r.letterOk, presses: r.j.presses, triesLeft: me.echo.triesLeft, sealed, points, message, me };
}

// ---------------------------------------------------------------------------
// trial 4: the whisper
// ---------------------------------------------------------------------------

export function whisperHint(ctx: FeatureContext, attendeeId: number): CipherMe {
  const t = requireVisible(ctx);
  const p = requirePlayer(ctx, attendeeId, t);
  if (p.trial !== T.whisper) throw conflict('That hint is for the whisper.');
  run(ctx.db, 'UPDATE cipher_players SET whisper_hints = MIN(2, whisper_hints + 1) WHERE attendee_id = ?', attendeeId);
  return buildMe(ctx, attendeeId);
}

export function whisperGuess(ctx: FeatureContext, attendeeId: number, guess: string): GuessResult {
  const t = requireVisible(ctx);
  const p = requirePlayer(ctx, attendeeId, t);
  const s = settings(ctx);
  if (p.trial !== T.whisper) throw conflict(p.trial < T.whisper ? 'The whisper opens after the echo.' : 'The whisper is already sealed.');
  state(ctx).answers.enforce(`whisper:${attendeeId}`, 'Easy: listen again, then answer.');
  const word = whisperWord(ctx, p, t);
  const g = normaliseWord(guess);
  if (g === word) {
    const pts = Math.max(5, s.points.whisper - p.whisper_hints * s.whisperHintCost);
    const paid = seal(ctx, attendeeId, T.whisper, { points: pts }) ?? 0;
    return { correct: true, close: false, points: paid, message: `${word}. the whisper was yours alone.`, me: buildMe(ctx, attendeeId) };
  }
  run(ctx.db, 'UPDATE cipher_players SET whisper_tries = whisper_tries + 1 WHERE attendee_id = ?', attendeeId);
  const close = g.length === word.length && editDistance(g, word) === 1;
  return { correct: false, close, points: 0, message: close ? 'so close: one letter is off. play it again.' : 'not that one. play it again, slowly, with the chart.', me: buildMe(ctx, attendeeId) };
}

// ---------------------------------------------------------------------------
// trial 5: the riddle (slip III)
// ---------------------------------------------------------------------------

export function riddleHint(ctx: FeatureContext, attendeeId: number): CipherMe {
  const t = requireVisible(ctx);
  const p = requirePlayer(ctx, attendeeId, t);
  if (p.trial !== T.riddle) throw conflict('That hint is for the riddle.');
  run(ctx.db, 'UPDATE cipher_players SET riddle_hint = 1 WHERE attendee_id = ?', attendeeId);
  return buildMe(ctx, attendeeId);
}

export function riddleGuess(ctx: FeatureContext, attendeeId: number, guess: string): GuessResult {
  const t = requireVisible(ctx);
  const p = requirePlayer(ctx, attendeeId, t);
  const s = settings(ctx);
  if (p.trial !== T.riddle) throw conflict(p.trial < T.riddle ? 'The riddle opens after the whisper.' : 'The riddle is already sealed.');
  state(ctx).answers.enforce(`riddle:${attendeeId}`, 'Easy: decode slip III again, then answer.');
  const edges = slipEdges(ctx, t, p.serial, 3);
  const ans = riddleAnswer(edges, p.riddle_rule ?? 'first');
  if (!ans) throw conflict('Slip III has no words. Ask an organiser.');
  const g = normaliseWord(guess);
  if (g === ans.word) {
    const pts = Math.max(5, s.points.riddle - p.riddle_hint * s.riddleHintCost);
    const paid = seal(ctx, attendeeId, T.riddle, { points: pts }) ?? 0;
    return { correct: true, close: false, points: paid, message: `${ans.word}. the riddle is answered.`, me: buildMe(ctx, attendeeId) };
  }
  run(ctx.db, 'UPDATE cipher_players SET riddle_tries = riddle_tries + 1 WHERE attendee_id = ?', attendeeId);
  const isOne = Object.values(edges).some((w) => w === g);
  const close = !isOne && g.length === ans.word.length && editDistance(g, ans.word) === 1;
  return {
    correct: false,
    close,
    points: 0,
    message: isOne ? `${g} is on slip III, but it is not the one the riddle asks for. put all four in order.` : close ? 'so close: one letter is off. decode that edge again.' : 'that is not one of slip III’s four words. decode each edge again.',
    me: buildMe(ctx, attendeeId),
  };
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

/** People on each trial right now (1..7). */
export function onTrial(ctx: FeatureContext): number[] {
  const out = TRIALS.map(() => 0);
  for (const r of all<{ trial: number; n: number }>(ctx.db, 'SELECT trial, COUNT(*) AS n FROM cipher_players GROUP BY trial')) if (r.trial >= 1 && r.trial <= TRIALS.length) out[r.trial - 1] = r.n;
  return out;
}
export function sealedCounts(ctx: FeatureContext): number[] {
  const out = TRIALS.map(() => 0);
  for (const r of all<{ trial: number; n: number }>(ctx.db, 'SELECT trial, COUNT(*) AS n FROM cipher_seals GROUP BY trial')) if (r.trial >= 1 && r.trial <= TRIALS.length) out[r.trial - 1] = r.n;
  return out;
}

export function cipherPoints(ctx: FeatureContext, attendeeId: number): number {
  return ctx.points.totalFrom(attendeeId, SOURCE);
}

/** Guild race: members, cipher points, points per member (the fair measure for uneven guilds). */
export function standings(ctx: FeatureContext): GuildStanding[] {
  const rows = all<{ guild: Guild; members: number; points: number | null }>(
    ctx.db,
    `SELECT p.guild, COUNT(*) AS members, SUM(COALESCE(l.t, 0)) AS points FROM cipher_players p
       LEFT JOIN (SELECT attendee_id, SUM(points) AS t FROM points_ledger WHERE source = ? OR source LIKE ? || '.%' GROUP BY attendee_id) l ON l.attendee_id = p.attendee_id
      GROUP BY p.guild`,
    SOURCE,
    SOURCE,
  );
  const by = new Map(rows.map((r) => [r.guild, r]));
  const list = GUILDS.map((g) => {
    const r = by.get(g);
    const members = r?.members ?? 0;
    const points = r?.points ?? 0;
    return { guild: g, members, points, average: members ? Math.round((points / members) * 10) / 10 : 0, rank: 0 };
  });
  const sorted = [...list].sort((a, b) => b.average - a.average || b.points - a.points || GUILDS.indexOf(a.guild) - GUILDS.indexOf(b.guild));
  sorted.forEach((g, i) => (g.rank = i + 1));
  return list;
}

export function buildMe(ctx: FeatureContext, attendeeId: number): CipherMe {
  const visible = morseChallengeVisible(ctx);
  const t = ticketSet(ctx);
  const s = settings(ctx);
  const p = visible && t ? ensurePlayer(ctx, attendeeId, t) : null;
  const now = ctx.now();
  const seals = p ? sealedTrials(ctx, attendeeId) : new Map<number, { at: number; stars: number; points: number; fast: number }>();
  const stars: Star[] = TRIALS.map((id, i) => {
    const r = seals.get(i + 1);
    return { trial: id, sealedAt: r?.at ?? null, stars: r?.stars ?? 0, points: r?.points ?? 0 };
  });
  // streak: the latest seals in a row that beat their par time
  let streak = 0;
  for (let n = T.pact; n >= T.winds; n--) {
    const r = seals.get(n);
    if (!r) continue;
    if (r.fast) streak++;
    else break;
  }
  const trial = p?.trial ?? 1;
  const windsStart = trial === T.winds && p ? p.trial_started_at : null;
  const hint1At = windsStart !== null ? windsStart + s.windsHint1Sec * 1000 : null;
  const hint2At = windsStart !== null ? windsStart + s.windsHint2Sec * 1000 : null;
  const hint = hint2At !== null && now >= hint2At ? 2 : hint1At !== null && now >= hint1At ? 1 : 0;
  const whisper = p && t && trial === T.whisper ? whisperWord(ctx, p, t) : null;
  const eWord = p && t && trial >= T.echo ? echoWord(ctx, p, t) : null;
  const rAns = p && t && trial === T.riddle && p.riddle_hint ? riddleAnswer(slipEdges(ctx, t, p.serial, 3), p.riddle_rule ?? 'first') : null;
  const signal = signalView(ctx, attendeeId, trial);
  const pact = pactView(ctx, p, s);
  return {
    visible,
    ready: t !== null,
    ticket: p ? { serial: p.serial, guild: p.guild, claimedAt: p.claimed_at } : null,
    trial,
    nextSoon: trial === T.pact ? pact.status === 'locked' : trial === T.signal ? signal.status === 'idle' || signal.status === 'closed' : false,
    stars,
    points: p ? cipherPoints(ctx, attendeeId) : 0,
    streak,
    trialStartedAt: p ? p.trial_started_at : null,
    parSec: s.parSec,
    crowd: onTrial(ctx),
    winds: { found: p ? foundEdges(p) : { bottom: false, right: false, top: false, left: false }, cursed: Boolean(p?.cursed), hint, hint1At, hint2At },
    echo: {
      edge: trial >= T.echo ? (p?.echo_edge ?? null) : null,
      letters: eWord ? eWord.length : null,
      // the word is on the player's slip II, to be decoded: it travels only once the echo is sealed
      word: trial > T.echo ? eWord : null,
      tries: p?.echo_tries ?? 0,
      triesLeft: Math.max(0, s.echoTries - (p?.echo_tries ?? 0)),
      stars: seals.get(T.echo)?.stars ?? 0,
    },
    whisper: {
      signal: whisper ? farnsworthSignal(whisper, s.whisperWpm, s.whisperFarnsworthWpm) : null,
      hintsUsed: p?.whisper_hints ?? 0,
      firstLetter: whisper && (p?.whisper_hints ?? 0) >= 1 ? (whisper[0] as string) : null,
      letters: whisper && (p?.whisper_hints ?? 0) >= 2 ? whisper.length : null,
      tries: p?.whisper_tries ?? 0,
      hintCost: s.whisperHintCost,
    },
    riddle: { rule: trial >= T.riddle ? (p?.riddle_rule ?? null) : null, hintEdge: rAns?.edge ?? null, hintUsed: Boolean(p?.riddle_hint), tries: p?.riddle_tries ?? 0, hintCost: s.riddleHintCost },
    pact,
    signal,
  };
}

export function screenView(ctx: FeatureContext): CipherScreen {
  const sig = screenSignal(ctx);
  return {
    visible: morseChallengeVisible(ctx),
    players: one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM cipher_players')?.n ?? 0,
    guilds: standings(ctx),
    onTrial: onTrial(ctx),
    sealed: sealedCounts(ctx),
    pactsSealed: pactsSealed(ctx),
    recentPacts: recentPacts(ctx),
    signal: sig.view,
    signalPlay: sig.play,
    firstAnswers: sig.first,
  };
}

export function adminView(ctx: FeatureContext): CipherAdmin {
  const t = ticketSet(ctx);
  const players = all<{ attendee_id: number; nickname: string | null; serial: number; guild: Guild; trial: number; trial_started_at: number; claimed_at: number; stars: number | null }>(
    ctx.db,
    `SELECT p.attendee_id, a.nickname, p.serial, p.guild, p.trial, p.trial_started_at, p.claimed_at,
            (SELECT SUM(stars) FROM cipher_seals s WHERE s.attendee_id = p.attendee_id) AS stars
       FROM cipher_players p JOIN attendees a ON a.id = p.attendee_id ORDER BY p.trial DESC, p.trial_started_at ASC`,
  );
  const pacts = adminPacts(ctx);
  const sig = adminSignal(ctx);
  const set = t ? one<{ copies: number; trail_id: number }>(ctx.db, 'SELECT copies, trail_id FROM hunt_slip_sets WHERE id = ?', t.setId) : undefined;
  const claimed = t ? (one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM hunt_slip_copies WHERE slip_id = ? AND claimed_by IS NOT NULL', t.slips[0] as number)?.n ?? 0) : 0;
  return {
    visible: morseChallengeVisible(ctx),
    set: t && set ? { id: t.setId, trailId: set.trail_id, copies: set.copies, claimed } : null,
    settings: settings(ctx),
    players: players.map((r) => ({
      attendeeId: r.attendee_id,
      nickname: r.nickname ?? `#${r.attendee_id}`,
      serial: r.serial,
      guild: r.guild,
      trial: r.trial,
      trialStartedAt: r.trial_started_at,
      claimedAt: r.claimed_at,
      stars: r.stars ?? 0,
      points: cipherPoints(ctx, r.attendee_id),
      pact: pacts.partnerOf.get(r.attendee_id) ?? null,
    })),
    onTrial: onTrial(ctx),
    sealed: sealedCounts(ctx),
    guilds: standings(ctx),
    pacts: pacts.list,
    waiting: waitingList(ctx),
    signal: sig.view,
    signalWord: sig.word,
  };
}

/** The organisers' private answer key: every serial, its guild, all sixteen edges and each trial's answer. */
export function answerKeyCsv(ctx: FeatureContext): string {
  const t = ticketSet(ctx);
  const head = ['serial', 'guild'];
  for (const n of SLIP_NAMES) for (const e of SLIP_EDGES) head.push(`${n}_${e}`);
  head.push('I_top_upside_down_morse', 'echo_edge_II', 'echo_word', 'riddle_rule', 'riddle_answer', 'whisper_word', 'claimed_by', 'trial');
  const lines = [head.join(',')];
  if (!t) return `${lines.join('\n')}\n`;
  const serials = all<{ id: number; serial: number }>(ctx.db, 'SELECT id, serial FROM hunt_slip_copies WHERE slip_id = ? ORDER BY serial', t.slips[0] as number);
  const players = new Map(
    all<{ serial: number; nickname: string | null; trial: number; echo_edge: SlipEdge | null; riddle_rule: 'first' | 'last' | null }>(
      ctx.db,
      'SELECT p.serial, a.nickname, p.trial, p.echo_edge, p.riddle_rule FROM cipher_players p JOIN attendees a ON a.id = p.attendee_id',
    ).map((r) => [r.serial, r]),
  );
  const cell = (v: string | number | null | undefined) => {
    const x = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
  };
  for (const c of serials) {
    const slips = [1, 2, 3, 4].map((n) => slipEdges(ctx, t, c.serial, n));
    const whisper = ensureWhisper(ctx, c.id, slips.flatMap((e) => Object.values(e) as string[]));
    const pl = players.get(c.serial);
    const top = slips[0]!.top;
    const echoEdge = pl?.echo_edge ?? null;
    const rule = pl?.riddle_rule ?? null;
    const row: (string | number | null | undefined)[] = [pad(c.serial), copyDesign(ctx, c.id, c.serial, 1)];
    for (const e of slips) for (const edge of SLIP_EDGES) row.push(e[edge]);
    row.push(top ? reverseReading(slipWordKey(top)) : '', echoEdge, echoEdge ? slips[1]![echoEdge] : '', rule, rule ? riddleAnswer(slips[2]!, rule)?.word : `${riddleAnswer(slips[2]!, 'first')?.word ?? ''} / ${riddleAnswer(slips[2]!, 'last')?.word ?? ''}`, whisper, pl?.nickname, pl?.trial);
    lines.push(row.map(cell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** The Oracle's printed ticket (fixed words, console only). */
export function printSheet(ctx: FeatureContext) {
  return { oracle: settings(ctx).oracle };
}

export function reset(ctx: FeatureContext): void {
  tx(ctx.db, () => {
    run(ctx.db, 'DELETE FROM cipher_answers');
    run(ctx.db, 'DELETE FROM cipher_signals');
    run(ctx.db, 'DELETE FROM cipher_pacts');
    run(ctx.db, 'DELETE FROM cipher_seals');
    run(ctx.db, 'DELETE FROM cipher_players');
  });
  ctx.points.revokeSource(SOURCE);
  ctx.stickers.revokePrefix('cipher-');
  touch(ctx);
}
