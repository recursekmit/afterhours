// Trail state on the phone (GET /api/hunt?trail=) kept fresh by hunt.* live events, plus the trail list and boards.
import { type HuntBoard, HuntBoardSchema, type HuntMe, HuntMeSchema, TREASURE_TRAIL_ID, TrailListSchema } from '@afterhours/shared/features/hunt';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../core/api';
import { useLiveEvent } from '../../core/live';

export const huntKey = (trailId: number) => ['hunt', 'me', trailId] as const;
export const boardKey = (trailId: number) => ['hunt', 'board', trailId] as const;
export const trailsKey = ['hunt', 'trails'] as const;

export function useTrails() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: trailsKey, queryFn: () => api.get('/api/hunt/trails', TrailListSchema), refetchInterval: 60_000 });
  useLiveEvent('hunt.state', () => void qc.invalidateQueries({ queryKey: trailsKey }));
  return q;
}

export function useHunt(trailId: number = TREASURE_TRAIL_ID) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: huntKey(trailId), queryFn: () => api.get(`/api/hunt?trail=${trailId}`, HuntMeSchema), refetchInterval: 45_000 });
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
    void qc.invalidateQueries({ queryKey: trailsKey });
  };
}

export function useHuntBoard(trailId: number = TREASURE_TRAIL_ID) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: boardKey(trailId), queryFn: () => api.get(`/api/hunt/board?trail=${trailId}`, HuntBoardSchema), refetchInterval: 30_000 });
  useLiveEvent('hunt.finished', (d) => d.trailId === trailId && void qc.invalidateQueries({ queryKey: boardKey(trailId) }));
  useLiveEvent('hunt.state', (d) => d.trailId === trailId && void qc.invalidateQueries({ queryKey: boardKey(trailId) }));
  useLiveEvent('hunt.crowd', (crowd) => crowd.trailId === trailId && qc.setQueryData<HuntBoard>(boardKey(trailId), (old) => (old ? { ...old, crowd } : old)));
  return q;
}
