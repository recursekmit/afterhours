// Queries for drops. Server state lives in TanStack queries; live events refetch or patch them.
import {
  CurrentDropResponseSchema,
  DropsAdminStateSchema,
  type DropTally,
  FeedStateSchema,
  type FeedState,
  HypeStateSchema,
  MyStreakSchema,
  ScreenDropResponseSchema,
  type CurrentDropResponse,
  type ScreenDropResponse,
} from '@afterhours/shared/features/drops';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../core/api';
import { useLiveEvent } from '../../core/live';

export const dk = {
  current: ['drops', 'current'] as const,
  screen: ['drops', 'screen'] as const,
  feed: ['drops', 'feed'] as const,
  me: ['drops', 'me'] as const,
  hype: ['drops', 'hype'] as const,
  admin: ['drops', 'admin'] as const,
};

/** Patch a fresh tally into whichever drop response is cached, so counters move without a refetch. */
function withTally<T extends { drop: { id: number } | null; tally: DropTally | null }>(old: T | undefined, t: DropTally): T | undefined {
  if (!old?.drop || old.drop.id !== t.dropId) return old;
  return { ...old, tally: t };
}

export function useCurrentDrop() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: dk.current, queryFn: () => api.get('/api/drops/current', CurrentDropResponseSchema), refetchInterval: 20_000, staleTime: 2000 });
  useLiveEvent('drops.live', () => void q.refetch());
  useLiveEvent('drops.closed', () => void q.refetch());
  useLiveEvent('drops.changed', () => void q.refetch());
  useLiveEvent('drops.tally', (t) => qc.setQueryData<CurrentDropResponse>(dk.current, (old) => withTally(old, t)));
  return q;
}

export function useScreenDrop() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: dk.screen, queryFn: () => api.get('/api/drops/screen', ScreenDropResponseSchema), refetchInterval: 20_000, staleTime: 2000 });
  useLiveEvent('drops.live', () => void q.refetch());
  useLiveEvent('drops.closed', () => void q.refetch());
  useLiveEvent('drops.changed', () => void q.refetch());
  useLiveEvent('drops.challenge', () => void q.refetch());
  useLiveEvent('drops.tally', (t) => qc.setQueryData<ScreenDropResponse>(dk.screen, (old) => withTally(old, t)));
  return q;
}

/** The feed, kept live: new lines are appended, hidden ones dropped, newest last, capped. */
export function useFeed(cap = 12) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: dk.feed, queryFn: () => api.get('/api/drops/feed', FeedStateSchema), refetchInterval: 60_000 });
  useLiveEvent('drops.feed', (e) => {
    qc.setQueryData<FeedState>(dk.feed, (old) => {
      const hidden = new Set(e.hidden);
      const seen = new Set<string>();
      const items = [...(old?.items ?? []), ...e.items].filter((it) => !hidden.has(it.id) && !seen.has(it.id) && (seen.add(it.id), true));
      return { muted: e.muted, items: e.muted ? [] : items.slice(-cap) };
    });
  });
  return q;
}

export function useStreak() {
  const q = useQuery({ queryKey: dk.me, queryFn: () => api.get('/api/drops/me', MyStreakSchema), refetchInterval: 60_000 });
  useLiveEvent('points.awarded', () => void q.refetch());
  return q;
}

export function useHype() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: dk.hype, queryFn: () => api.get('/api/drops/hype', HypeStateSchema), refetchInterval: 30_000 });
  useLiveEvent('drops.hype', (h) => qc.setQueryData(dk.hype, h));
  return q;
}

export function useDropsAdmin() {
  const q = useQuery({ queryKey: dk.admin, queryFn: () => api.get('/api/drops/admin', DropsAdminStateSchema), refetchInterval: 3000 });
  useLiveEvent('drops.live', () => void q.refetch());
  useLiveEvent('drops.closed', () => void q.refetch());
  return q;
}
