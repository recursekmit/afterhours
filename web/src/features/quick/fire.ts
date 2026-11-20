// "Fire this preset / re-run this session" with the idempotency key and the "something is already live" flow
// shared by the console and the speaker view.
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { isApiError } from '../../core/api';
import { useToast } from '../../kit';
import { newKey, quickApi } from './api';

export interface Conflict {
  /** What was being fired, so "close it and launch this" can repeat it. */
  target: string;
  message: string;
}

const CONFLICT_CODES = new Set(['poll_live', 'drop_live', 'morse_live']);

export function useFire(onLive?: (sessionId: number) => void) {
  const qc = useQueryClient();
  const toast = useToast();
  const keys = useRef(new Map<string, string>());
  const [pending, setPending] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);

  /** One key per target until it succeeds: a double tap or a retry is the same launch. */
  const fire = async (target: string, call: (key: string, closeLive: boolean) => Promise<{ session: { id: number } }>, closeLive = false) => {
    if (pending) return;
    const key = keys.current.get(target) ?? newKey();
    keys.current.set(target, key);
    setPending(target);
    setConflict(null);
    try {
      const v = await call(key, closeLive);
      keys.current.delete(target);
      void qc.invalidateQueries({ queryKey: ['quick'] });
      toast('live now. phones and the projector have it.', { kind: 'good', title: v.session ? 'on the air' : 'live' });
      onLive?.(v.session.id);
    } catch (e) {
      if (isApiError(e) && CONFLICT_CODES.has(e.code)) setConflict({ target, message: e.message });
      else toast(isApiError(e) ? e.message : 'That did not work.', { kind: 'bad', title: 'not live' });
    } finally {
      setPending(null);
    }
  };

  return {
    pending,
    conflict,
    clearConflict: () => setConflict(null),
    preset: (id: number, label?: string, closeLive = false) => fire(`preset:${id}`, (k, c) => quickApi.firePreset(id, k, c, label), closeLive),
    rerun: (id: number, label?: string, closeLive = false) => fire(`rerun:${id}`, (k, c) => quickApi.rerun(id, k, c, label), closeLive),
  };
}
