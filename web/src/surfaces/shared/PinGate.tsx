/*
  PinGate: the sign-in for staff surfaces (console, projector, door gate).
  A chunky keypad works on a laptop trackpad, a phone and a projector remote.
*/
import type { StaffRole } from '@afterhours/shared';
import { useAnimate, useReducedMotion } from 'motion/react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useStaffSession, useStaffSignIn } from '../../core/queries';
import { haptics, sfx } from '../../fun';
import { Button, Card, Doodle, LoadingState, Mascot } from '../../kit';
import { Wordmark } from './Wordmark';
import s from './pingate.module.css';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'go'] as const;

export function PinGate({ role, children }: { role: StaffRole; children: ReactNode }) {
  const session = useStaffSession(role);
  const signIn = useStaffSignIn(role);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const reduce = useReducedMotion();

  if (session.isPending) return <LoadingState label="checking your pass..." />;
  if (session.data) return <>{children}</>;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!pin) return;
    signIn.mutate(pin, {
      onSuccess: () => sfx.success(),
      onError: (err) => {
        setError(err.message);
        setPin('');
        sfx.fail();
        haptics.fail();
        if (!reduce && scope.current) void animate(scope.current, { x: [0, -12, 10, -8, 6, 0] }, { duration: 0.4 });
      },
    });
  };

  const press = (k: (typeof KEYS)[number]) => {
    sfx.tick();
    haptics.tick();
    setError(null);
    if (k === 'del') setPin((p) => p.slice(0, -1));
    else if (k === 'go') submit();
    else setPin((p) => (p.length < 12 ? p + k : p));
  };

  const title = role === 'admin' ? 'organisers only' : role === 'screen' ? 'projector pin' : 'door coordinators';
  const hint =
    role === 'admin'
      ? 'the console pin, not your kit password.'
      : role === 'screen'
        ? 'type it on the laptop driving the big screen.'
        : 'the gate pin, to scan student IDs at entry.';

  return (
    <div className={s.gate} data-role={role}>
      <div className={s.head}>
        <Wordmark size={50} />
      </div>
      <div ref={scope}>
        <Card tone="paper" tape tapeColor="sun" lift tilt={-1} className={s.card}>
          <form onSubmit={submit} className={s.form} noValidate>
            <div className={s.titleRow}>
              <Mascot size={54} mood={error ? 'oops' : 'happy'} />
              <div>
                <h2 className={s.title}>{title}</h2>
                <p className={s.hint}>{hint}</p>
              </div>
            </div>
            <div className={s.display} aria-live="polite">
              <input
                className={s.pinInput}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                aria-label="PIN"
                value={pin}
                onChange={(e) => {
                  setError(null);
                  setPin(e.target.value.slice(0, 12));
                }}
                autoFocus
              />
              <span className={s.dots} aria-hidden="true">
                {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
                  <i key={i} data-on={i < pin.length} />
                ))}
              </span>
            </div>
            {error && (
              <p className={s.error} role="alert">
                {error}
              </p>
            )}
            <div className={s.keys}>
              {KEYS.map((k) => (
                <Button key={k} tone={k === 'go' ? 'lime' : k === 'del' ? 'pink' : 'paper'} size="sm" quiet onClick={() => press(k)} aria-label={k === 'del' ? 'delete' : k === 'go' ? 'unlock' : k} loading={k === 'go' && signIn.isPending}>
                  {k === 'del' ? <Doodle name="undo" size={20} /> : k === 'go' ? 'go' : k}
                </Button>
              ))}
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}
