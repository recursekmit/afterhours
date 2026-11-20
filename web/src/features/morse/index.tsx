/*
  Morse challenge (spec 5.6): /morse (ladder, decode, encode, practice, speed
  round), a home card, the console and the projector scene.
  Server side: server/src/features/morse.
*/
import { MorseOverviewSchema } from '@afterhours/shared/features/morse';
import { useQuery } from '@tanstack/react-query';
import { lazy } from 'react';
import { api } from '../../core/api';
import type { SceneStatus } from '../../core/feature';
import { defineFeature } from '../../core/feature';
import { useLiveEvent } from '../../core/live';
import { TrailPage } from '../hunt/Attendee';
import { useTrailVisibility } from '../hunt/useHunt';
import { MorseHomeCard, MorsePage, useMorse } from './Attendee';

/** The Morse tab shows when the online ladder is on, or the morse challenge (the morse slip) is shown to players. */
function useMorseVisible(): boolean {
  const ladder = useMorse().data?.enabled ?? false;
  const slip = useTrailVisibility().morse;
  return ladder || slip;
}

function useMorseSceneStatus(): SceneStatus {
  const q = useQuery({ queryKey: ['morse', 'screen'], queryFn: () => api.get('/api/morse/screen', MorseOverviewSchema), refetchInterval: 10_000 });
  useLiveEvent('morse.state', () => void q.refetch());
  if (!q.data?.enabled) return 'off';
  return q.data.sprint ? 'takeover' : 'available';
}

export const morse = defineFeature({
  name: 'morse',
  // the morse slip and any other Morse trail live here, next to the online ladder
  routes: [
    { path: 'morse', Component: MorsePage },
    { path: 'morse/t/:trailId', Component: TrailPage },
  ],
  home: { order: 40, Card: MorseHomeCard },
  nav: { order: 25, label: 'morse', to: '/morse', icon: 'morse' },
  useVisible: useMorseVisible,
  console: { order: 50, label: 'morse', path: 'morse', icon: 'morse', Panel: lazy(() => import('./Console')) },
  scenes: [{ id: 'morse', label: 'morse ladder', Component: lazy(() => import('./Scene')), useStatus: useMorseSceneStatus, order: 50, durationMs: 15000 }],
});
