// Trial 6, the pact: the server pairs you with someone on this trial from ANOTHER guild. You scan their
// slip IV at the edge we name, they scan yours; when both scans land, both seal it. Partner scans never
// claim anything. After the wait (pactWaitSec) with no partner, or with a partner who has not scanned,
// you may re-pair or go to the Oracle: an organiser with a printed Oracle ticket (fixed words, console
// only) whose half is always done.
import type { CipherSettings, Guild, PactView } from '@afterhours/shared/features/cipher';
import { SLIP_EDGES, type SlipEdge } from '@afterhours/shared/morse-slip';
import { randomInt } from 'node:crypto';
import { type FeatureContext, all, conflict, getPublicAttendee, one, run, tx } from '../../core';
import { type PlayerRow, T, buildMe, getPlayer, requireVisible, seal, settings, slipEdges, ticketSet, touch, whichEdge } from './service';

interface PactRow {
  id: number;
  a_id: number;
  b_id: number | null;
  oracle: number;
  a_edge: SlipEdge;
  b_edge: SlipEdge;
  a_scanned_at: number | null;
  b_scanned_at: number | null;
  status: 'open' | 'sealed' | 'broken';
  created_at: number;
  sealed_at: number | null;
}

const pickEdge = (): SlipEdge => SLIP_EDGES[randomInt(SLIP_EDGES.length)] as SlipEdge;
const openPactOf = (ctx: FeatureContext, id: number): PactRow | undefined =>
  one<PactRow>(ctx.db, "SELECT * FROM cipher_pacts WHERE status = 'open' AND (a_id = ? OR b_id = ?) ORDER BY id DESC LIMIT 1", id, id);
const notify = (ctx: FeatureContext, id: number | null) => {
  if (id !== null) ctx.live.publish('cipher.me', { at: ctx.now() }, { attendeeId: id });
};

/** Join the pool (idempotent) and try to pair. */
export function enterPool(ctx: FeatureContext, attendeeId: number): void {
  run(ctx.db, 'UPDATE cipher_players SET pact_since = COALESCE(pact_since, ?) WHERE attendee_id = ? AND trial = ?', ctx.now(), attendeeId, T.pact);
  if (settings(ctx).pactOpen) tryPair(ctx, attendeeId);
}

/** Pair a waiting player with the longest-waiting player of another guild (not one they just left). */
export function tryPair(ctx: FeatureContext, attendeeId: number): PactRow | null {
  return tx(ctx.db, () => {
    const me = getPlayer(ctx, attendeeId);
    if (!me || me.trial !== T.pact) return null;
    const have = openPactOf(ctx, attendeeId);
    if (have) return have;
    if (me.pact_since === null) run(ctx.db, 'UPDATE cipher_players SET pact_since = ? WHERE attendee_id = ?', ctx.now(), attendeeId);
    const candidates = all<{ attendee_id: number }>(
      ctx.db,
      `SELECT p.attendee_id FROM cipher_players p
        WHERE p.trial = ? AND p.attendee_id != ? AND p.guild != ? AND p.pact_since IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM cipher_pacts x WHERE x.status = 'open' AND (x.a_id = p.attendee_id OR x.b_id = p.attendee_id))
        ORDER BY p.pact_since, p.attendee_id`,
      T.pact,
      attendeeId,
      me.guild,
    );
    const left = new Set(
      all<{ other: number }>(
        ctx.db,
        "SELECT CASE WHEN a_id = ? THEN b_id ELSE a_id END AS other FROM cipher_pacts WHERE status = 'broken' AND (a_id = ? OR b_id = ?) AND b_id IS NOT NULL",
        attendeeId,
        attendeeId,
        attendeeId,
      ).map((r) => r.other),
    );
    const partner = candidates.find((c) => !left.has(c.attendee_id)) ?? candidates[0];
    if (!partner) return null;
    const id = run(
      ctx.db,
      "INSERT INTO cipher_pacts (a_id, b_id, oracle, a_edge, b_edge, status, created_at) VALUES (?, ?, 0, ?, ?, 'open', ?)",
      attendeeId,
      partner.attendee_id,
      pickEdge(),
      pickEdge(),
      ctx.now(),
    ).lastId;
    run(ctx.db, 'UPDATE cipher_players SET pact_since = NULL WHERE attendee_id IN (?, ?)', attendeeId, partner.attendee_id);
    touch(ctx);
    notify(ctx, partner.attendee_id);
    return one<PactRow>(ctx.db, 'SELECT * FROM cipher_pacts WHERE id = ?', id) ?? null;
  });
}

/** Each side of a pact from one player's point of view. */
function sides(p: PactRow, me: number) {
  const isA = p.a_id === me;
  return {
    partnerId: isA ? p.b_id : p.a_id,
    /** the edge of the partner's slip IV (or the Oracle's ticket) I scan */
    scanEdge: isA ? p.b_edge : p.a_edge,
    /** the edge of my slip IV they scan */
    showEdge: isA ? p.a_edge : p.b_edge,
    iScanned: (isA ? p.a_scanned_at : p.b_scanned_at) !== null,
    theyScanned: p.oracle ? true : (isA ? p.b_scanned_at : p.a_scanned_at) !== null,
  };
}

export function pactView(ctx: FeatureContext, p: PlayerRow | null | undefined, s: CipherSettings): PactView {
  const base: PactView = { status: 'locked', partner: null, scanEdge: null, showEdge: null, iScanned: false, theyScanned: false, since: null, canRepair: false, waiting: 0 };
  if (!p) return base;
  if (p.trial > T.pact) return { ...base, status: 'sealed' };
  if (p.trial < T.pact || !s.pactOpen) return base;
  const now = ctx.now();
  const pact = openPactOf(ctx, p.attendee_id) ?? tryPair(ctx, p.attendee_id);
  const waiting = waitingList(ctx).length;
  if (!pact) {
    const since = getPlayer(ctx, p.attendee_id)?.pact_since ?? now;
    return { ...base, status: 'waiting', since, canRepair: now - since >= s.pactWaitSec * 1000, waiting };
  }
  const sd = sides(pact, p.attendee_id);
  const partner = sd.partnerId !== null ? getPublicAttendee(ctx, sd.partnerId) : null;
  const pg = sd.partnerId !== null ? getPlayer(ctx, sd.partnerId)?.guild : undefined;
  return {
    status: pact.oracle ? 'oracle' : 'paired',
    partner: partner && pg ? { nickname: partner.nickname, avatar: partner.avatar, guild: pg } : null,
    scanEdge: sd.scanEdge,
    showEdge: pact.oracle ? null : sd.showEdge,
    iScanned: sd.iScanned,
    theyScanned: sd.theyScanned,
    since: pact.created_at,
    canRepair: !pact.oracle && now - pact.created_at >= s.pactWaitSec * 1000,
    waiting,
  };
}

type PactScan = { outcome: 'pact_half' | 'pact_sealed' | 'again' | 'not_yours'; message: string; edge: SlipEdge | null; points: number };

/** A scan while on the pact: the partner's slip IV (or the Oracle's ticket) at the named edge. Never claims. */
export function pactScan(ctx: FeatureContext, p: PlayerRow, keys: Set<string>, mySlip: number | null): PactScan | null {
  const pact = openPactOf(ctx, p.attendee_id);
  if (!pact) return mySlip ? { outcome: 'again', message: 'no partner yet. hold on to slip IV: we are finding you someone from another guild.', edge: null, points: 0 } : null;
  const t = ticketSet(ctx);
  if (!t) return null;
  const sd = sides(pact, p.attendee_id);
  const s = settings(ctx);
  let target: Partial<Record<SlipEdge, string>>;
  let partnerSlips: Partial<Record<SlipEdge, string>>[] = [];
  if (pact.oracle) target = s.oracle;
  else {
    const partner = getPlayer(ctx, sd.partnerId as number);
    if (!partner) return null;
    partnerSlips = [1, 2, 3, 4].map((n) => slipEdges(ctx, t, partner.serial, n));
    target = partnerSlips[3] as Partial<Record<SlipEdge, string>>;
  }
  const hit = whichEdge(target, keys);
  const who = pact.oracle ? 'the Oracle’s ticket' : 'their slip IV';
  if (!hit) {
    const other = partnerSlips.findIndex((e, i) => i < 3 && whichEdge(e, keys));
    if (other >= 0) return { outcome: 'again', message: `that is their slip ${['I', 'II', 'III'][other]}. the pact is sealed on slip IV.`, edge: null, points: 0 };
    if (mySlip === 4) return { outcome: 'again', message: 'that is your own slip IV: your partner scans that one. you scan theirs.', edge: null, points: 0 };
    if (mySlip) return { outcome: 'again', message: `that is your own slip. scan ${who}.`, edge: null, points: 0 };
    return null;
  }
  if (hit.edge !== sd.scanEdge) return { outcome: 'again', message: `right ticket, wrong edge: turn ${who} so its ${sd.scanEdge} edge is at the bottom.`, edge: null, points: 0 };
  const isA = pact.a_id === p.attendee_id;
  run(ctx.db, `UPDATE cipher_pacts SET ${isA ? 'a_scanned_at' : 'b_scanned_at'} = COALESCE(${isA ? 'a_scanned_at' : 'b_scanned_at'}, ?) WHERE id = ?`, ctx.now(), pact.id);
  const now = one<PactRow>(ctx.db, 'SELECT * FROM cipher_pacts WHERE id = ?', pact.id) as PactRow;
  const both = now.a_scanned_at !== null && (now.oracle === 1 || now.b_scanned_at !== null);
  touch(ctx);
  if (!both) {
    notify(ctx, sd.partnerId);
    return { outcome: 'pact_half', message: 'your half of the pact is sealed. now they scan your slip IV.', edge: hit.edge, points: 0 };
  }
  const points = sealPact(ctx, now);
  return { outcome: 'pact_sealed', message: pact.oracle ? 'the Oracle accepts your pact. sealed.' : 'both scans landed. the pact is sealed.', edge: hit.edge, points: points.get(p.attendee_id) ?? 0 };
}

function sealPact(ctx: FeatureContext, pact: PactRow): Map<number, number> {
  const s = settings(ctx);
  const paid = new Map<number, number>();
  tx(ctx.db, () => {
    run(ctx.db, "UPDATE cipher_pacts SET status = 'sealed', sealed_at = ? WHERE id = ? AND status = 'open'", ctx.now(), pact.id);
    for (const id of [pact.a_id, pact.b_id]) if (id !== null) paid.set(id, seal(ctx, id, T.pact, { points: s.points.pact }) ?? 0);
  });
  notify(ctx, pact.a_id);
  notify(ctx, pact.b_id);
  return paid;
}

function breakOpen(ctx: FeatureContext, pact: PactRow): void {
  run(ctx.db, "UPDATE cipher_pacts SET status = 'broken' WHERE id = ? AND status = 'open'", pact.id);
  for (const id of [pact.a_id, pact.b_id]) if (id !== null) run(ctx.db, 'UPDATE cipher_players SET pact_since = ? WHERE attendee_id = ? AND trial = ?', ctx.now(), id, T.pact);
}

function requirePact(ctx: FeatureContext, attendeeId: number): { p: PlayerRow; view: PactView } {
  requireVisible(ctx);
  const s = settings(ctx);
  const p = getPlayer(ctx, attendeeId);
  if (!p || p.trial !== T.pact || !s.pactOpen) throw conflict('The pact is not your trial right now.');
  return { p, view: pactView(ctx, p, s) };
}

/** After the wait: a new partner (another guild, not the one you leave behind if anyone else is free). */
export function repair(ctx: FeatureContext, attendeeId: number) {
  const { view } = requirePact(ctx, attendeeId);
  if (!view.canRepair && view.status !== 'waiting') throw conflict('Give your partner a moment first.');
  tx(ctx.db, () => {
    const pact = openPactOf(ctx, attendeeId);
    if (pact && !pact.oracle) breakOpen(ctx, pact);
    // the one who asked goes first (never back to the partner they left, if anyone else is free)
    tryPair(ctx, attendeeId);
    const other = pact && !pact.oracle ? (pact.a_id === attendeeId ? pact.b_id : pact.a_id) : null;
    if (other !== null) {
      tryPair(ctx, other);
      notify(ctx, other);
    }
  });
  touch(ctx);
  return buildMe(ctx, attendeeId);
}

/** After the wait: the Oracle (an organiser with the Oracle's printed ticket) completes the pact. */
export function goOracle(ctx: FeatureContext, attendeeId: number) {
  const { view } = requirePact(ctx, attendeeId);
  if (!view.canRepair) throw conflict('The Oracle sees you after the wait. Hold on a little.');
  tx(ctx.db, () => {
    const pact = openPactOf(ctx, attendeeId);
    if (pact) {
      breakOpen(ctx, pact);
      const other = pact.a_id === attendeeId ? pact.b_id : pact.a_id;
      if (other !== null) {
        tryPair(ctx, other);
        notify(ctx, other);
      }
    }
    run(ctx.db, "INSERT INTO cipher_pacts (a_id, b_id, oracle, a_edge, b_edge, status, created_at) VALUES (?, NULL, 1, 'bottom', ?, 'open', ?)", attendeeId, pickEdge(), ctx.now());
    run(ctx.db, 'UPDATE cipher_players SET pact_since = NULL WHERE attendee_id = ?', attendeeId);
  });
  touch(ctx);
  return buildMe(ctx, attendeeId);
}

/** Console: break a pact and pair both players again. */
export function breakPact(ctx: FeatureContext, id: number): void {
  const pact = one<PactRow>(ctx.db, "SELECT * FROM cipher_pacts WHERE id = ? AND status = 'open'", id);
  if (!pact) throw conflict('That pact is not open.');
  tx(ctx.db, () => {
    breakOpen(ctx, pact);
    for (const who of [pact.a_id, pact.b_id]) if (who !== null) tryPair(ctx, who);
  });
  notify(ctx, pact.a_id);
  notify(ctx, pact.b_id);
  touch(ctx);
}

const nick = (ctx: FeatureContext, id: number | null) => (id === null ? 'the oracle' : (getPublicAttendee(ctx, id)?.nickname ?? `#${id}`));

export function adminPacts(ctx: FeatureContext) {
  const rows = all<PactRow>(ctx.db, "SELECT * FROM cipher_pacts ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, id DESC LIMIT 80");
  const partnerOf = new Map<number, string>();
  for (const r of rows) {
    if (r.status !== 'open') continue;
    partnerOf.set(r.a_id, nick(ctx, r.b_id));
    if (r.b_id !== null) partnerOf.set(r.b_id, nick(ctx, r.a_id));
  }
  return {
    list: rows.map((r) => ({ id: r.id, a: nick(ctx, r.a_id), b: r.oracle ? null : nick(ctx, r.b_id), oracle: r.oracle === 1, status: r.status, aScanned: r.a_scanned_at !== null, bScanned: r.oracle === 1 || r.b_scanned_at !== null, createdAt: r.created_at })),
    partnerOf,
  };
}

export function waitingList(ctx: FeatureContext): { attendeeId: number; nickname: string; guild: Guild; since: number }[] {
  return all<{ attendee_id: number; nickname: string | null; guild: Guild; since: number }>(
    ctx.db,
    `SELECT p.attendee_id, a.nickname, p.guild, COALESCE(p.pact_since, p.trial_started_at) AS since FROM cipher_players p JOIN attendees a ON a.id = p.attendee_id
      WHERE p.trial = ? AND NOT EXISTS (SELECT 1 FROM cipher_pacts x WHERE x.status = 'open' AND (x.a_id = p.attendee_id OR x.b_id = p.attendee_id))
      ORDER BY since`,
    T.pact,
  ).map((r) => ({ attendeeId: r.attendee_id, nickname: r.nickname ?? `#${r.attendee_id}`, guild: r.guild, since: r.since }));
}

export function recentPacts(ctx: FeatureContext): { a: string; b: string; ga: Guild; gb: Guild | null; at: number }[] {
  return all<{ a_id: number; b_id: number | null; ga: Guild; gb: Guild | null; sealed_at: number }>(
    ctx.db,
    `SELECT x.a_id, x.b_id, pa.guild AS ga, pb.guild AS gb, x.sealed_at FROM cipher_pacts x
       JOIN cipher_players pa ON pa.attendee_id = x.a_id LEFT JOIN cipher_players pb ON pb.attendee_id = x.b_id
      WHERE x.status = 'sealed' ORDER BY x.sealed_at DESC LIMIT 6`,
  ).map((r) => ({ a: nick(ctx, r.a_id), b: nick(ctx, r.b_id), ga: r.ga, gb: r.gb, at: r.sealed_at }));
}

export const pactsSealed = (ctx: FeatureContext): number => one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM cipher_pacts WHERE status = 'sealed'")?.n ?? 0;

