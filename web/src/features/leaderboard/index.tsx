/*
  Leaderboard (spec 5.8): /leaderboard with "you are #N", a nav entry, the console
  freeze/reveal controls and the projector race + final reveal.
  Server side: server/src/features/leaderboard.
*/
import { lazy } from 'react';
import { useServerNow } from '../../core/clock';
import type { SceneStatus } from '../../core/feature';
import { defineFeature } from '../../core/feature';
import { LeaderboardPage } from './Attendee';
import { HereCard } from './Here';
import { useBoard } from './useBoard';

function useBoardSceneStatus(): SceneStatus {
  const b = useBoard(10);
  const now = useServerNow(5000);
  const r = b.data?.freeze.reveal;
  if (r?.startedAt && (!r.done || now - (r.schedule?.at(-1) ?? 0) < 120_000)) return 'takeover';
  return (b.data?.players ?? 0) > 0 ? 'available' : 'off';
}

export const leaderboard = defineFeature({
  name: 'leaderboard',
  routes: [{ path: 'leaderboard', Component: LeaderboardPage }],
  home: { order: 2, Card: HereCard },
  nav: { order: 30, label: 'board', to: '/leaderboard', icon: 'trophy' },
  console: { order: 70, label: 'leaderboard', path: 'leaderboard', icon: 'trophy', Panel: lazy(() => import('./Console')) },
  scenes: [{ id: 'leaderboard', label: 'leaderboard', Component: lazy(() => import('./Scene')), useStatus: useBoardSceneStatus, order: 40, durationMs: 15000 }],
});
