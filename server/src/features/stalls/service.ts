// The money and the allowance. Everything here reads state that is DERIVED from stalls_txn rows with
// status 'ok', so a void restores balance, free drinks, stock and per-person limits in one update.
import {
  type Allowance,
  type CartLine,
  type CommitResponse,
  type ItemView,
  MAX_ALLOWANCE,
  type Plan,
  type PlanItem,
  type PuzzleTokens,
  type Receipt,
  type StallBrief,
  type StallSettings,
  type Tally,
  planCart,
} from '@afterhours/shared/features/stalls';
import { type FeatureContext, HttpError, all, conflict, notFound, one, run, tx } from '../../core';
import { rewardsOf } from '../arcade/rounds';

/* ---------------------------------------------------------------- settings */

export function getSettings(ctx: FeatureContext): StallSettings {
  const rows = all<{ key: string; value: string }>(ctx.db, "SELECT key, value FROM stalls_meta WHERE key IN ('allowance', 'spendLowersBoard')");
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const allowance = Number(m.get('allowance') ?? 2);
  return {
    allowance: Number.isInteger(allowance) ? Math.min(MAX_ALLOWANCE, Math.max(0, allowance)) : 2,
    spendLowersBoard: m.get('spendLowersBoard') === 'true',
  };
}

export function setSettings(ctx: FeatureContext, patch: Partial<StallSettings>): StallSettings {
  const put = (k: string, v: string) => run(ctx.db, 'INSERT INTO stalls_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v);
  if (patch.allowance !== undefined) put('allowance', String(patch.allowance));
  if (patch.spendLowersBoard !== undefined) put('spendLowersBoard', String(patch.spendLowersBoard));
  return getSettings(ctx);
}

/* ---------------------------------------------------------------- wallet */

export function pointsSpent(ctx: FeatureContext, attendeeId: number): number {
  return one<{ t: number | null }>(ctx.db, "SELECT SUM(total_points) AS t FROM stalls_txn WHERE attendee_id = ? AND status = 'ok'", attendeeId)?.t ?? 0;
}

export function freeUsed(ctx: FeatureContext, attendeeId: number): number {
  return one<{ t: number | null }>(ctx.db, "SELECT SUM(free_used) AS t FROM stalls_txn WHERE attendee_id = ? AND status = 'ok'", attendeeId)?.t ?? 0;
}

export function allowanceOf(ctx: FeatureContext, attendeeId: number): Allowance {
  const total = getSettings(ctx).allowance;
  const used = freeUsed(ctx, attendeeId);
  return { total, used, left: Math.max(0, total - used) };
}

/** Spendable points: lifetime earned (core ledger) minus spent at stalls. Never below zero. */
export function balanceOf(ctx: FeatureContext, attendeeId: number): { earned: number; spent: number; balance: number } {
  const earned = ctx.points.total(attendeeId);
  const spent = pointsSpent(ctx, attendeeId);
  return { earned, spent, balance: Math.max(0, earned - spent) };
}

/** Puzzle-hour tokens from the arcade feature. Read only. Null if the arcade is unavailable. */
export function puzzleTokens(ctx: FeatureContext, attendeeId: number): PuzzleTokens | null {
  try {
    const r = rewardsOf(ctx.db, attendeeId);
    return { tokens: r.balance, cost: r.mocktailCost };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- menu */

interface ItemRow {
  id: number;
  stall_id: number;
  name: string;
  price: number;
  image: string | null;
  stock: number | null;
  per_person: number | null;
  free_drink: number;
  active: number;
  sold: number;
  bought: number;
}

const itemSelect = (personParam: boolean) => `
  SELECT i.id, i.stall_id, i.name, i.price, i.image, i.stock, i.per_person, i.free_drink, i.active,
         COALESCE((SELECT SUM(l.qty) FROM stalls_txn_line l JOIN stalls_txn t ON t.id = l.txn_id
                    WHERE l.item_id = i.id AND t.status = 'ok'), 0) AS sold,
         ${
           personParam
             ? `COALESCE((SELECT SUM(l.qty) FROM stalls_txn_line l JOIN stalls_txn t ON t.id = l.txn_id
                    WHERE l.item_id = i.id AND t.status = 'ok' AND t.attendee_id = ?), 0)`
             : '0'
         } AS bought
    FROM stalls_item i`;

export const imageUrl = (name: string | null): string | null => (name ? `/api/stalls/img/${name}` : null);

function toView(r: ItemRow): ItemView {
  return {
    id: r.id,
    stallId: r.stall_id,
    name: r.name,
    price: r.price,
    image: imageUrl(r.image),
    stockLeft: r.stock === null ? null : Math.max(0, r.stock - r.sold),
    limit: r.per_person,
    bought: r.bought,
    freeDrink: r.free_drink === 1,
  };
}

export function toPlanItem(r: ItemRow): PlanItem {
  return {
    id: r.id,
    name: r.name,
    price: r.price,
    freeDrink: r.free_drink === 1,
    stockLeft: r.stock === null ? null : Math.max(0, r.stock - r.sold),
    limitLeft: r.per_person === null ? null : Math.max(0, r.per_person - r.bought),
  };
}

/** Active items of one stall as seen by one person (their `bought` counts). */
export function itemRows(ctx: FeatureContext, stallId: number, attendeeId: number): ItemRow[] {
  return all<ItemRow>(ctx.db, `${itemSelect(true)} WHERE i.stall_id = ? AND i.active = 1 ORDER BY i.sort, i.id`, attendeeId, stallId);
}

export function menuFor(ctx: FeatureContext, stallId: number, attendeeId: number): ItemView[] {
  return itemRows(ctx, stallId, attendeeId).map(toView);
}

/** Cheapest on-sale free-drink item that has a points price. */
export function nextMocktail(ctx: FeatureContext): { name: string; price: number; stallName: string } | null {
  const r = one<{ name: string; price: number; stall: string }>(
    ctx.db,
    `SELECT i.name, i.price, s.name AS stall FROM stalls_item i JOIN stalls_stall s ON s.id = i.stall_id
      WHERE i.free_drink = 1 AND i.price > 0 AND i.active = 1 AND s.active = 1 ORDER BY i.price, i.id LIMIT 1`,
  );
  return r ? { name: r.name, price: r.price, stallName: r.stall } : null;
}

export function stallBrief(r: { id: number; name: string; emoji: string; location: string }): StallBrief {
  return { id: r.id, name: r.name, emoji: r.emoji, location: r.location };
}

export function activeStalls(ctx: FeatureContext): StallBrief[] {
  return all<{ id: number; name: string; emoji: string; location: string }>(
    ctx.db,
    'SELECT id, name, emoji, location FROM stalls_stall WHERE active = 1 ORDER BY sort, id',
  ).map(stallBrief);
}

/* ---------------------------------------------------------------- cart */

export function getCart(ctx: FeatureContext, attendeeId: number): CartLine[] {
  const row = one<{ lines: string }>(ctx.db, 'SELECT lines FROM stalls_cart WHERE attendee_id = ?', attendeeId);
  if (!row) return [];
  try {
    const j = JSON.parse(row.lines) as CartLine[];
    return Array.isArray(j) ? j.filter((l) => Number.isInteger(l.itemId) && Number.isInteger(l.qty) && l.qty > 0) : [];
  } catch {
    return [];
  }
}

export function setCart(ctx: FeatureContext, attendeeId: number, lines: CartLine[]): CartLine[] {
  // Keep only items that exist and are on sale, merged per item.
  const merged = new Map<number, number>();
  for (const l of lines) merged.set(l.itemId, Math.min(20, (merged.get(l.itemId) ?? 0) + l.qty));
  const ids = [...merged.keys()];
  const live = new Set(
    ids.length
      ? all<{ id: number }>(ctx.db, `SELECT i.id FROM stalls_item i JOIN stalls_stall s ON s.id = i.stall_id WHERE i.active = 1 AND s.active = 1 AND i.id IN (${ids.map(() => '?').join(',')})`, ...ids).map((r) => r.id)
      : [],
  );
  const clean = [...merged].filter(([id]) => live.has(id)).map(([itemId, qty]) => ({ itemId, qty }));
  run(
    ctx.db,
    'INSERT INTO stalls_cart (attendee_id, lines, updated_at) VALUES (?, ?, ?) ON CONFLICT(attendee_id) DO UPDATE SET lines = excluded.lines, updated_at = excluded.updated_at',
    attendeeId,
    JSON.stringify(clean),
    ctx.now(),
  );
  return clean;
}

/* ---------------------------------------------------------------- receipts + tally */

interface TxnRow {
  id: number;
  stall_id: number;
  stall_name: string;
  at: number;
  status: 'ok' | 'void';
  total_points: number;
  free_used: number;
}
interface LineRow {
  txn_id: number;
  item_name: string;
  qty: number;
  free_qty: number;
  points: number;
}

function linesOf(ctx: FeatureContext, txnIds: number[]): Map<number, LineRow[]> {
  const out = new Map<number, LineRow[]>();
  if (txnIds.length === 0) return out;
  const rows = all<LineRow>(
    ctx.db,
    `SELECT txn_id, item_name, qty, free_qty, points FROM stalls_txn_line WHERE txn_id IN (${txnIds.map(() => '?').join(',')}) ORDER BY id`,
    ...txnIds,
  );
  for (const r of rows) {
    const a = out.get(r.txn_id);
    if (a) a.push(r);
    else out.set(r.txn_id, [r]);
  }
  return out;
}

export function receiptsOf(ctx: FeatureContext, attendeeId: number, limit = 50): Receipt[] {
  const txns = all<TxnRow>(
    ctx.db,
    `SELECT t.id, t.stall_id, s.name AS stall_name, t.at, t.status, t.total_points, t.free_used
       FROM stalls_txn t JOIN stalls_stall s ON s.id = t.stall_id
      WHERE t.attendee_id = ? ORDER BY t.id DESC LIMIT ?`,
    attendeeId,
    limit,
  );
  const lines = linesOf(ctx, txns.map((t) => t.id));
  return txns.map((t) => ({
    id: t.id,
    stallId: t.stall_id,
    stallName: t.stall_name,
    at: t.at,
    status: t.status,
    totalPoints: t.total_points,
    freeUsed: t.free_used,
    lines: (lines.get(t.id) ?? []).map((l) => ({ name: l.item_name, qty: l.qty, freeQty: l.free_qty, points: l.points })),
  }));
}

export function tallyOf(ctx: FeatureContext, stallId: number): Tally {
  const t = one<{ n: number; p: number | null }>(ctx.db, "SELECT COUNT(*) AS n, SUM(total_points) AS p FROM stalls_txn WHERE stall_id = ? AND status = 'ok'", stallId);
  const byItem = all<{ item_id: number; name: string; qty: number; free: number }>(
    ctx.db,
    `SELECT l.item_id, MAX(l.item_name) AS name, SUM(l.qty) AS qty, SUM(l.free_qty) AS free
       FROM stalls_txn_line l JOIN stalls_txn t ON t.id = l.txn_id
      WHERE t.stall_id = ? AND t.status = 'ok' GROUP BY l.item_id ORDER BY qty DESC, l.item_id`,
    stallId,
  );
  return {
    txns: t?.n ?? 0,
    units: byItem.reduce((a, b) => a + b.qty, 0),
    freeUnits: byItem.reduce((a, b) => a + b.free, 0),
    points: t?.p ?? 0,
    byItem: byItem.map((b) => ({ itemId: b.item_id, name: b.name, qty: b.qty })),
  };
}

/* ---------------------------------------------------------------- commit */

function storedResult(ctx: FeatureContext, txnId: number, attendeeId: number, duplicate: boolean): CommitResponse {
  const t = one<{ id: number; stall_id: number; total_points: number; free_used: number }>(
    ctx.db,
    'SELECT id, stall_id, total_points, free_used FROM stalls_txn WHERE id = ?',
    txnId,
  );
  if (!t) throw notFound('No such purchase.');
  const stall = one<{ name: string }>(ctx.db, 'SELECT name FROM stalls_stall WHERE id = ?', t.stall_id);
  const nick = one<{ nickname: string | null }>(ctx.db, 'SELECT nickname FROM attendees WHERE id = ?', attendeeId);
  const lines = linesOf(ctx, [txnId]).get(txnId) ?? [];
  return {
    duplicate,
    txnId,
    stallName: stall?.name ?? '',
    lines: lines.map((l) => ({ name: l.item_name, qty: l.qty, freeQty: l.free_qty, points: l.points })),
    freeUsed: t.free_used,
    freeLeft: allowanceOf(ctx, attendeeId).left,
    pointsSpent: t.total_points,
    balance: balanceOf(ctx, attendeeId).balance,
    nickname: nick?.nickname ?? '',
    tally: tallyOf(ctx, t.stall_id),
  };
}

/**
 * Hand something over. One SQLite transaction: stock, per-person limits, balance and the free-drink
 * allowance are all checked against rows that cannot change underneath us (BEGIN IMMEDIATE), then the
 * purchase is written. The key makes a retry return the first result instead of charging twice.
 */
export function commit(ctx: FeatureContext, p: { attendeeId: number; stallId: number; key: string; lines: CartLine[] }): CommitResponse {
  const out = tx(ctx.db, () => {
    const prev = one<{ id: number; attendee_id: number; stall_id: number }>(ctx.db, 'SELECT id, attendee_id, stall_id FROM stalls_txn WHERE key = ?', p.key);
    if (prev) {
      if (prev.attendee_id !== p.attendeeId || prev.stall_id !== p.stallId) throw conflict('That key belongs to another purchase. Scan again.');
      return { txnId: prev.id, duplicate: true };
    }
    const stall = one<{ active: number }>(ctx.db, 'SELECT active FROM stalls_stall WHERE id = ?', p.stallId);
    if (!stall || stall.active !== 1) throw new HttpError(403, 'forbidden', 'This stall is closed.');
    const person = one<{ id: number }>(ctx.db, 'SELECT id FROM attendees WHERE id = ?', p.attendeeId);
    if (!person) throw notFound('No such attendee.');

    const rows = itemRows(ctx, p.stallId, p.attendeeId);
    const onMenu = new Set(rows.map((r) => r.id));
    if (p.lines.some((l) => !onMenu.has(l.itemId))) throw new HttpError(409, 'cannot_redeem', 'That item is not on this stall’s menu.');

    const plan: Plan = planCart({
      items: rows.map(toPlanItem),
      lines: p.lines,
      freeLeft: allowanceOf(ctx, p.attendeeId).left,
      balance: balanceOf(ctx, p.attendeeId).balance,
    });
    if (!plan.ok) throw new HttpError(409, 'cannot_redeem', plan.problems[0] ?? 'Cannot hand that over.', { issues: plan.problems.map((m) => ({ path: '', message: m })) });

    const now = ctx.now();
    const t = run(ctx.db, 'INSERT INTO stalls_txn (key, attendee_id, stall_id, total_points, free_used, at) VALUES (?, ?, ?, ?, ?, ?)', p.key, p.attendeeId, p.stallId, plan.points, plan.freeUsed, now);
    for (const l of plan.lines) {
      run(ctx.db, 'INSERT INTO stalls_txn_line (txn_id, item_id, item_name, qty, free_qty, price, points) VALUES (?, ?, ?, ?, ?, ?, ?)', t.lastId, l.itemId, l.name, l.qty, l.freeQty, l.price, l.points);
    }
    // The basket for this stall is done; keep anything meant for other stalls.
    const mine = new Set(rows.map((r) => r.id));
    const rest = getCart(ctx, p.attendeeId).filter((c) => !mine.has(c.itemId));
    run(ctx.db, 'UPDATE stalls_cart SET lines = ?, updated_at = ? WHERE attendee_id = ?', JSON.stringify(rest), now, p.attendeeId);
    return { txnId: t.lastId, duplicate: false };
  });
  const res = storedResult(ctx, out.txnId, p.attendeeId, out.duplicate);
  if (!out.duplicate) {
    ctx.live.publish(
      'stalls.redeemed',
      { txnId: res.txnId, stallName: res.stallName, lines: res.lines, freeUsed: res.freeUsed, freeLeft: res.freeLeft, pointsSpent: res.pointsSpent, balance: res.balance },
      { attendeeId: p.attendeeId },
    );
  }
  return res;
}

/** Organiser only. Marks the purchase void; points, allowance, stock and limits come back by derivation. */
export function voidTxn(ctx: FeatureContext, txnId: number, reason: string | null): { attendeeId: number; stallName: string } {
  const r = tx(ctx.db, () => {
    const t = one<{ attendee_id: number; stall_id: number; status: string }>(ctx.db, 'SELECT attendee_id, stall_id, status FROM stalls_txn WHERE id = ?', txnId);
    if (!t) throw notFound('No such purchase.');
    if (t.status === 'void') throw conflict('That purchase is already voided.');
    run(ctx.db, "UPDATE stalls_txn SET status = 'void', voided_at = ?, void_reason = ? WHERE id = ?", ctx.now(), reason, txnId);
    return { attendeeId: t.attendee_id, stallId: t.stall_id };
  });
  const stallName = one<{ name: string }>(ctx.db, 'SELECT name FROM stalls_stall WHERE id = ?', r.stallId)?.name ?? '';
  ctx.live.publish(
    'stalls.voided',
    { txnId, stallName, freeLeft: allowanceOf(ctx, r.attendeeId).left, balance: balanceOf(ctx, r.attendeeId).balance },
    { attendeeId: r.attendeeId },
  );
  return { attendeeId: r.attendeeId, stallName };
}

export type { ItemRow };
