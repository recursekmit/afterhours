// "purge test player": remove a participant (a mock tester) and every trace of what they did, as if they
// never came. Console only, per participant, behind a typed confirmation (their roll number).
//
// One transaction:
//   - their points go through PointsService.revokeAttendee, so the leaderboard cache and broadcast follow;
//   - unique slip copies they claimed are released (any `claimed_by` column is set back to NULL);
//   - every row in every table with an `attendee_id` column is deleted. The list is read from the schema,
//     so it covers every feature (hunt, morse, cipher, polls, drops, attendance, stalls, recap, reactions,
//     push, sessions, stickers) and the arcade's tables WITHOUT touching arcade code. Stall hand-overs are
//     deleted outright, so stock, per-person limits and free drinks come back by derivation;
//   - the attendee row, the participant row and their roster kit (and any per-kit slip words) go last.
// Then each feature's onPurge hook drops in-memory caches (crowd counts, tallies, boards), and the
// leaderboard is told to refresh.
import type { PurgeReport } from '@afterhours/shared';
import { HttpError, notFound } from '../errors';
import type { AppContext } from '../context';
import { all, one, run, tx } from '../db';

type Hook = (ctx: AppContext, attendeeId: number) => void;
const hooks = new WeakMap<AppContext, Hook[]>();

/** app.ts registers each feature's onPurge hook here. */
export function setPurgeHooks(ctx: AppContext, list: Hook[]): void {
  hooks.set(ctx, list);
}


/** Tables (and the column) that point at an attendee, from the live schema. */
function attendeeTables(ctx: AppContext): { table: string; column: string }[] {
  const tables = all<{ name: string }>(ctx.db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations'");
  const out: { table: string; column: string }[] = [];
  for (const { name } of tables) {
    if (!/^[a-z0-9_]+$/.test(name)) continue;
    for (const c of all<{ name: string }>(ctx.db, `PRAGMA table_info(${name})`)) {
      if (c.name === 'attendee_id' || c.name === 'claimed_by') out.push({ table: name, column: c.name });
    }
    // Other columns that point at attendees by a foreign key (cipher_pacts.a_id / b_id): their rows go too,
    // or the attendee row could not be deleted.
    for (const fk of all<{ table: string; from: string }>(ctx.db, `PRAGMA foreign_key_list(${name})`)) {
      if (fk.table === 'attendees' && fk.from !== 'attendee_id' && fk.from !== 'claimed_by' && /^[a-z0-9_]+$/.test(fk.from)) out.push({ table: name, column: fk.from });
    }
  }
  return out;
}

export function purgeParticipant(ctx: AppContext, participantId: number, confirm: string): PurgeReport {
  const p = one<{ id: number; roll: string; kit_id: string }>(ctx.db, 'SELECT id, roll, kit_id FROM participants WHERE id = ?', participantId);
  if (!p) throw notFound('No such participant.');
  if (confirm.trim().toUpperCase() !== p.roll.toUpperCase()) throw new HttpError(400, 'bad_request', `Type their roll number (${p.roll}) to confirm.`);
  const a = one<{ id: number; nickname: string | null }>(ctx.db, 'SELECT id, nickname FROM attendees WHERE kit_id = ?', p.kit_id);
  const rows: Record<string, number> = {};
  tx(ctx.db, () => {
    if (a) {
      rows.points_ledger = ctx.points.revokeAttendee(a.id);
      const targets = attendeeTables(ctx).filter((t) => t.table !== 'points_ledger');
      for (const t of targets.filter((x) => x.column === 'claimed_by')) {
        const hasAt = all<{ name: string }>(ctx.db, `PRAGMA table_info(${t.table})`).some((c) => c.name === 'claimed_at');
        const n = run(ctx.db, `UPDATE ${t.table} SET claimed_by = NULL${hasAt ? ', claimed_at = NULL' : ''} WHERE claimed_by = ?`, a.id).changes;
        if (n) rows[`${t.table} (released)`] = n;
      }
      // Child tables before parents: retry the ones a foreign key holds back until a pass removes nothing.
      let pending = targets.filter((x) => x.column !== 'claimed_by');
      for (let pass = 0; pass < 6 && pending.length > 0; pass++) {
        const left: typeof pending = [];
        for (const t of pending) {
          try {
            const n = run(ctx.db, `DELETE FROM ${t.table} WHERE ${t.column} = ?`, a.id).changes;
            if (n) rows[t.table] = (rows[t.table] ?? 0) + n;
          } catch {
            left.push(t);
          }
        }
        pending = left;
      }
      if (pending.length) throw new Error(`Could not purge ${pending.map((t) => t.table).join(', ')}`);
      run(ctx.db, 'DELETE FROM attendees WHERE id = ?', a.id);
      rows.attendees = 1;
    }
    run(ctx.db, 'DELETE FROM participants WHERE id = ?', p.id);
    if (one(ctx.db, "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'hunt_kit_slip_words'")) run(ctx.db, 'DELETE FROM hunt_kit_slip_words WHERE kit_id = ?', p.kit_id);
    run(ctx.db, 'DELETE FROM kits WHERE id = ?', p.kit_id);
  });
  if (a) for (const h of hooks.get(ctx) ?? []) h(ctx, a.id);
  ctx.live.publish('leaderboard.changed', { at: ctx.now() }, 'all');
  return { participantId: p.id, roll: p.roll, attendeeId: a?.id ?? null, nickname: a?.nickname ?? null, rows };
}
