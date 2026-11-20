import { type GeneratedKit, KIT_PREFIX, type KitListResponse, type KitRow } from '@afterhours/shared';
import type { AppContext } from '../context';
import { all, one, run, tx } from '../db';
import { notFound } from '../errors';
import { generatePassword, hashPassword } from './crypto';
import { revokeAttendeeSessions } from './sessions';

export interface KitSeedRow {
  name: string | null;
  roll: string | null;
}

/**
 * Parse a pasted `name,roll` list. Accepts commas or tabs (pasted straight
 * from a spreadsheet), optional header row, quoted fields, blank lines.
 */
export function parseKitCsv(csv: string): { rows: KitSeedRow[]; skipped: { line: number; reason: string }[] } {
  const rows: KitSeedRow[] = [];
  const skipped: { line: number; reason: string }[] = [];
  const lines = csv.replace(/\r\n?/g, '\n').split('\n');
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    const sep = line.includes('\t') && !line.includes(',') ? '\t' : ',';
    const [name = '', roll = ''] = splitCsvLine(line, sep).map((c) => c.trim());
    if (rows.length === 0 && skipped.length === 0 && /^name$/i.test(name) && /^roll/i.test(roll)) continue; // header
    const reason = !name
      ? 'no name'
      : name.length > 60
        ? 'name too long'
        : roll && !/^[A-Za-z0-9-]{1,20}$/.test(roll)
          ? `odd roll number "${roll}"`
          : null;
    if (reason) skipped.push({ line: i + 1, reason });
    else rows.push({ name, roll: roll ? roll.toUpperCase() : null });
  }
  return { rows, skipped };
}

export function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function nextKitNumber(ctx: AppContext): number {
  const r = one<{ n: number | null }>(ctx.db, "SELECT MAX(CAST(substr(id, 4) AS INTEGER)) AS n FROM kits WHERE id LIKE 'AH-%'");
  return (r?.n ?? 0) + 1;
}

const kitIdFor = (n: number) => `${KIT_PREFIX}-${String(n).padStart(3, '0')}`;

/**
 * Create kits. Returns plain passwords exactly once; only hashes are stored.
 * Pass `passwords` to force known passwords (seed/tests only).
 */
export async function generateKits(ctx: AppContext, seeds: KitSeedRow[], passwords?: string[]): Promise<GeneratedKit[]> {
  const plain = seeds.map((_, i) => passwords?.[i] ?? generatePassword());
  const hashes = await Promise.all(plain.map((p) => hashPassword(p)));
  const now = ctx.now();
  return tx(ctx.db, () => {
    let n = nextKitNumber(ctx);
    return seeds.map((s, i) => {
      const kitId = kitIdFor(n++);
      run(
        ctx.db,
        'INSERT INTO kits (id, password_hash, preset_name, preset_roll, created_at) VALUES (?, ?, ?, ?, ?)',
        kitId,
        hashes[i] ?? '',
        s.name,
        s.roll,
        now,
      );
      return { kitId, password: plain[i] ?? '', name: s.name, roll: s.roll };
    });
  });
}

export function listKits(ctx: AppContext): KitListResponse {
  const rows = all<{
    id: string;
    preset_name: string | null;
    preset_roll: string | null;
    created_at: number;
    device_hash: string | null;
    bound_at: number | null;
    resets: number;
    attendee_id: number | null;
    name: string | null;
    roll: string | null;
    nickname: string | null;
    first_signin_at: number | null;
    profile_complete: number | null;
  }>(
    ctx.db,
    `SELECT k.id, k.preset_name, k.preset_roll, k.created_at, k.device_hash, k.bound_at, k.resets,
            a.id AS attendee_id, a.name, a.roll, a.nickname, a.first_signin_at, a.profile_complete
       FROM kits k LEFT JOIN attendees a ON a.kit_id = k.id
      WHERE k.kind = 'card'
      ORDER BY k.id`,
  );
  const kits: KitRow[] = rows.map((r) => ({
    kitId: r.id,
    presetName: r.preset_name,
    presetRoll: r.preset_roll,
    createdAt: r.created_at,
    bound: r.device_hash !== null,
    boundAt: r.bound_at,
    resets: r.resets,
    attendee:
      r.attendee_id === null
        ? null
        : {
            id: r.attendee_id,
            name: r.name,
            roll: r.roll,
            nickname: r.nickname,
            firstSignInAt: r.first_signin_at ?? 0,
            profileComplete: r.profile_complete === 1,
          },
  }));
  return {
    kits,
    stats: {
      total: kits.length,
      signedIn: kits.filter((k) => k.attendee).length,
      profiles: kits.filter((k) => k.attendee?.profileComplete).length,
    },
  };
}

/**
 * Organiser reset: unbind the phone (so the kit can sign in on another
 * device) and sign out every session of that kit. Optionally issue a new
 * password (lost card). The attendee keeps their points and stickers.
 */
export async function resetKit(ctx: AppContext, kitId: string, newPassword: boolean): Promise<{ kitId: string; password: string | null }> {
  const kit = one<{ id: string }>(ctx.db, "SELECT id FROM kits WHERE id = ? AND kind = 'card'", kitId);
  if (!kit) throw notFound(`No kit called ${kitId}.`);
  const password = newPassword ? generatePassword() : null;
  const hash = password ? await hashPassword(password) : null;
  tx(ctx.db, () => {
    if (hash) run(ctx.db, 'UPDATE kits SET password_hash = ? WHERE id = ?', hash, kitId);
    unbindKit(ctx, kitId, 'kit-reset');
  });
  return { kitId, password };
}

/**
 * Unbind a kit (a printed card, or a participant's roster kit) from its phone
 * and sign out every session of its attendee. Points, stickers and stall
 * history stay with the attendee.
 */
export function unbindKit(ctx: AppContext, kitId: string, reason: 'kit-reset' | 'id-reset'): void {
  const attendee = one<{ id: number }>(ctx.db, 'SELECT id FROM attendees WHERE kit_id = ?', kitId);
  tx(ctx.db, () => {
    run(ctx.db, 'UPDATE kits SET device_hash = NULL, bound_at = NULL, resets = resets + 1 WHERE id = ?', kitId);
    if (attendee) revokeAttendeeSessions(ctx, attendee.id);
  });
  if (attendee) ctx.live.publish('session.revoked', { reason }, { attendeeId: attendee.id });
}
