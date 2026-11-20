// Organiser switches for drops: feed mute and the hype meter. One JSON row, cached in memory.
import { type DropSettings, DropSettingsSchema, roomSizing } from '@afterhours/shared/features/drops';
import { type FeatureContext, one, run } from '../../core';

/** People signed in right now (first sign-in is event attendance). */
export function presentCount(ctx: FeatureContext): number {
  return one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM attendees WHERE first_signin_at IS NOT NULL')?.n ?? 0;
}

export const sizingOf = (ctx: FeatureContext) => roomSizing(presentCount(ctx));

/** The meter's fill line: the organiser's number, or sized to the room. */
export function hypeTargetOf(ctx: FeatureContext): number {
  const s = getSettings(ctx);
  return s.hypeTargetAuto ? sizingOf(ctx).hypeTarget : s.hypeTarget;
}

export const DEFAULT_SETTINGS: DropSettings = { feedMuted: false, hypeEnabled: true, hypeAuto: false, hypeTarget: 150, hypeTargetAuto: true };

const cache = new WeakMap<FeatureContext, DropSettings>();

export function getSettings(ctx: FeatureContext): DropSettings {
  const c = cache.get(ctx);
  if (c) return c;
  const row = one<{ value: string }>(ctx.db, "SELECT value FROM drops_settings WHERE key = 'settings'");
  let s = DEFAULT_SETTINGS;
  if (row) {
    try {
      const parsed = DropSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...(JSON.parse(row.value) as object) });
      if (parsed.success) s = parsed.data;
    } catch {
      /* keep defaults */
    }
  }
  cache.set(ctx, s);
  return s;
}

export function saveSettings(ctx: FeatureContext, patch: Partial<DropSettings>): DropSettings {
  // An organiser typing a target means "use this one", not "auto".
  const p = patch.hypeTarget !== undefined && patch.hypeTargetAuto === undefined ? { ...patch, hypeTargetAuto: false } : patch;
  const next = DropSettingsSchema.parse({ ...getSettings(ctx), ...p });
  run(
    ctx.db,
    "INSERT INTO drops_settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    JSON.stringify(next),
  );
  cache.set(ctx, next);
  return next;
}
