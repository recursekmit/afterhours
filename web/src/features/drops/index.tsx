/*
  Drops (web): the flash-drop takeover on every phone (and /drop/g/<word> for a golden slip's QR), the home
  strip (streak chip, tease, live feed), the console panel, the projector takeover scene and the projector
  overlay (bottom ticker + hype meter). Server side: server/src/features/drops.
*/
import { lazy } from 'react';
import { defineFeature } from '../../core/feature';
import { DropsHomeCard } from './Home';
import { DropsScreenOverlay, useDropSceneStatus } from './Scene';
import { DropOverlay, GoldenLink } from './Takeover';

export const drops = defineFeature({
  name: 'drops',
  routes: [{ path: 'drop/g/:token', Component: GoldenLink }],
  home: { order: 3, Card: DropsHomeCard },
  AttendeeOverlay: DropOverlay,
  ScreenOverlay: DropsScreenOverlay,
  console: { order: 35, label: 'drops', path: 'drops', icon: 'bolt', Panel: lazy(() => import('./Console')) },
  scenes: [{ id: 'drops', label: 'flash drop', Component: lazy(() => import('./Scene')), useStatus: useDropSceneStatus, order: 5, durationMs: 20000 }],
});
