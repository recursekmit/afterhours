// Organiser switches for drops: feed mute and the hype meter. One JSON row, cached in memory.
import { type DropSettings, DropSettingsSchema } from '@afterhours/shared/features/drops';
import { type FeatureContext, one, run } from '../../core';

export const DEFAULT_SETTINGS: DropSettings = { feedMuted: false, hypeEnabled: true, hypeAuto: false, hypeTarget: 150 };

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
  const next = DropSettingsSchema.parse({ ...getSettings(ctx), ...patch });
  run(
    ctx.db,
    "INSERT INTO drops_settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    JSON.stringify(next),
  );
  cache.set(ctx, next);
  return next;
}
