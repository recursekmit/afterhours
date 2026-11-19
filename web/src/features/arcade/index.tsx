/*
  Arcade (spec 5.7): /arcade hub, /arcade/:game, the puzzle-hour games (/arcade/packet,
  /arcade/patch, /arcade/pixels), a home card, the NEW #1 and round toasts,
  the console and the projector scoreboards.
  Server side: server/src/features/arcade.
*/
import { lazy } from 'react';
import { defineFeature } from '../../core/feature';
import { ArcadeGame, ArcadeHomeCard, ArcadeHub, ArcadeOverlay } from './Attendee';
import { PacketPage, PatchPage, PixelsPage } from './rounds/Hub';

export const arcade = defineFeature({
  name: 'arcade',
  routes: [
    { path: 'arcade', Component: ArcadeHub },
    // The puzzle-hour games: static paths, so they win over arcade/:game.
    { path: 'arcade/packet', Component: PacketPage },
    { path: 'arcade/patch', Component: PatchPage },
    { path: 'arcade/pixels', Component: PixelsPage },
    { path: 'arcade/:game', Component: ArcadeGame },
  ],
  home: { order: 50, Card: ArcadeHomeCard },
  AttendeeOverlay: ArcadeOverlay,
  console: { order: 60, label: 'arcade', path: 'arcade', icon: 'gamepad', Panel: lazy(() => import('./Console')) },
  scenes: [{ id: 'arcade', label: 'arcade scores', Component: lazy(() => import('./Scene')), order: 60, durationMs: 15000 }],
});
