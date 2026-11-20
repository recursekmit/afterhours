/*
  Recap queries. Status is live (recap.status, plus the leaderboard's freeze/reveal events);
  the recap itself is fetched once it opens and kept for a while (it only grows slowly).
*/
import { OkSchema } from '@afterhours/shared';
import {
  RecapAttendeeListSchema,
  RecapSchema,
  RecapStatusSchema,
  RoomRecapSchema,
  StickerRaritySchema,
} from '@afterhours/shared/features/recap';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '../../core/api';
import { useLiveEvent } from '../../core/live';

export const rk = {
  status: ['recap', 'status'] as const,
  me: ['recap', 'me'] as const,
  room: ['recap', 'room'] as const,
  rarity: ['recap', 'rarity'] as const,
  attendees: (q: string) => ['recap', 'admin', 'attendees', q] as const,
  preview: (id: number) => ['recap', 'admin', 'preview', id] as const,
};

/** Keeps the gate fresh: our own event, and the leaderboard's closing moments. */
export function useRecapStatus(enabled = true) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: rk.status, queryFn: () => api.get('/api/recap/status', RecapStatusSchema), enabled, staleTime: 20_000, refetchInterval: 60_000 });
  useLiveEvent('recap.status', (d) => {
    qc.setQueryData(rk.status, d);
    if (d.open) void qc.invalidateQueries({ queryKey: rk.me });
  });
  useLiveEvent('leaderboard.freeze', () => void qc.invalidateQueries({ queryKey: rk.status }));
  useLiveEvent('leaderboard.reveal', (d) => {
    if (d.done) window.setTimeout(() => void qc.invalidateQueries({ queryKey: rk.status }), 2500);
  });
  return q;
}

export function useMyRecap(enabled: boolean) {
  return useQuery({ queryKey: rk.me, queryFn: () => api.get('/api/recap/me', RecapSchema), enabled, staleTime: 60_000, retry: 2 });
}

export function useRoomRecap(refetchMs = 8000) {
  return useQuery({ queryKey: rk.room, queryFn: () => api.get('/api/recap/room', RoomRecapSchema), refetchInterval: refetchMs });
}

export const SlapTotalSchema = z.object({ total: z.number().int() });

export const recapApi = {
  seen: (cards: number) => api.post('/api/recap/me/seen', { cards }, OkSchema),
  shared: () => api.post('/api/recap/me/shared', {}, OkSchema),
  slap: (count: number) => api.post('/api/recap/me/slaps', { count }, SlapTotalSchema),
  open: (open: boolean) => api.post('/api/recap/admin/open', { open }, RecapStatusSchema),
  attendees: (q: string) => api.get(`/api/recap/admin/attendees?q=${encodeURIComponent(q)}`, RecapAttendeeListSchema),
  preview: (id: number) => api.get(`/api/recap/admin/attendee/${id}`, RecapSchema),
  rarity: () => api.get('/api/recap/rarity', StickerRaritySchema),
};
