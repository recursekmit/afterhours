// Trial 7, the last signal. The organiser warns ("in 5 minutes") and fires it from the console; at that
// moment every eligible phone gets its OWN 4-5 letter word (no projector: nobody can shout one answer to the
// hall) and beeps, flashes and buzzes it, replayable like the whisper. Players who sealed trials 1-6 type
// it: the first N correct win big, every correct answer wins something. Closing it crowns the guild with the
// most cipher points per member. Server-authoritative: a player's word is derived from the signal's secret
// word and their id; the phone gets only its on/off timing, and the word after the reveal.
import { type CipherScreen, GUILD_INFO, type GuessResult, type Guild, type SignalFire, type SignalView, farnsworthSignal, isMorseWord } from '@afterhours/shared/features/cipher';
import { normaliseWord } from '@afterhours/shared/features/morse';
import { createHash } from 'node:crypto';
import { type FeatureContext, all, badRequest, conflict, getPublicAttendee, one, run, tx } from '../../core';
import { SOURCE, STICKERS, T, buildMe, getPlayer, requireVisible, seal, settings, standings, state, touch } from './service';
import { SIGNAL_WORDS, candidates } from './words';

interface SignalRow {
  id: number;
  word: string;
  status: 'warned' | 'live' | 'closed';
  warn_at: number | null;
  fire_at: number;
  closes_at: number | null;
  revealed: number;
  winner: Guild | null;
  created_at: number;
}

/** The 4-5 letter pool, in a fixed order (a player's word is an index into it). */
const POOL = SIGNAL_WORDS.filter((w) => w.length >= 4 && w.length <= 5);

/**
 * This player's word for this signal: stable for the signal, different per player (mostly), and not
 * guessable without the signal's secret word.
 */
export function wordFor(r: { id: number; word: string }, attendeeId: number): string {
  const h = createHash('sha256').update(`${r.id}:${r.word}:${attendeeId}`).digest();
  return POOL[h.readUInt32BE(0) % POOL.length] as string;
}

const latest = (ctx: FeatureContext): SignalRow | undefined => one<SignalRow>(ctx.db, 'SELECT * FROM cipher_signals ORDER BY id DESC LIMIT 1');
const publish = (ctx: FeatureContext, status: SignalView['status']) => ctx.live.publish('cipher.signal', { status, at: ctx.now() }, 'all');

/** Move the latest signal along the clock: warned -> live at fire time, live -> closed after the window. */
function current(ctx: FeatureContext): SignalRow | undefined {
  const r = latest(ctx);
  if (!r) return r;
  const now = ctx.now();
  if (r.status === 'warned' && now >= r.fire_at) {
    run(ctx.db, "UPDATE cipher_signals SET status = 'live', closes_at = ? WHERE id = ? AND status = 'warned'", r.fire_at + settings(ctx).signalWindowSec * 1000, r.id);
    publish(ctx, 'live');
    return current(ctx);
  }
  if (r.status === 'live' && r.closes_at !== null && now >= r.closes_at) {
    closeSignal(ctx, r);
    return latest(ctx);
  }
  return r;
}

/** Close a live signal: the guild with the most cipher points per member wins; its members get the crown. */
function closeSignal(ctx: FeatureContext, r: SignalRow): void {
  const s = settings(ctx);
  tx(ctx.db, () => {
    const changed = run(ctx.db, "UPDATE cipher_signals SET status = 'closed', closes_at = MIN(COALESCE(closes_at, ?), ?) WHERE id = ? AND status != 'closed'", ctx.now(), ctx.now(), r.id).changes;
    if (!changed) return;
    const top = standings(ctx).find((g) => g.rank === 1 && g.members > 0 && g.points > 0);
    if (!top) return;
    run(ctx.db, 'UPDATE cipher_signals SET winner = ? WHERE id = ?', top.guild, r.id);
    for (const m of all<{ attendee_id: number }>(ctx.db, 'SELECT attendee_id FROM cipher_players WHERE guild = ?', top.guild)) {
      if (s.points.champion > 0) ctx.points.award({ attendeeId: m.attendee_id, source: SOURCE, ref: `champion:${r.id}`, points: s.points.champion, label: `cipher: ${GUILD_INFO[top.guild].title} wins` });
      ctx.stickers.unlock(m.attendee_id, STICKERS.champion);
    }
  });
  touch(ctx);
  publish(ctx, 'closed');
}

function drawWord(ctx: FeatureContext): string {
  const used = new Set(all<{ word: string }>(ctx.db, 'SELECT word FROM cipher_signals').map((r) => r.word));
  return candidates(SIGNAL_WORDS, 4, 5).find((w) => !used.has(w)) ?? (candidates(SIGNAL_WORDS, 4, 5)[0] as string);
}

function cleanWord(w: string | undefined, ctx: FeatureContext): string {
  if (!w?.trim()) return drawWord(ctx);
  const n = normaliseWord(w);
  if (n.length < 3 || n.length > 6 || !isMorseWord(n)) throw badRequest('The last signal is one word of 3 to 6 letters.');
  return n;
}

export function signalAction(ctx: FeatureContext, a: SignalFire): void {
  const s = settings(ctx);
  const r = current(ctx);
  const open = r && r.status !== 'closed' ? r : undefined;
  const now = ctx.now();
  switch (a.action) {
    case 'warn': {
      if (open) throw conflict(open.status === 'live' ? 'The last signal is already live.' : 'The last signal is already announced. Fire it or cancel it.');
      const inSec = a.inSec ?? s.signalWarnSec;
      run(ctx.db, "INSERT INTO cipher_signals (word, status, warn_at, fire_at, created_at) VALUES (?, 'warned', ?, ?, ?)", cleanWord(a.word, ctx), now, now + inSec * 1000, now);
      publish(ctx, 'warned');
      current(ctx);
      break;
    }
    case 'fire': {
      if (open?.status === 'live') throw conflict('The last signal is already live.');
      if (open) run(ctx.db, "UPDATE cipher_signals SET status = 'live', fire_at = ?, closes_at = ? WHERE id = ?", now, now + s.signalWindowSec * 1000, open.id);
      else run(ctx.db, "INSERT INTO cipher_signals (word, status, warn_at, fire_at, closes_at, created_at) VALUES (?, 'live', NULL, ?, ?, ?)", cleanWord(a.word, ctx), now, now + s.signalWindowSec * 1000, now);
      publish(ctx, 'live');
      break;
    }
    case 'close': {
      if (!open) throw conflict('No last signal is open.');
      closeSignal(ctx, open);
      break;
    }
    case 'reveal': {
      if (!r) throw conflict('No last signal yet.');
      if (open) closeSignal(ctx, open);
      run(ctx.db, 'UPDATE cipher_signals SET revealed = 1 WHERE id = ?', r.id);
      publish(ctx, 'closed');
      break;
    }
    case 'cancel': {
      if (open?.status !== 'warned') throw conflict('Only an announced (not yet live) signal can be called off.');
      run(ctx.db, 'DELETE FROM cipher_signals WHERE id = ?', open.id);
      publish(ctx, 'idle');
      break;
    }
  }
  touch(ctx);
}

export function signalTick(ctx: FeatureContext): void {
  current(ctx);
}

function view(ctx: FeatureContext, r: SignalRow | undefined, attendeeId: number | null, trial: number): SignalView {
  const s = settings(ctx);
  if (!r) return { id: null, status: 'idle', warnAt: null, fireAt: null, closesAt: null, letters: null, eligible: false, answered: null, firstN: s.signalFirstN, correct: 0, revealed: false, word: null, winner: null, play: null };
  const mine = attendeeId === null ? null : wordFor(r, attendeeId);
  const eligible = r.status === 'live' && trial === T.signal;
  const answered = attendeeId === null ? undefined : one<{ rank: number; points: number }>(ctx.db, 'SELECT rank, points FROM cipher_answers WHERE signal_id = ? AND attendee_id = ?', r.id, attendeeId);
  return {
    id: r.id,
    status: r.status,
    warnAt: r.warn_at,
    fireAt: r.fire_at,
    closesAt: r.closes_at,
    letters: r.status === 'warned' || !mine ? null : mine.length,
    eligible,
    answered: answered ?? null,
    firstN: s.signalFirstN,
    correct: one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM cipher_answers WHERE signal_id = ?', r.id)?.n ?? 0,
    revealed: Boolean(r.revealed),
    word: r.revealed && mine ? mine : null,
    winner: r.winner,
    // the phone plays its own word while live, until it is caught
    play: eligible && mine && !answered ? farnsworthSignal(mine, s.signalWpm, Math.max(2, s.signalWpm * 0.6)) : null,
  };
}

export function signalView(ctx: FeatureContext, attendeeId: number | null, trial: number): SignalView {
  return view(ctx, current(ctx), attendeeId, trial);
}

export function screenSignal(ctx: FeatureContext): { view: SignalView; play: CipherScreen['signalPlay']; first: CipherScreen['firstAnswers'] } {
  const s = settings(ctx);
  const r = current(ctx);
  const v = view(ctx, r, null, 0);
  // Every phone has its own word now, so a big screen has nothing to play (kept for the screen's shape).
  const play = null;
  const first = r
    ? all<{ attendee_id: number; rank: number; guild: Guild }>(
        ctx.db,
        'SELECT x.attendee_id, x.rank, p.guild FROM cipher_answers x JOIN cipher_players p ON p.attendee_id = x.attendee_id WHERE x.signal_id = ? ORDER BY x.rank LIMIT ?',
        r.id,
        s.signalFirstN,
      ).flatMap((a) => {
        const pa = getPublicAttendee(ctx, a.attendee_id);
        return pa ? [{ nickname: pa.nickname, avatar: pa.avatar, guild: a.guild, rank: a.rank }] : [];
      })
    : [];
  return { view: v, play, first };
}

export function adminSignal(ctx: FeatureContext): { view: SignalView; word: string | null } {
  const r = current(ctx);
  return { view: view(ctx, r, null, 0), word: r?.word ?? null };
}

export function answerSignal(ctx: FeatureContext, attendeeId: number, guess: string): GuessResult {
  requireVisible(ctx);
  const r = current(ctx);
  if (!r || r.status !== 'live') throw conflict(r?.status === 'warned' ? 'The last signal has not been sent yet. Keep your phone in hand.' : 'The last signal is not live.');
  const p = getPlayer(ctx, attendeeId);
  if (!p || p.trial < T.signal) throw conflict('Seal the pact first: the last signal is for those who did.');
  const already = one<{ rank: number }>(ctx.db, 'SELECT rank FROM cipher_answers WHERE signal_id = ? AND attendee_id = ?', r.id, attendeeId);
  if (already) return { correct: true, close: false, points: 0, message: `you already caught it: #${already.rank}.`, me: buildMe(ctx, attendeeId) };
  state(ctx).answers.enforce(`signal:${attendeeId}`, 'Easy: play it again, then answer.');
  if (normaliseWord(guess) !== wordFor(r, attendeeId)) return { correct: false, close: false, points: 0, message: 'not that one. play it again and check the chart.', me: buildMe(ctx, attendeeId) };
  const s = settings(ctx);
  const res = tx(ctx.db, () => {
    const rank = (one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM cipher_answers WHERE signal_id = ?', r.id)?.n ?? 0) + 1;
    const first = rank <= s.signalFirstN;
    const pts = first ? s.points.signalFirst : s.points.signalCorrect;
    run(ctx.db, 'INSERT INTO cipher_answers (signal_id, attendee_id, rank, points, at) VALUES (?, ?, ?, ?, ?)', r.id, attendeeId, rank, pts, ctx.now());
    const paid = seal(ctx, attendeeId, T.signal, { points: pts, stars: first ? 3 : 2, speed: false }) ?? 0;
    return { rank, first, paid };
  });
  touch(ctx);
  return {
    correct: true,
    close: false,
    points: res.paid,
    message: res.first ? `#${res.rank}! one of the first ${s.signalFirstN}. your guild heard you.` : `#${res.rank}. caught it. every signal counts for your guild.`,
    me: buildMe(ctx, attendeeId),
  };
}
