// Personal streaks: "3 in a row" = you did something (anything that earned points) during each of the
// last 3 activities on the schedule. Breaks don't count, and the activity on right now doesn't break a
// streak until it is over.
import { type MyStreak, STREAK_STICKER_AT } from '@afterhours/shared/features/drops';
import type { Activity } from '@afterhours/shared/features/schedule';
import { type FeatureContext, all } from '../../core';
import { buildState } from '../schedule/service';
import { names, nick, push as feed } from './feed';
import { SOURCE } from './service';

export const STREAK_SOURCE = `${SOURCE}.streak`;
export const STREAK_POINTS = 5;

interface Window {
  title: string;
  from: number;
  to: number;
  live: boolean;
}

function windows(activities: Activity[], now: number): Window[] {
  return activities
    .filter((a) => a.kind !== 'break' && a.status !== 'upcoming')
    .map((a) => {
      const from = a.actualStartAt ?? a.startAt;
      const to = a.status === 'live' ? now : (a.actualEndAt ?? a.endAt);
      return { title: a.title, from, to, live: a.status === 'live' };
    })
    .filter((w) => w.to > w.from)
    .sort((a, b) => a.from - b.from);
}

/** Pure: streak, best run and the recent activities from activity windows and the times you scored. */
export function streakFrom(ws: Window[], times: number[]): MyStreak {
  const sorted = [...times].sort((a, b) => a - b);
  const did = ws.map((w) => {
    // binary search for the first time >= from
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((sorted[mid] ?? 0) < w.from) lo = mid + 1;
      else hi = mid;
    }
    const t = sorted[lo];
    return t !== undefined && t <= w.to;
  });
  let best = 0;
  let run = 0;
  for (const d of did) {
    run = d ? run + 1 : 0;
    best = Math.max(best, run);
  }
  let i = ws.length - 1;
  if (i >= 0 && ws[i]?.live && !did[i]) i--; // still time to do something in the one on now
  let streak = 0;
  for (; i >= 0 && did[i]; i--) streak++;
  const recent = ws.slice(-5).map((w, k) => ({ title: w.title, did: did[ws.length - Math.min(5, ws.length) + k] ?? false, live: w.live }));
  return { streak, best, recent };
}

export function streakOf(ctx: FeatureContext, attendeeId: number): MyStreak {
  const now = ctx.now();
  const ws = windows(buildState(ctx).activities, now);
  if (ws.length === 0) return { streak: 0, best: 0, recent: [] };
  const times = all<{ at: number }>(
    ctx.db,
    "SELECT at FROM points_ledger WHERE attendee_id = ? AND source <> ? AND at >= ?",
    attendeeId,
    STREAK_SOURCE,
    ws[0]?.from ?? 0,
  ).map((r) => r.at);
  const s = streakFrom(ws, times);
  if (s.streak >= STREAK_STICKER_AT) {
    const a = ctx.points.award({ attendeeId, source: STREAK_SOURCE, ref: `streak-${STREAK_STICKER_AT}`, points: STREAK_POINTS, label: `${STREAK_STICKER_AT} in a row` });
    ctx.stickers.unlock(attendeeId, 'drops-streak');
    if (a.awarded) {
      const who = all<{ nickname: string | null }>(ctx.db, 'SELECT nickname FROM attendees WHERE id = ?', attendeeId)[0]?.nickname;
      if (who) feed(ctx, { key: 'streak', priority: 1, tone: 'hype', icon: 'flame', name: nick(who), text: (n, c) => (c > 1 ? `${names(n, c)} are on a roll` : `${n[0] ?? 'someone'} is ${STREAK_STICKER_AT} in a row`) });
    }
  }
  return s;
}
