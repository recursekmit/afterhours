// The cipher's queries and live wiring, shared by the phone, the projector and the console.
import { CipherAdminSchema, type CipherMe, CipherMeSchema, CipherScreenSchema } from '@afterhours/shared/features/cipher';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../core/api';
import { useLiveEvent } from '../../core/live';

export const cipherKey = ['cipher', 'me'] as const;

export function useCipher() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: cipherKey, queryFn: () => api.get('/api/cipher/me', CipherMeSchema), refetchInterval: 20_000 });
  useLiveEvent('cipher.me', () => void qc.invalidateQueries({ queryKey: cipherKey }));
  useLiveEvent('cipher.signal', () => void qc.invalidateQueries({ queryKey: cipherKey }));
  useLiveEvent('hunt.visibility', () => void qc.invalidateQueries({ queryKey: cipherKey }));
  return q;
}

/** Put a fresh CipherMe from any mutation straight into the cache. */
export function useSetMe() {
  const qc = useQueryClient();
  return (me: CipherMe) => {
    // a /me fetch that started before this answer landed must not overwrite it with the old state
    void qc.cancelQueries({ queryKey: cipherKey });
    qc.setQueryData(cipherKey, me);
  };
}

export function useCipherScreen() {
  const q = useQuery({ queryKey: ['cipher', 'screen'], queryFn: () => api.get('/api/cipher/screen', CipherScreenSchema), refetchInterval: 10_000 });
  useLiveEvent('cipher.changed', () => void q.refetch());
  useLiveEvent('hunt.visibility', () => void q.refetch());
  useLiveEvent('cipher.signal', () => void q.refetch());
  return q;
}

export function useCipherAdmin() {
  const q = useQuery({ queryKey: ['cipher', 'admin'], queryFn: () => api.get('/api/cipher/admin', CipherAdminSchema), refetchInterval: 4000 });
  useLiveEvent('cipher.changed', () => void q.refetch());
  useLiveEvent('cipher.signal', () => void q.refetch());
  return q;
}

export const pad3 = (n: number) => String(n).padStart(3, '0');

export function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
