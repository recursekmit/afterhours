/*
  The Cipher Ticket: the main Morse activity. /morse/cipher on the phone (linked from the Morse page and
  the home card), the "cipher" console panel and the guild race on the projector.
  Server side: server/src/features/cipher. Contract: shared/src/features/cipher.ts.
*/
import { CipherScreenSchema } from '@afterhours/shared/features/cipher';
import { useQuery } from '@tanstack/react-query';
import { lazy } from 'react';
import { api } from '../../core/api';
import type { SceneStatus } from '../../core/feature';
import { defineFeature } from '../../core/feature';
import { useLiveEvent } from '../../core/live';
import { CipherHomeCard, CipherPage } from './Attendee';

function useRaceStatus(): SceneStatus {
  const q = useQuery({ queryKey: ['cipher', 'screen'], queryFn: () => api.get('/api/cipher/screen', CipherScreenSchema), refetchInterval: 10_000 });
  useLiveEvent('cipher.changed', () => void q.refetch());
  if (!q.data?.visible || q.data.players === 0) return 'off';
  return 'available';
}

export const cipher = defineFeature({
  name: 'cipher',
  routes: [{ path: 'morse/cipher', Component: CipherPage }],
  home: { order: 39, Card: CipherHomeCard },
  console: { order: 49, label: 'cipher', path: 'cipher', icon: 'ticket', Panel: lazy(() => import('./Console')) },
  scenes: [{ id: 'cipher-morse', label: 'cipher guild race', Component: lazy(() => import('./Scene')), useStatus: useRaceStatus, order: 49, durationMs: 18000 }],
});
