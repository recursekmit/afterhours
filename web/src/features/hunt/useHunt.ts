// Trail state on the phone (GET /api/hunt?trail=) kept fresh by hunt.* live events, plus the trail lists,
// boards and the per-event player visibility ("show treasure hunt / morse challenge to players").
import {
  type HuntBoard,
  HuntBoardSchema,
  type HuntMe,
  HuntMeSchema,
  type HuntVisibility,
  HuntVisibilitySchema,
  TREASURE_TRAIL_ID,
  type TrailGroup,
  TrailListSchema,
} from '@afterhours/shared/features/hunt';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, isApiError } from '../../core/api';
import { useLiveEvent } from '../../core/live';

export const huntKey = (trailId: number) => ['hunt', 'me', trailId] as const;
export const boardKey = (trailId: number) => ['hunt', 'board', trailId] as const;
export const trailsKey = (group: TrailGroup) => ['hunt', 'trails', group] as const;
export const visibilityKey = ['hunt-visibility'] as const;

/** The server refused because that event is hidden from players. */
export const isNotOpen = (e: unknown): boolean => isApiError(e, 'not_open');
/** 403 not_open is an answer, not a failure: never retry it. */
const retry = (n: number, e: unknown) => !isNotOpen(e) && n < 1;

/**
 * Which events players can see. Both false until the server says otherwise (nothing flashes in), and a
 * flipped switch arrives live: the data updates and every hunt query refetches, so pages appear or hide
 * without a reload.
 */
export function useTrailVisibility(): HuntVisibility {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: visibilityKey, queryFn: () => api.get('/api/hunt/visibility', HuntVisibilitySchema), refetchInterval: 60_000, staleTime: 10_000 });
  useLiveEvent('hunt.visibility', (v) => {
    qc.setQueryData(visibilityKey, v);
    void qc.invalidateQueries({ queryKey: ['hunt'] });
  });
  return q.data ?? { hunt: false, morse: false };
}

export function useTrails(group: TrailGroup, enabled = true) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: trailsKey(group), queryFn: () => api.get(`/api/hunt/trails?group=${group}`, TrailListSchema), refetchInterval: 60_000, retry, enabled });
  useLiveEvent('hunt.state', () => void qc.invalidateQueries({ queryKey: ['hunt', 'trails'] }));
  return q;
}

export function useHunt(trailId: number = TREASURE_TRAIL_ID) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: huntKey(trailId), queryFn: () => api.get(`/api/hunt?trail=${trailId}`, HuntMeSchema), refetchInterval: 45_000, retry });
  useLiveEvent('hunt.state', (d) => d.trailId === trailId && void qc.invalidateQueries({ queryKey: huntKey(trailId) }));
  useLiveEvent('hunt.crowd', (crowd) => crowd.trailId === trailId && qc.setQueryData<HuntMe>(huntKey(trailId), (old) => (old ? { ...old, crowd } : old)));
  // A stamp made outside this screen (camera-app scan on another tab, the sticker landing) pays points: catch up.
  useLiveEvent('points.awarded', (d) => d.source === 'hunt' && void qc.invalidateQueries({ queryKey: ['hunt', 'me'] }));
  return q;
}

export function useSetHunt() {
  const qc = useQueryClient();
  return (me: HuntMe) => {
    qc.setQueryData(huntKey(me.trailId), me);
    void qc.invalidateQueries({ queryKey: ['hunt', 'trails'] });
  };
}

export function useHuntBoard(trailId: number = TREASURE_TRAIL_ID, enabled = true) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: boardKey(trailId), queryFn: () => api.get(`/api/hunt/board?trail=${trailId}`, HuntBoardSchema), refetchInterval: 30_000, retry, enabled });
  useLiveEvent('hunt.finished', (d) => d.trailId === trailId && void qc.invalidateQueries({ queryKey: boardKey(trailId) }));
  useLiveEvent('hunt.state', (d) => d.trailId === trailId && void qc.invalidateQueries({ queryKey: boardKey(trailId) }));
  useLiveEvent('hunt.crowd', (crowd) => crowd.trailId === trailId && qc.setQueryData<HuntBoard>(boardKey(trailId), (old) => (old ? { ...old, crowd } : old)));
  return q;
}
