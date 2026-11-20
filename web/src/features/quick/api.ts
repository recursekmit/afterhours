// Queries and calls for quick sessions. Server state lives in TanStack queries; live events refetch.
import { OkSchema } from '@afterhours/shared';
import {
  LiveViewSchema,
  OverviewSchema,
  type PresetInput,
  PresetSchema,
  SessionSchema,
  type SessionAction,
  type QuickSpecInput,
  type CommonInput,
} from '@afterhours/shared/features/quick';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../core/api';
import { useLiveEvent } from '../../core/live';

export const qk = {
  overview: ['quick', 'overview'] as const,
  session: (id: number) => ['quick', 'session', id] as const,
};

/** A fresh idempotency key. One per "go" press cycle: a retry or a double click reuses it. */
export function newKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function useOverview() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.overview, queryFn: () => api.get('/api/quick/overview', OverviewSchema), refetchInterval: 6000 });
  useLiveEvent('quick.changed', () => void qc.invalidateQueries({ queryKey: ['quick'] }));
  // an organiser using the polls / drops panel directly changes what "busy" means
  useLiveEvent('polls.changed', () => void qc.invalidateQueries({ queryKey: qk.overview }));
  useLiveEvent('drops.changed', () => void qc.invalidateQueries({ queryKey: qk.overview }));
  return q;
}

export function useSession(id: number) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.session(id), queryFn: () => api.get(`/api/quick/sessions/${id}`, LiveViewSchema), refetchInterval: 2000 });
  const refetch = () => void q.refetch();
  useLiveEvent('polls.results', refetch);
  useLiveEvent('polls.closed', refetch);
  useLiveEvent('drops.tally', refetch);
  useLiveEvent('drops.closed', refetch);
  useLiveEvent('attendance.counts', refetch);
  useLiveEvent('morse.sprint-board', refetch);
  useLiveEvent('quick.changed', () => void qc.invalidateQueries({ queryKey: qk.session(id) }));
  return q;
}

export interface GoBody {
  key: string;
  spec: QuickSpecInput;
  common: CommonInput;
  closeLive?: boolean;
  presetId?: number | null;
}

export const quickApi = {
  go: (b: GoBody) => api.post('/api/quick/go', b, LiveViewSchema),
  queue: (b: GoBody) => api.post('/api/quick/queue', b, SessionSchema),
  launch: (id: number, closeLive = false) => api.post(`/api/quick/sessions/${id}/go`, { closeLive }, LiveViewSchema),
  rerun: (id: number, key: string, closeLive = false, label?: string) => api.post(`/api/quick/sessions/${id}/rerun`, { key, closeLive, ...(label === undefined ? {} : { label }) }, LiveViewSchema),
  action: (id: number, action: SessionAction) => api.post(`/api/quick/sessions/${id}/action`, { action }, LiveViewSchema),
  savePreset: (b: PresetInput) => api.post('/api/quick/presets', b, PresetSchema),
  deletePreset: (id: number) => api.del(`/api/quick/presets/${id}`, OkSchema),
  firePreset: (id: number, key: string, closeLive = false, label?: string) =>
    api.post(`/api/quick/presets/${id}/go`, { key, closeLive, ...(label === undefined ? {} : { label }) }, LiveViewSchema),
};
