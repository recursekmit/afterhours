/*
  Core queries and mutations. Features build their own the same way:
  useQuery({ queryKey: ['<feature>', ...], queryFn: () => api.get(path, Schema) })
  and invalidate them from useLiveEvent handlers.
*/
import {
  AppConfigSchema,
  type LeaderboardResponse,
  LeaderboardResponseSchema,
  type MeResponse,
  MeResponseSchema,
  MyPointsResponseSchema,
  OkSchema,
  type Presence,
  PresenceSchema,
  type ProfileInput,
  type SignInRequest,
  type IdSignInRequest,
  type RollSignInRequest,
  StaffMeSchema,
  type StaffRole,
  StickerBookResponseSchema,
} from '@afterhours/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, isApiError } from './api';

export const qk = {
  me: ['me'] as const,
  points: ['points', 'me'] as const,
  stickers: ['stickers'] as const,
  leaderboard: (limit: number) => ['leaderboard', limit] as const,
  presence: ['presence'] as const,
  config: ['config'] as const,
  staff: (role: StaffRole) => ['staff', role] as const,
  kits: ['admin', 'kits'] as const,
  participants: ['admin', 'participants'] as const,
  gateStats: ['gate', 'stats'] as const,
  screenState: ['screen', 'state'] as const,
};

/** null = not signed in. */
export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: async (): Promise<MeResponse | null> => {
      try {
        return await api.get('/api/me', MeResponseSchema);
      } catch (e) {
        if (isApiError(e) && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
    retry: (n, e) => !(isApiError(e) && e.status < 500) && n < 3,
  });
}

export function useSignIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SignInRequest) => api.post('/api/auth/signin', body, MeResponseSchema),
    onSuccess: (me) => {
      qc.setQueryData(qk.me, me);
      void qc.invalidateQueries({ queryKey: qk.points });
      void qc.invalidateQueries({ queryKey: qk.stickers });
    },
  });
}

/** Student-ID sign-in: after a scan (+ the full roll or phone digits when asked), or typed roll + phone digits. */
export function useIdSignIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { kind: 'scan'; req: IdSignInRequest } | { kind: 'typed'; req: RollSignInRequest }) =>
      body.kind === 'scan' ? api.post('/api/auth/id/signin', body.req, MeResponseSchema) : api.post('/api/auth/roll/signin', body.req, MeResponseSchema),
    onSuccess: (me) => {
      qc.setQueryData(qk.me, me);
      void qc.invalidateQueries({ queryKey: qk.points });
      void qc.invalidateQueries({ queryKey: qk.stickers });
    },
  });
}

export function useSaveProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProfileInput) => api.put('/api/me/profile', body, MeResponseSchema),
    onSuccess: (me) => qc.setQueryData(qk.me, me),
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/api/auth/signout', {}, OkSchema),
    onSuccess: () => {
      qc.setQueryData(qk.me, null);
      qc.removeQueries({ queryKey: qk.points });
      qc.removeQueries({ queryKey: qk.stickers });
    },
  });
}

export function useMyPoints(enabled = true) {
  return useQuery({ queryKey: qk.points, queryFn: () => api.get('/api/points/me', MyPointsResponseSchema), enabled });
}

export function useStickerBook(enabled = true) {
  return useQuery({ queryKey: qk.stickers, queryFn: () => api.get('/api/stickers', StickerBookResponseSchema), enabled });
}

export function useLeaderboard(limit = 20) {
  return useQuery<LeaderboardResponse>({
    queryKey: qk.leaderboard(limit),
    queryFn: () => api.get(`/api/points/leaderboard?limit=${limit}`, LeaderboardResponseSchema),
  });
}

export function usePresence() {
  return useQuery<Presence>({ queryKey: qk.presence, queryFn: () => api.get('/api/presence', PresenceSchema), staleTime: 30_000 });
}

export function useAppConfig() {
  return useQuery({ queryKey: qk.config, queryFn: () => api.get('/api/config', AppConfigSchema), staleTime: Infinity });
}

/** Console / projector / gate session. Resolves to true/false. */
export function useStaffSession(role: StaffRole) {
  return useQuery({
    queryKey: qk.staff(role),
    queryFn: async () => {
      try {
        await api.get(`/api/${role}/session`, StaffMeSchema);
        return true;
      } catch (e) {
        if (isApiError(e) && e.status === 401) return false;
        throw e;
      }
    },
    retry: false,
  });
}

export function useStaffSignIn(role: StaffRole) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pin: string) => api.post(`/api/${role}/session`, { pin }, StaffMeSchema),
    onSuccess: () => qc.setQueryData(qk.staff(role), true),
  });
}

export function useStaffSignOut(role: StaffRole) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del(`/api/${role}/session`, OkSchema),
    onSuccess: () => qc.setQueryData(qk.staff(role), false),
  });
}
