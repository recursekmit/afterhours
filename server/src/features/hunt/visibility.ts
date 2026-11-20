// Player visibility: two console switches, one per event, both off by default (hunt migration 005).
//   "show treasure hunt to players": trails of kind 'hunt' and 'other'
//   "show morse challenge to players": trails of kind 'morse' (the morse slip)
// While an event is hidden:
//   - its attendee and projector APIs answer 403 not_open (the console and admins are not affected);
//   - its live events reach admins only, and the drops feed ignores them;
//   - the web shows no trace of it (nav, home, projector scene, pages say "not open yet").
// Flipping a switch publishes 'hunt.visibility' to everyone, so phones update without a reload.
// The online Morse ladder (decode/encode levels) keeps its own switch in the morse feature.
import type { Audience } from '@afterhours/shared';
import type { HuntVisibility, TrailKind } from '@afterhours/shared/features/hunt';
import { type FeatureContext, HttpError, one, run } from '../../core';

export type TrailGroup = keyof HuntVisibility;

/** Which event a trail belongs to. */
export const groupOf = (kind: TrailKind): TrailGroup => (kind === 'morse' ? 'morse' : 'hunt');

export function visibility(ctx: FeatureContext): HuntVisibility {
  const r = one<{ hunt_visible: number; morse_visible: number }>(ctx.db, 'SELECT hunt_visible, morse_visible FROM hunt_settings WHERE id = 1');
  return { hunt: r?.hunt_visible === 1, morse: r?.morse_visible === 1 };
}

export function setVisibility(ctx: FeatureContext, patch: Partial<HuntVisibility>): HuntVisibility {
  const before = visibility(ctx);
  const next = { ...before, ...patch };
  run(ctx.db, 'UPDATE hunt_settings SET hunt_visible = ?, morse_visible = ?, changed_at = ? WHERE id = 1', next.hunt ? 1 : 0, next.morse ? 1 : 0, ctx.now());
  if (next.hunt !== before.hunt || next.morse !== before.morse) ctx.live.publish('hunt.visibility', next, 'all');
  return next;
}

export function kindVisible(ctx: FeatureContext, kind: TrailKind): boolean {
  return visibility(ctx)[groupOf(kind)];
}

/** Whether players may see this trail at all (an unknown trail counts as the treasure hunt). */
export function trailVisible(ctx: FeatureContext, trailId: number): boolean {
  const kind = one<{ kind: TrailKind }>(ctx.db, 'SELECT kind FROM hunt_trails WHERE id = ?', trailId)?.kind ?? 'hunt';
  return kindVisible(ctx, kind);
}

/** Who a live event about this trail may reach right now: while its event is hidden, only the console. */
export function trailAudience(ctx: FeatureContext, trailId: number, audience: Audience): Audience {
  return trailVisible(ctx, trailId) ? audience : 'admins';
}

export const NOT_OPEN_MESSAGE = 'Not open yet. Hang tight, the organisers will open it later this afternoon.';
export const notOpen = (): HttpError => new HttpError(403, 'not_open', NOT_OPEN_MESSAGE);
