/*
  Flattens the web feature registry into the lists each surface needs.
  Surfaces read from here; features never import this file.
*/
import { features } from '../features/registry';
import type { SceneDef, WebFeature } from './feature';

const byOrder = <T extends { order: number }>(a: T, b: T) => a.order - b.order;

export const attendeeRoutes = features.flatMap((f) => (f.routes ?? []).map((r) => ({ ...r, feature: f.name })));

export const homeCards = features
  .flatMap((f) => (f.home ? [{ feature: f.name, ...f.home }] : []))
  .sort(byOrder);

export const navItems = features
  .flatMap((f) => (f.nav ? [{ feature: f.name, ...f.nav }] : []))
  .sort(byOrder);

export const consolePanels = features
  .flatMap((f) => (f.console ? [{ feature: f.name, ...f.console }] : []))
  .sort(byOrder);

export const scenes: (SceneDef & { feature: string })[] = features
  .flatMap((f) => (f.scenes ?? []).map((sc) => ({ ...sc, feature: f.name })))
  .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

const visibilityHooks = features.map((f) => ({ name: f.name, use: f.useVisible }));
/**
 * The features attendees should not see right now (e.g. the treasure hunt before an organiser switches it
 * on). Calls every feature's useVisible hook, always in the same order.
 */
export function useHiddenFeatures(): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const v of visibilityHooks) if (v.use && !v.use()) hidden.add(v.name);
  return hidden;
}

export const attendeeOverlays: WebFeature[] = features.filter((f) => f.AttendeeOverlay);
export const screenOverlays: WebFeature[] = features.filter((f) => f.ScreenOverlay);
