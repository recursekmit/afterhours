/*
  Recap (web): the personal story at /recap with its share image, the home card, the console panel
  (open switch, room totals, preview) and the projector's room recap. Server side: server/src/features/recap.
*/
import { lazy } from 'react';
import { defineFeature } from '../../core/feature';
import { RecapHomeCard, useRecapSceneStatus } from './Parts';
import { RecapPage } from './Story';

export const recap = defineFeature({
  name: 'recap',
  routes: [{ path: 'recap', Component: RecapPage }],
  home: { order: 1, Card: RecapHomeCard },
  console: { order: 95, label: 'recap', path: 'recap', icon: 'spark', Panel: lazy(() => import('./Parts').then((m) => ({ default: m.RecapConsole }))) },
  scenes: [{ id: 'recap', label: 'room recap', Component: lazy(() => import('./Parts')), useStatus: useRecapSceneStatus, order: 95, durationMs: 25000 }],
});
