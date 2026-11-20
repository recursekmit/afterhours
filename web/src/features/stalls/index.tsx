/*
  Stalls and rewards (web). The phone side: a home card, /wallet (balance, free mocktails, menus, basket,
  receipts), /wallet/qr (the rotating full-screen QR) and a celebration overlay. The console panel lives
  here too. The shopkeeper's own surface is web/src/surfaces/stall (/stall).
  Server side: server/src/features/stalls.
*/
import { lazy } from 'react';
import { defineFeature } from '../../core/feature';
import { StallsOverlay } from './Celebrate';
import { QrScreen } from './QrScreen';
import { WalletHomeCard, WalletPage } from './Wallet';

export const stalls = defineFeature({
  name: 'stalls',
  routes: [
    { path: 'wallet', Component: WalletPage },
    { path: 'wallet/qr', Component: QrScreen },
  ],
  home: { order: 25, Card: WalletHomeCard },
  AttendeeOverlay: StallsOverlay,
  console: { order: 85, label: 'stalls', path: 'stalls', icon: 'star', Panel: lazy(() => import('./Console').then((m) => ({ default: m.StallsConsole }))) },
});
