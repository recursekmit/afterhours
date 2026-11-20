import {
  type AvatarConfig,
  AvatarConfigSchema,
  DEFAULT_AVATAR,
  type LeaderboardEntry,
  type LedgerEntry,
} from '@afterhours/shared';
import { type Db, all, one, run } from '../db';
import type { LiveBus } from '../live/bus';

export interface AwardInput {
  attendeeId: number;
  /** Your feature name, optionally dotted: 'polls', 'arcade.reaction'. */
  source: string;
  /** Unique per attendee within the source: a poll id, a stop id, 'run:2026-11-21'. */
  ref: string;
  points: number;
  /** Shown in the attendee's points history. Club voice. */
  label?: string;
}

export interface AwardResult {
  /** false if this (attendee, source, ref) was already awarded; nothing changed. */
  awarded: boolean;
  total: number;
}

interface Ranked {
  attendeeId: number;
  nickname: string;
  avatar: AvatarConfig;
  total: number;
}

const SOURCE_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;

export class PointsService {
  private version = 0;
  private cache: { version: number; ranked: Ranked[]; index: Map<number, number> } | null = null;
  private changedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly db: Db,
    private readonly live: LiveBus,
    private readonly now: () => number = Date.now,
    /** Coalesce 'leaderboard.changed' broadcasts to at most one per this many ms. */
    private readonly leaderboardThrottleMs = 1500,
  ) {}

  /**
   * Idempotent award. The (attendeeId, source, ref) triple is unique in the
   * ledger, so retries, double taps and replays can never pay twice.
   * Publishes 'points.awarded' to the attendee and a throttled
   * 'leaderboard.changed' to everyone.
   */
  award(input: AwardInput): AwardResult {
    const { attendeeId, source, ref, points } = input;
    if (!SOURCE_RE.test(source)) throw new Error(`Bad award source "${source}"`);
    if (!Number.isInteger(points)) throw new Error('Points must be an integer');
    if (ref.length === 0 || ref.length > 120) throw new Error('Award ref must be 1..120 chars');
    const label = input.label ?? null;
    const r = run(
      this.db,
      'INSERT OR IGNORE INTO points_ledger (attendee_id, source, ref, points, label, at) VALUES (?, ?, ?, ?, ?, ?)',
      attendeeId,
      source,
      ref,
      points,
      label,
      this.now(),
    );
    const total = this.total(attendeeId);
    if (r.changes === 0) return { awarded: false, total };
    this.version++;
    this.live.publish('points.awarded', { source, ref, points, total, label }, { attendeeId });
    this.scheduleChanged();
    return { awarded: true, total };
  }

  /**
   * Take back awards (danger-zone resets). `revoke(source)` removes every row from that source and its
   * sub-sources ("morse" also takes "morse.sprint"); `revoke(source, ref)` removes one award.
   * Returns rows removed and tells the leaderboard.
   */
  revoke(source: string, ref?: string): number {
    if (!SOURCE_RE.test(source)) throw new Error(`Bad award source "${source}"`);
    const r =
      ref === undefined
        ? run(this.db, "DELETE FROM points_ledger WHERE source = ? OR source LIKE ? || '.%'", source, source)
        : run(this.db, 'DELETE FROM points_ledger WHERE source = ? AND ref = ?', source, ref);
    if (r.changes > 0) {
      this.version++;
      this.scheduleChanged();
    }
    return r.changes;
  }

  /** Every award one attendee ever got ("purge test player"). Returns rows removed and tells the leaderboard. */
  revokeAttendee(attendeeId: number): number {
    const r = run(this.db, 'DELETE FROM points_ledger WHERE attendee_id = ?', attendeeId);
    if (r.changes > 0) {
      this.version++;
      this.scheduleChanged();
    }
    return r.changes;
  }

  /** Alias kept for the danger zones: every award from a source and its sub-sources. */
  revokeSource(source: string): number {
    return this.revoke(source);
  }

  /** Has this exact award been made? */
  has(attendeeId: number, source: string, ref: string): boolean {
    return !!one(this.db, 'SELECT 1 AS x FROM points_ledger WHERE attendee_id = ? AND source = ? AND ref = ?', attendeeId, source, ref);
  }

  total(attendeeId: number): number {
    return one<{ t: number | null }>(this.db, 'SELECT SUM(points) AS t FROM points_ledger WHERE attendee_id = ?', attendeeId)?.t ?? 0;
  }

  /** Sum of points from sources starting with `prefix` since `sinceMs`. Handy for daily caps (spec 5.7). */
  totalFrom(attendeeId: number, sourcePrefix: string, sinceMs = 0): number {
    return (
      one<{ t: number | null }>(
        this.db,
        "SELECT SUM(points) AS t FROM points_ledger WHERE attendee_id = ? AND (source = ? OR source LIKE ? || '.%') AND at >= ?",
        attendeeId,
        sourcePrefix,
        sourcePrefix,
        sinceMs,
      )?.t ?? 0
    );
  }

  history(attendeeId: number, limit = 50): LedgerEntry[] {
    return all<LedgerEntry>(
      this.db,
      'SELECT source, ref, points, label, at FROM points_ledger WHERE attendee_id = ? ORDER BY at DESC, id DESC LIMIT ?',
      attendeeId,
      limit,
    );
  }

  private ranking() {
    if (this.cache && this.cache.version === this.version) return this.cache;
    // Only people with a finished profile (they have a nickname to show) and > 0 points.
    // Ties go to whoever got there first.
    const rows = all<{ id: number; nickname: string; avatar: string | null; total: number }>(
      this.db,
      `SELECT a.id, a.nickname, a.avatar, SUM(l.points) AS total, MAX(l.at) AS last
         FROM points_ledger l JOIN attendees a ON a.id = l.attendee_id
        WHERE a.profile_complete = 1
        GROUP BY a.id
       HAVING total > 0
        ORDER BY total DESC, last ASC, a.id ASC`,
    );
    const ranked: Ranked[] = rows.map((r) => ({
      attendeeId: r.id,
      nickname: r.nickname,
      avatar: parseAvatar(r.avatar),
      total: r.total,
    }));
    const index = new Map(ranked.map((r, i) => [r.attendeeId, i]));
    this.cache = { version: this.version, ranked, index };
    return this.cache;
  }

  /** Call when something outside award() changes ranking inputs (e.g. a profile was completed). */
  invalidate(): void {
    this.version++;
  }

  leaderboard(limit = 20, meId: number | null = null) {
    const { ranked, index } = this.ranking();
    const entries: LeaderboardEntry[] = ranked.slice(0, limit).map((r, i) => ({ rank: i + 1, ...r }));
    let me: { rank: number | null; total: number } | null = null;
    if (meId !== null) {
      const i = index.get(meId);
      me = { rank: i === undefined ? null : i + 1, total: i === undefined ? this.total(meId) : (ranked[i]?.total ?? 0) };
    }
    return { entries, me, players: ranked.length, updatedAt: this.now() };
  }

  rankOf(attendeeId: number): number | null {
    const i = this.ranking().index.get(attendeeId);
    return i === undefined ? null : i + 1;
  }

  private scheduleChanged() {
    if (this.changedTimer) return;
    this.changedTimer = setTimeout(() => {
      this.changedTimer = null;
      this.live.publish('leaderboard.changed', { at: this.now() }, 'all');
    }, this.leaderboardThrottleMs);
    this.changedTimer.unref?.();
  }

  close(): void {
    if (this.changedTimer) clearTimeout(this.changedTimer);
    this.changedTimer = null;
  }
}

export function parseAvatar(json: string | null): AvatarConfig {
  if (!json) return DEFAULT_AVATAR;
  try {
    const r = AvatarConfigSchema.safeParse(JSON.parse(json));
    return r.success ? r.data : DEFAULT_AVATAR;
  } catch {
    return DEFAULT_AVATAR;
  }
}
