// Console-side logic: stalls, items, codes, CSV import, overview, transactions and export.
import { randomInt } from 'node:crypto';
import {
  type AdminItem,
  type AdminOverview,
  type AdminStall,
  type AdminTxn,
  type ImportResult,
  STALL_CODE_LEN,
  MAX_QTY,
} from '@afterhours/shared/features/stalls';
import { type FeatureContext, all, badRequest, notFound, one, run, tx } from '../../core';
import { csvRow, parseCsv } from './csv';
import { deleteImage } from './images';
import { getSettings, imageUrl } from './service';

export function newStallCode(ctx: FeatureContext): string {
  for (let i = 0; i < 200; i++) {
    const code = String(randomInt(0, 10 ** STALL_CODE_LEN)).padStart(STALL_CODE_LEN, '0');
    if (!one(ctx.db, 'SELECT 1 AS x FROM stalls_stall WHERE code = ?', code)) return code;
  }
  throw new Error('Could not find a free stall code');
}

export function createStall(ctx: FeatureContext, p: { name: string; emoji?: string; location?: string }): number {
  const sort = (one<{ m: number | null }>(ctx.db, 'SELECT MAX(sort) AS m FROM stalls_stall')?.m ?? 0) + 1;
  return run(
    ctx.db,
    'INSERT INTO stalls_stall (name, emoji, location, code, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    p.name,
    p.emoji ?? '\u{1F379}',
    p.location ?? '',
    newStallCode(ctx),
    sort,
    ctx.now(),
  ).lastId;
}

/** New code; shopkeepers signed in with the old one are signed out. */
export function rotateCode(ctx: FeatureContext, stallId: number): string {
  const code = newStallCode(ctx);
  tx(ctx.db, () => {
    if (run(ctx.db, 'UPDATE stalls_stall SET code = ? WHERE id = ?', code, stallId).changes === 0) throw notFound('No such stall.');
    run(ctx.db, 'DELETE FROM stalls_session WHERE stall_id = ?', stallId);
  });
  return code;
}

export function createItem(
  ctx: FeatureContext,
  p: { stallId: number; name: string; price: number; stock?: number | null; limit?: number | null; freeDrink?: boolean },
): number {
  if (!one(ctx.db, 'SELECT 1 AS x FROM stalls_stall WHERE id = ?', p.stallId)) throw notFound('No such stall.');
  const sort = (one<{ m: number | null }>(ctx.db, 'SELECT MAX(sort) AS m FROM stalls_item WHERE stall_id = ?', p.stallId)?.m ?? 0) + 1;
  return run(
    ctx.db,
    'INSERT INTO stalls_item (stall_id, name, price, stock, per_person, free_drink, sort) VALUES (?, ?, ?, ?, ?, ?, ?)',
    p.stallId,
    p.name,
    p.price,
    p.stock ?? null,
    p.limit ?? null,
    p.freeDrink ? 1 : 0,
    sort,
  ).lastId;
}

/** Items with sales are archived (history keeps their names); untouched ones are removed. */
export function removeItem(ctx: FeatureContext, itemId: number): 'deleted' | 'archived' {
  const item = one<{ image: string | null }>(ctx.db, 'SELECT image FROM stalls_item WHERE id = ?', itemId);
  if (!item) throw notFound('No such item.');
  const used = one(ctx.db, 'SELECT 1 AS x FROM stalls_txn_line WHERE item_id = ? LIMIT 1', itemId);
  if (used) {
    run(ctx.db, 'UPDATE stalls_item SET active = 0 WHERE id = ?', itemId);
    return 'archived';
  }
  run(ctx.db, 'DELETE FROM stalls_item WHERE id = ?', itemId);
  deleteImage(ctx, item.image);
  return 'deleted';
}

/** A stall with sales is closed instead of deleted. */
export function removeStall(ctx: FeatureContext, stallId: number): 'deleted' | 'closed' {
  if (!one(ctx.db, 'SELECT 1 AS x FROM stalls_stall WHERE id = ?', stallId)) throw notFound('No such stall.');
  if (one(ctx.db, 'SELECT 1 AS x FROM stalls_txn WHERE stall_id = ? LIMIT 1', stallId)) {
    run(ctx.db, 'UPDATE stalls_stall SET active = 0 WHERE id = ?', stallId);
    run(ctx.db, 'DELETE FROM stalls_session WHERE stall_id = ?', stallId);
    return 'closed';
  }
  const imgs = all<{ image: string | null }>(ctx.db, 'SELECT image FROM stalls_item WHERE stall_id = ?', stallId);
  run(ctx.db, 'DELETE FROM stalls_stall WHERE id = ?', stallId);
  for (const i of imgs) deleteImage(ctx, i.image);
  return 'deleted';
}

/* ---------------------------------------------------------------- CSV import */

const truthy = (s: string | undefined) => /^(1|y|yes|true|free)$/i.test((s ?? '').trim());

/**
 * Columns: stall,item,price,stock,limit  (optional 6th: free = yes for a free-mocktail item).
 * A header row is skipped. Stalls and items are matched by name, case-insensitive: a second import
 * updates what exists instead of duplicating it. Bad rows are skipped and reported by line number.
 */
export function importCsv(ctx: FeatureContext, text: string): ImportResult {
  const rows = parseCsv(text);
  const res: ImportResult = { stallsCreated: 0, itemsCreated: 0, itemsUpdated: 0, errors: [] };
  if (rows.length === 0) throw badRequest('Nothing to import. Paste rows like: stall,item,price,stock,limit');
  tx(ctx.db, () => {
    rows.forEach((row, idx) => {
      const [stallName = '', itemName = '', priceRaw = '', stockRaw = '', limitRaw = '', freeRaw] = row.cells;
      if (idx === 0 && /^stall/i.test(stallName) && /^item/i.test(itemName)) return;
      const err = (message: string) => res.errors.push({ line: row.line, message });
      if (!stallName || !itemName) return err('Needs a stall and an item name.');
      if (stallName.length > 40 || itemName.length > 60) return err('Name is too long.');
      const price = priceRaw === '' ? 0 : /^\d{1,6}$/.test(priceRaw) ? Number(priceRaw) : NaN;
      if (Number.isNaN(price)) return err(`Price "${priceRaw}" is not a whole number of points.`);
      const stock = stockRaw === '' ? null : /^\d{1,6}$/.test(stockRaw) ? Number(stockRaw) : NaN;
      if (stock !== null && Number.isNaN(stock)) return err(`Stock "${stockRaw}" is not a whole number (leave it blank for unlimited).`);
      const limit = limitRaw === '' ? null : /^\d{1,3}$/.test(limitRaw) ? Number(limitRaw) : NaN;
      if (limit !== null && (Number.isNaN(limit) || limit < 1 || limit > MAX_QTY * 5)) return err(`Limit "${limitRaw}" must be 1 or more (blank for none).`);

      let stall = one<{ id: number }>(ctx.db, 'SELECT id FROM stalls_stall WHERE LOWER(name) = LOWER(?)', stallName);
      if (!stall) {
        stall = { id: createStall(ctx, { name: stallName }) };
        res.stallsCreated++;
      }
      const free = truthy(freeRaw);
      const existing = one<{ id: number }>(ctx.db, 'SELECT id FROM stalls_item WHERE stall_id = ? AND LOWER(name) = LOWER(?)', stall.id, itemName);
      if (existing) {
        run(
          ctx.db,
          'UPDATE stalls_item SET price = ?, stock = ?, per_person = ?, free_drink = ?, active = 1 WHERE id = ?',
          price,
          stock,
          limit,
          freeRaw === undefined ? (one<{ f: number }>(ctx.db, 'SELECT free_drink AS f FROM stalls_item WHERE id = ?', existing.id)?.f ?? 0) : free ? 1 : 0,
          existing.id,
        );
        res.itemsUpdated++;
      } else {
        createItem(ctx, { stallId: stall.id, name: itemName, price, stock, limit, freeDrink: free });
        res.itemsCreated++;
      }
    });
  });
  return res;
}

/* ---------------------------------------------------------------- overview + transactions */

export function overview(ctx: FeatureContext): AdminOverview {
  const stalls = all<{ id: number; name: string; emoji: string; location: string; code: string; active: number }>(
    ctx.db,
    'SELECT id, name, emoji, location, code, active FROM stalls_stall ORDER BY sort, id',
  );
  const items = all<{
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
  }>(
    ctx.db,
    `SELECT i.id, i.stall_id, i.name, i.price, i.image, i.stock, i.per_person, i.free_drink, i.active,
            COALESCE((SELECT SUM(l.qty) FROM stalls_txn_line l JOIN stalls_txn t ON t.id = l.txn_id WHERE l.item_id = i.id AND t.status = 'ok'), 0) AS sold
       FROM stalls_item i ORDER BY i.sort, i.id`,
  );
  const sales = all<{ stall_id: number; txns: number; units: number; free: number; points: number }>(
    ctx.db,
    `SELECT t.stall_id, COUNT(*) AS txns, SUM(t.total_points) AS points,
            COALESCE(SUM((SELECT SUM(qty) FROM stalls_txn_line WHERE txn_id = t.id)), 0) AS units,
            COALESCE(SUM((SELECT SUM(free_qty) FROM stalls_txn_line WHERE txn_id = t.id)), 0) AS free
       FROM stalls_txn t WHERE t.status = 'ok' GROUP BY t.stall_id`,
  );
  const saleBy = new Map(sales.map((s) => [s.stall_id, s]));
  const out: AdminStall[] = stalls.map((s) => {
    const sl = saleBy.get(s.id);
    const its: AdminItem[] = items
      .filter((i) => i.stall_id === s.id)
      .map((i) => ({
        id: i.id,
        stallId: i.stall_id,
        name: i.name,
        price: i.price,
        image: imageUrl(i.image),
        stock: i.stock,
        stockLeft: i.stock === null ? null : Math.max(0, i.stock - i.sold),
        limit: i.per_person,
        freeDrink: i.free_drink === 1,
        sold: i.sold,
        active: i.active === 1,
      }));
    return {
      id: s.id,
      name: s.name,
      emoji: s.emoji,
      location: s.location,
      code: s.code,
      active: s.active === 1,
      sales: { txns: sl?.txns ?? 0, units: sl?.units ?? 0, freeUnits: sl?.free ?? 0, points: sl?.points ?? 0 },
      items: its,
    };
  });
  return {
    settings: getSettings(ctx),
    stalls: out,
    totals: {
      txns: sales.reduce((a, b) => a + b.txns, 0),
      points: sales.reduce((a, b) => a + (b.points ?? 0), 0),
      freeUnits: sales.reduce((a, b) => a + b.free, 0),
    },
  };
}

export function listTxns(ctx: FeatureContext, opts: { stallId?: number; limit?: number } = {}): AdminTxn[] {
  const rows = all<{
    id: number;
    at: number;
    stall_id: number;
    stall_name: string;
    kit_id: string;
    nickname: string | null;
    total_points: number;
    free_used: number;
    status: 'ok' | 'void';
    void_reason: string | null;
  }>(
    ctx.db,
    `SELECT t.id, t.at, t.stall_id, s.name AS stall_name, a.kit_id, a.nickname, t.total_points, t.free_used, t.status, t.void_reason
       FROM stalls_txn t JOIN stalls_stall s ON s.id = t.stall_id JOIN attendees a ON a.id = t.attendee_id
      ${opts.stallId ? 'WHERE t.stall_id = ?' : ''} ORDER BY t.id DESC LIMIT ?`,
    ...(opts.stallId ? [opts.stallId] : []),
    opts.limit ?? 200,
  );
  const lines = all<{ txn_id: number; item_name: string; qty: number; free_qty: number; points: number }>(
    ctx.db,
    `SELECT txn_id, item_name, qty, free_qty, points FROM stalls_txn_line WHERE txn_id IN (${rows.length ? rows.map(() => '?').join(',') : 'NULL'}) ORDER BY id`,
    ...rows.map((r) => r.id),
  );
  const byTxn = new Map<number, AdminTxn['lines']>();
  for (const l of lines) {
    const a = byTxn.get(l.txn_id) ?? [];
    a.push({ name: l.item_name, qty: l.qty, freeQty: l.free_qty, points: l.points });
    byTxn.set(l.txn_id, a);
  }
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    stallId: r.stall_id,
    stallName: r.stall_name,
    kitId: r.kit_id,
    nickname: r.nickname ?? '',
    lines: byTxn.get(r.id) ?? [],
    totalPoints: r.total_points,
    freeUsed: r.free_used,
    status: r.status,
    voidReason: r.void_reason,
  }));
}

export function exportCsv(ctx: FeatureContext): string {
  const out = [csvRow(['txn', 'time', 'stall', 'kit', 'nickname', 'items', 'free_drinks', 'points', 'status', 'void_reason'])];
  for (const t of listTxns(ctx, { limit: 100_000 }).reverse()) {
    const items = t.lines.map((l) => `${l.qty} x ${l.name}${l.freeQty ? ` (${l.freeQty} free)` : ''}`).join('; ');
    out.push(csvRow([t.id, new Date(t.at).toISOString(), t.stallName, t.kitId, t.nickname, items, t.freeUsed, t.totalPoints, t.status, t.voidReason]));
  }
  return out.join('\r\n') + '\r\n';
}
