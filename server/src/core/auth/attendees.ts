import type { Attendee, MeResponse, ProfileInput, PublicAttendee } from '@afterhours/shared';
import type { AppContext } from '../context';
import { all, one, run } from '../db';
import { notFound } from '../errors';
import { parseAvatar } from '../points/ledger';

interface AttendeeRow {
  id: number;
  kit_id: string;
  name: string | null;
  roll: string | null;
  nickname: string | null;
  avatar: string | null;
  profile_complete: number;
  first_signin_at: number;
}

const COLS = 'id, kit_id, name, roll, nickname, avatar, profile_complete, first_signin_at';

function toAttendee(r: AttendeeRow): Attendee {
  return {
    id: r.id,
    kitId: r.kit_id,
    name: r.name,
    roll: r.roll,
    nickname: r.nickname,
    avatar: r.avatar ? parseAvatar(r.avatar) : null,
    profileComplete: r.profile_complete === 1,
    firstSignInAt: r.first_signin_at,
  };
}

export function getAttendeeById(ctx: AppContext, id: number): Attendee | null {
  const r = one<AttendeeRow>(ctx.db, `SELECT ${COLS} FROM attendees WHERE id = ?`, id);
  return r ? toAttendee(r) : null;
}

/** Nickname + avatar for showing someone to others. Null until their profile is done. */
export function getPublicAttendee(ctx: AppContext, id: number): PublicAttendee | null {
  const r = one<AttendeeRow>(ctx.db, `SELECT ${COLS} FROM attendees WHERE id = ? AND profile_complete = 1`, id);
  return r?.nickname ? { id: r.id, nickname: r.nickname, avatar: parseAvatar(r.avatar) } : null;
}

export function getMe(ctx: AppContext, attendeeId: number): MeResponse {
  const attendee = getAttendeeById(ctx, attendeeId);
  if (!attendee) throw notFound('No such attendee.');
  const kit = one<{ preset_name: string | null; preset_roll: string | null }>(
    ctx.db,
    'SELECT preset_name, preset_roll FROM kits WHERE id = ?',
    attendee.kitId,
  );
  return { attendee, preset: { name: kit?.preset_name ?? null, roll: kit?.preset_roll ?? null } };
}

/** Save the first-sign-in profile (or later edits). Returns whether this was the first completion. */
export function saveProfile(ctx: AppContext, attendeeId: number, p: ProfileInput): { first: boolean } {
  const before = one<{ profile_complete: number; preset_name: string | null; preset_roll: string | null }>(
    ctx.db,
    'SELECT a.profile_complete, k.preset_name, k.preset_roll FROM attendees a LEFT JOIN kits k ON k.id = a.kit_id WHERE a.id = ?',
    attendeeId,
  );
  if (!before) throw notFound('No such attendee.');
  // Their own names, no usernames: someone on the participant list is shown by their registered name and
  // roll, whatever the phone sends. Only people without one (printed kits) use what they typed.
  const listed = before.preset_name?.trim() || null;
  const name = listed ?? p.name;
  const roll = before.preset_roll?.trim() || p.roll;
  const shown = listed ?? p.nickname ?? p.name;
  run(
    ctx.db,
    `UPDATE attendees SET name = ?, roll = ?, nickname = ?, avatar = ?, profile_complete = 1,
            profile_at = COALESCE(profile_at, ?) WHERE id = ?`,
    name,
    roll,
    shown,
    JSON.stringify(p.avatar),
    ctx.now(),
    attendeeId,
  );
  ctx.points.invalidate();
  return { first: before.profile_complete === 0 };
}

export function attendanceCount(ctx: AppContext): number {
  return one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM attendees')?.n ?? 0;
}

export function allAttendeeIds(ctx: AppContext): number[] {
  return all<{ id: number }>(ctx.db, 'SELECT id FROM attendees').map((r) => r.id);
}
