/* Arcade rounds data: the hub query, the house standings, and the live events that refresh them. */
import { HousesResponseSchema, RoundsHubSchema } from '@afterhours/shared/features/arcade-rounds';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../core/api';
import { useLiveEvent } from '../../../core/live';

export const roundsKey = ['arcade', 'rounds'] as const;
export const housesKey = ['arcade', 'rounds', 'houses'] as const;

export function useRoundsHub() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: roundsKey, queryFn: () => api.get('/api/arcade/rounds', RoundsHubSchema), refetchInterval: 60_000 });
  const refresh = () => void qc.invalidateQueries({ queryKey: roundsKey });
  useLiveEvent('arcade.round', refresh);
  useLiveEvent('arcade.houses', refresh);
  useLiveEvent('arcade.perk', refresh);
  useLiveEvent('arcade.toggled', refresh);
  return q;
}

export function useHouses() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: housesKey, queryFn: () => api.get('/api/arcade/rounds/houses', HousesResponseSchema), refetchInterval: 30_000 });
  useLiveEvent('arcade.houses', () => void qc.invalidateQueries({ queryKey: housesKey }));
  useLiveEvent('arcade.round', () => void qc.invalidateQueries({ queryKey: housesKey }));
  return q;
}

/** Random key per press of Send / Run / Check / Claim, so a retry is recognised as the same request. */
export const pressKey = (): string => {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};
