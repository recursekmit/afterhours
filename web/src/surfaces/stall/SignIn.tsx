/* Stall sign-in: the 6-digit code from the console, on a big keypad. Stays signed in for the day. */
import type { ShopMe } from '@afterhours/shared/features/stalls';
import { STALL_CODE_LEN } from '@afterhours/shared/features/stalls';
import { useAnimate, useReducedMotion } from 'motion/react';
import { type FormEvent, useState } from 'react';
import { haptics, sfx } from '../../fun';
import { Button, Card, Doodle, Mascot } from '../../kit';
import { Wordmark } from '../shared/Wordmark';
import { shopSignIn } from './api';
import s from './stall.module.css';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'go'] as const;

export function SignIn({ onDone }: { onDone: (me: ShopMe) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const reduce = useReducedMotion();

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!code || busy) return;
    setBusy(true);
    try {
      const me = await shopSignIn(code);
      sfx.success();
      onDone(me);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
      setCode('');
      sfx.fail();
      haptics.fail();
      if (!reduce && scope.current) void animate(scope.current, { x: [0, -12, 10, -8, 6, 0] }, { duration: 0.4 });
    } finally {
      setBusy(false);
    }
  };

  const press = (k: (typeof KEYS)[number]) => {
    sfx.tick();
    haptics.tick();
    setError(null);
    if (k === 'del') setCode((c) => c.slice(0, -1));
    else if (k === 'go') void submit();
    else setCode((c) => (c.length < STALL_CODE_LEN ? c + k : c));
  };

  return (
    <div className={s.gate}>
      <Wordmark size={46} />
      <div ref={scope} className={s.gateCard}>
        <Card tone="paper" tape tapeColor="lime" tilt={-1}>
          <form onSubmit={(e) => void submit(e)} className={s.gateForm} noValidate>
            <div className={s.gateHead}>
              <Mascot size={58} mood={error ? 'oops' : 'happy'} />
              <div>
                <h1 className={s.gateTitle}>stall sign in</h1>
                <p className={s.gateHint}>type the code the organisers gave your stall.</p>
              </div>
            </div>
            <div className={s.codeDisplay} aria-live="polite">
              <input className={s.codeInput} inputMode="numeric" autoComplete="off" aria-label="stall code" value={code} maxLength={STALL_CODE_LEN} onChange={(e) => (setError(null), setCode(e.target.value.replace(/\D/g, '').slice(0, STALL_CODE_LEN)))} />
              <span aria-hidden="true" className={s.codeDots}>
                {Array.from({ length: STALL_CODE_LEN }, (_, i) => (
                  <i key={i} data-on={i < code.length} />
                ))}
              </span>
            </div>
            {error && (
              <p className={s.gateError} role="alert">
                {error}
              </p>
            )}
            <div className={s.keys}>
              {KEYS.map((k) => (
                <Button key={k} tone={k === 'go' ? 'lime' : k === 'del' ? 'pink' : 'paper'} quiet className={s.key} onClick={() => press(k)} aria-label={k === 'del' ? 'delete' : k === 'go' ? 'sign in' : k} loading={k === 'go' && busy}>
                  {k === 'del' ? <Doodle name="undo" size={26} /> : k === 'go' ? 'go' : k}
                </Button>
              ))}
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}
