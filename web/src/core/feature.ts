/*
  The web feature contract. A feature lives in web/src/features/<name>/index.tsx,
  exports one WebFeature, and is listed once in web/src/features/registry.ts.
  Everything is optional: contribute only the slots you need.
*/
import type { ComponentType, LazyExoticComponent } from 'react';
import type { IconName } from '../kit/Doodle';

type Comp = ComponentType | LazyExoticComponent<ComponentType>;

export type SceneStatus = 'off' | 'available' | 'takeover';

export interface SceneDef {
  /** Unique across features: '<feature>' or '<feature>-<thing>'. Used for pinning. */
  id: string;
  /** Shown in the console's projector panel. */
  label: string;
  Component: Comp;
  /**
   * Hook deciding whether the scene should show. Called every render of the
   * scene host, so it must follow the rules of hooks (it is called
   * unconditionally, in registry order). Default: 'available'.
   * 'takeover' jumps the queue (e.g. a poll just opened).
   */
  useStatus?: () => SceneStatus;
  /** How long it stays up in rotation. Default 15000. */
  durationMs?: number;
  /** Rotation order. Lower first. */
  order?: number;
}

export interface WebFeature {
  /** Same as the folder and the server feature name. */
  name: string;
  /** Attendee screens. `path` is relative to the attendee root, e.g. 'polls' or 'hunt/:stopId'. */
  routes?: { path: string; Component: Comp }[];
  /** A card on the attendee home screen. */
  home?: { order: number; Card: Comp };
  /** An entry in the attendee bottom nav (keep it to the big things). */
  nav?: { order: number; label: string; to: string; icon: IconName };
  /**
   * Hook: whether attendees see this feature's nav entry and home card right now (default: always).
   * Called unconditionally on every render of the shell, in registry order (rules of hooks). Routes stay
   * mounted; the pages themselves show "not open yet" when the server refuses.
   */
  useVisible?: () => boolean;
  /** A panel in the organiser console at /admin/<path>. */
  console?: { order: number; label: string; path: string; icon: IconName; Panel: Comp };
  /** Projector scenes. */
  scenes?: SceneDef[];
  /** Always mounted over the attendee app (poll takeover, floating reactions, banners). */
  AttendeeOverlay?: Comp;
  /** Always mounted over the projector (reaction rain). */
  ScreenOverlay?: Comp;
}

/** Identity helper so feature objects are type-checked where they are written. */
export function defineFeature(f: WebFeature): WebFeature {
  return f;
}
