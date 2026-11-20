// Pure rules of the hunt: order, cooldowns, rewards. No database, no clock.
import { createHash } from 'node:crypto';
import { HUNT_HINT_COSTS } from '@afterhours/shared/features/hunt';

/**
 * The stops in the order THIS attendee walks them.
 * `stopIds` is the authoring order; the last one is the finale and stays last
 * for everyone. The rest are sorted by sha256(seed:attendee:stop), which is a
 * stable, uniformly random permutation per attendee that nobody can predict
 * without the server's seed, and that does not change when the same stops are
 * edited. Two friends get different routes, so the crowd spreads out.
 */
export function stopOrder(seed: string, attendeeId: number, stopIds: readonly number[]): number[] {
  if (stopIds.length <= 1) return [...stopIds];
  const finale = stopIds[stopIds.length - 1] as number;
  const rest = stopIds.slice(0, -1).map((id) => ({
    id,
    key: createHash('sha256').update(`${seed}:${attendeeId}:${id}`).digest('hex'),
  }));
  rest.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id - b.id));
  return [...rest.map((r) => r.id), finale];
}

/**
 * "Each player gets K of the M stops": the K stops before the finale THIS attendee walks, plus the
 * finale everyone shares, in authoring order. The pick uses the same per-attendee hash as stopOrder,
 * so it is stable, unpredictable without the seed, and spreads players over every stop. k <= 0, or a
 * k that covers every stop, means everyone gets all of them.
 */
export function stopSubset(seed: string, attendeeId: number, stopIds: readonly number[], k: number): number[] {
  if (k <= 0 || stopIds.length - 1 <= k) return [...stopIds];
  const chosen = new Set(stopOrder(seed, attendeeId, stopIds).slice(0, k));
  return stopIds.filter((id, i) => chosen.has(id) || i === stopIds.length - 1);
}

/** Lock after the Nth wrong typed answer on a stop (1-based): 3 s, 8 s, 20 s, 45 s, 90 s, then 2 min each time. */
export const COOLDOWNS_MS = [3_000, 8_000, 20_000, 45_000, 90_000, 120_000] as const;
export function cooldownFor(wrongCount: number): number {
  if (wrongCount < 1) return 0;
  return COOLDOWNS_MS[Math.min(wrongCount, COOLDOWNS_MS.length) - 1] as number;
}

/** What a stop pays after `hintsUsed` hints were revealed. Never below 1. */
export function stopWorth(base: number, hintsUsed: number): number {
  let cost = 0;
  for (let i = 0; i < hintsUsed; i++) cost += HUNT_HINT_COSTS[i] ?? 0;
  return Math.max(1, base - cost);
}

export function hintCost(n: number): number {
  return HUNT_HINT_COSTS[n - 1] ?? 0;
}

/** Bonus for finishing Nth: ranks 1..10 pay a podium ladder, 11..25 pay 8, everyone after 5. */
const RANK_LADDER = [50, 35, 25, 20, 15, 15, 12, 12, 10, 10] as const;
export function rankBonus(rank: number): number {
  if (rank < 1) return 0;
  if (rank <= RANK_LADDER.length) return RANK_LADDER[rank - 1] as number;
  return rank <= 25 ? 8 : 5;
}

/** Bonus for how fast the whole hunt took (start press to last stamp). */
export function speedBonus(elapsedMs: number): number {
  const min = elapsedMs / 60_000;
  if (min <= 15) return 20;
  if (min <= 25) return 12;
  if (min <= 40) return 6;
  return 0;
}

/** Token/code lookups: a code is typed by humans, so case and the dash do not matter. */
export function normaliseCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
