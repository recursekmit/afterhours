/*
  Sign-in. Kit ID is prefilled from ?kit=AH-042 (the QR on the card).
  The password is never in the URL.
*/
import { normaliseKitId } from '@afterhours/shared';
import { useAnimate, useReducedMotion } from 'motion/react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { isApiError } from '../../core/api';
import { useSignIn } from '../../core/queries';
import { celebrate, Draggy, haptics, sfx } from '../../fun';
import { Button, Card, Doodle, Mascot, TextField } from '../../kit';
import { ByRecurse } from '../../kit/Brand';
import { Wordmark } from '../shared/Wordmark';
import s from './attendee.module.css';

export function SignIn() {
  const [params] = useSearchParams();
  const rawKit = params.get('kit') ?? '';
  const [kitId, setKitId] = useState(() => normaliseKitId(rawKit) ?? rawKit);
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ kitId?: string; password?: string; form?: string }>({});
  const [scope, animate] = useAnimate<HTMLFormElement>();
  const signIn = useSignIn();
  const reduce = useReducedMotion();
  const pwRef = useRef<HTMLInputElement>(null);
  const kitRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Came from the QR: the kit ID is done, so the cursor goes to the password.
    if (kitId) pwRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (!kitId.trim()) next.kitId = 'It is on your card, like AH-042.';
    if (!password.trim()) next.password = 'The 6 characters under your kit ID.';
    if (next.kitId || next.password) {
      setErrors(next);
      fail();
      return;
    }
    setErrors({});
    signIn.mutate(
      { kitId, password },
      {
        onSuccess: () => {
          celebrate({ y: 0.6 });
        },
        onError: (err) => {
          const next: typeof errors = {};
          if (isApiError(err) && err.issues?.length) {
            for (const i of err.issues) {
              if (i.path.startsWith('kitId')) next.kitId = i.message;
              else if (i.path.startsWith('password')) next.password = i.message;
            }
          }
          if (!next.kitId && !next.password) next.form = err.message;
          setErrors(next);
          fail();
        },
      },
    );
  };

  function fail() {
    if (!reduce && scope.current) void animate(scope.current, { x: [0, -12, 10, -8, 6, -3, 0] }, { duration: 0.45 });
    sfx.fail();
    haptics.fail();
  }

  return (
    <div className={s.signin}>
      <div className={s.signinArt} aria-hidden="true" />
      <div className={s.signinConfetti} aria-hidden="true">
        <Draggy className={s.floatA}>
          <Doodle name="star" size={46} stroke="var(--gold)" fill="var(--gold)" strokeWidth={1.2} />
        </Draggy>
        <Draggy className={s.floatB}>
          <Doodle name="spark" size={30} stroke="var(--gold)" fill="var(--gold-bright)" strokeWidth={1.2} />
        </Draggy>
        <Draggy className={s.floatC}>
          <Doodle name="star" size={26} stroke="var(--gold)" fill="var(--gold)" strokeWidth={1.2} />
        </Draggy>
      </div>

      <header className={s.signinHead}>
        <Wordmark size={66} />
        <div className={s.lockup}>
          <ByRecurse height={30} />
        </div>
        <div className={s.byline}>
          <Mascot size={62} />
          <p className={s.bylineText}>
            a lazy afternoon from <b>recurse</b>, the kmit tech club.
          </p>
        </div>
      </header>

      <form ref={scope} className={s.kitWrap} onSubmit={submit} noValidate>
        <Card tone="paper" tape tapeColor="pink" lift className={s.kitCard}>
          <div className={s.kitHeader}>
            <Doodle name="key" size={30} fill="var(--sun)" />
            <h2 className={s.kitTitle}>your entry kit</h2>
          </div>
          <div className={s.kitFields}>
            <TextField
              ref={kitRef}
              label="kit id"
              value={kitId}
              onChange={(e) => setKitId(e.target.value)}
              placeholder="AH-042"
              autoCapitalize="characters"
              autoComplete="username"
              spellCheck={false}
              error={errors.kitId}
              enterKeyHint="next"
            />
            <TextField
              ref={pwRef}
              label="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="K7M 4QP"
              autoCapitalize="characters"
              autoComplete="current-password"
              spellCheck={false}
              error={errors.password}
              hint="the 6 characters on the card"
              enterKeyHint="go"
              style={{ letterSpacing: '0.12em', textTransform: 'uppercase' }}
            />
          </div>
          {errors.form && (
            <p className={s.formError} role="alert">
              {errors.form}
            </p>
          )}
          <Button type="submit" tone="lime" size="lg" block loading={signIn.isPending} icon="key">
            let me in
          </Button>
        </Card>
      </form>

      <p className={s.desk}>no card? ask at the entry desk.</p>
    </div>
  );
}
