/*
  Student-ID sign-in (spec 4.1), the first and biggest way in.
    scan your student ID -> "hi Kashvi! that's you?" -> yes -> profile
  Kind detours: more than one roll ends like this card (type your full roll),
  not on the list (show this at the desk), already on another phone, camera
  denied or no QR (type roll + last 4 phone digits).
*/
import { type IdResolveResponse, IdResolveResponseSchema } from '@afterhours/shared';
import { type FormEvent, useState } from 'react';
import { api, isApiError } from '../../core/api';
import { useIdSignIn } from '../../core/queries';
import { IdScanner } from '../../features/common/IdScanner';
import { celebrate, haptics, sfx } from '../../fun';
import { Button, Card, Doodle, Mascot, TextField } from '../../kit';
import s from './idsignin.module.css';

type Problem = 'not_registered' | 'id_bound' | 'bad_qr' | 'other';
type Step =
  | { k: 'start' }
  | { k: 'scan' }
  | { k: 'checking' }
  | { k: 'needRoll'; payload: string; message: string }
  | { k: 'confirm'; payload: string; roll?: string; who: IdResolveResponse }
  | { k: 'typed' }
  | { k: 'problem'; code: Problem; message: string; card?: string };

const cardLabel = (payload: string) => payload.trim().toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean)[0]?.slice(0, 12);

export function IdSignIn({ onStepChange }: { onStepChange?: (busy: boolean) => void }) {
  const [step, setStepRaw] = useState<Step>({ k: 'start' });
  const signIn = useIdSignIn();
  const setStep = (n: Step) => {
    setStepRaw(n);
    onStepChange?.(n.k !== 'start');
  };

  const fail = () => {
    sfx.fail();
    haptics.fail();
  };

  function problemFrom(err: unknown, payload?: string): Step {
    if (isApiError(err) && (err.code === 'not_registered' || err.code === 'id_bound' || err.code === 'bad_qr')) {
      return { k: 'problem', code: err.code, message: err.message, card: payload ? cardLabel(payload) : undefined };
    }
    return { k: 'problem', code: 'other', message: err instanceof Error ? err.message : 'Something went wrong. Try again.' };
  }

  async function resolve(payload: string, roll?: string): Promise<Step> {
    try {
      const who = await api.post('/api/auth/id/resolve', { payload, ...(roll ? { roll } : {}) }, IdResolveResponseSchema);
      return { k: 'confirm', payload, ...(roll ? { roll } : {}), who };
    } catch (err) {
      if (isApiError(err, 'need_roll')) return { k: 'needRoll', payload, message: err.message };
      throw err;
    }
  }

  const onScan = async (payload: string) => {
    setStep({ k: 'checking' });
    try {
      setStep(await resolve(payload));
    } catch (err) {
      fail();
      setStep(problemFrom(err, payload));
    }
  };

  switch (step.k) {
    case 'start':
      return (
        <div className={s.start}>
          <button type="button" className={s.bigScan} onClick={() => setStep({ k: 'scan' })} data-testid="scan-id">
            <span className={s.bigScanIcon} aria-hidden="true">
              <Doodle name="qr" size={54} />
            </span>
            <span className={s.bigScanText}>
              <span className={s.bigScanTitle}>scan your student ID</span>
              <span className={s.bigScanSub}>the QR on your college ID card. one scan and you're in.</span>
            </span>
          </button>
          <button type="button" className={s.linkish} onClick={() => setStep({ k: 'typed' })}>
            no camera, or no QR on your card? type your roll number
          </button>
        </div>
      );

    case 'scan':
      return (
        <Card tone="paper" tape tapeColor="sun" className={s.card}>
          <h2 className={s.title}>scan your student ID</h2>
          <IdScanner onCode={(t) => void onScan(t)} onCancel={() => setStep({ k: 'start' })} fallbackLabel="type my roll instead" onFallback={() => setStep({ k: 'typed' })} />
        </Card>
      );

    case 'checking':
      return (
        <Card tone="paper" className={s.card}>
          <p className={s.checking} role="status">
            <span className={s.spin} aria-hidden="true" /> looking you up...
          </p>
        </Card>
      );

    case 'needRoll':
      return <NeedRoll step={step} onBack={() => setStep({ k: 'scan' })} resolve={resolve} onDone={setStep} onProblem={(e) => setStep(problemFrom(e, step.payload))} />;

    case 'confirm':
      return (
        <Confirm
          step={step}
          pending={signIn.isPending}
          onNo={() => setStep({ k: 'scan' })}
          onYes={(phone4, setError) =>
            signIn.mutate(
              { kind: 'scan', req: { payload: step.payload, ...(step.roll ? { roll: step.roll } : {}), ...(phone4 ? { phone4 } : {}) } },
              {
                onSuccess: () => celebrate({ y: 0.6 }),
                onError: (err) => {
                  fail();
                  if (isApiError(err) && (err.code === 'bad_credentials' || err.code === 'bad_request' || err.code === 'rate_limited')) setError(err.message);
                  else setStep(problemFrom(err, step.payload));
                },
              },
            )
          }
        />
      );

    case 'typed':
      return (
        <Typed
          pending={signIn.isPending}
          onBack={() => setStep({ k: 'start' })}
          onScan={() => setStep({ k: 'scan' })}
          onSubmit={(roll, phone4, setError) =>
            signIn.mutate(
              { kind: 'typed', req: { roll, phone4 } },
              {
                onSuccess: () => celebrate({ y: 0.6 }),
                onError: (err) => {
                  fail();
                  if (isApiError(err, 'id_bound')) setStep(problemFrom(err));
                  else setError(err.message);
                },
              },
            )
          }
        />
      );

    case 'problem':
      return <ProblemCard step={step} onScan={() => setStep({ k: 'scan' })} onTyped={() => setStep({ k: 'typed' })} />;
  }
}

function Confirm({
  step,
  pending,
  onYes,
  onNo,
}: {
  step: Extract<Step, { k: 'confirm' }>;
  pending: boolean;
  onYes: (phone4: string | undefined, setError: (m: string) => void) => void;
  onNo: () => void;
}) {
  const [phone4, setPhone4] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { who } = step;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (who.needPhone && !/^\d{4}$/.test(phone4.trim())) {
      setError('The last 4 digits of the phone number you registered with.');
      return;
    }
    setError(null);
    onYes(who.needPhone ? phone4.trim() : undefined, setError);
  };
  return (
    <form onSubmit={submit} noValidate>
      <Card tone="lime" tape tapeColor="pink" lift halftone className={s.card} data-testid="id-confirm">
        <div className={s.hello}>
          <Mascot size={72} mood="wow" />
          <div>
            <h2 className={s.helloTitle}>hi {who.firstName}! that's you?</h2>
            <p className={s.roll}>{who.roll}</p>
          </div>
        </div>
        {who.needPhone && (
          <TextField
            label="last 4 digits of your phone"
            value={phone4}
            onChange={(e) => setPhone4(e.target.value.replace(/\D/g, '').slice(0, 4))}
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            placeholder="4210"
            hint="the number you registered with"
            error={error}
          />
        )}
        {error && !who.needPhone && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
        <Button type="submit" tone="sun" size="lg" block loading={pending} icon="check">
          yes, that's me
        </Button>
        <Button tone="paper" size="sm" ghost onClick={onNo}>
          not me, scan again
        </Button>
      </Card>
    </form>
  );
}

function NeedRoll({
  step,
  onBack,
  resolve,
  onDone,
  onProblem,
}: {
  step: Extract<Step, { k: 'needRoll' }>;
  onBack: () => void;
  resolve: (payload: string, roll?: string) => Promise<Step>;
  onDone: (s: Step) => void;
  onProblem: (e: unknown) => void;
}) {
  const [roll, setRoll] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (roll.trim().length < 6) {
      setError('Your full roll number, like 26BD1A0501.');
      return;
    }
    setBusy(true);
    try {
      onDone(await resolve(step.payload, roll));
    } catch (err) {
      sfx.fail();
      if (isApiError(err) && (err.code === 'bad_request' || err.code === 'rate_limited')) setError(err.message);
      else onProblem(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <Card tone="sky" tape tapeColor="sun" className={s.card} data-testid="id-need-roll">
        <h2 className={s.title}>which one are you?</h2>
        <p className={s.body}>{step.message}</p>
        <TextField
          label="your full roll number"
          value={roll}
          onChange={(e) => setRoll(e.target.value)}
          placeholder="26BD1A0501"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          error={error}
          style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}
        />
        <Button type="submit" tone="lime" size="lg" block loading={busy} icon="arrow">
          that's my roll
        </Button>
        <Button tone="paper" size="sm" ghost onClick={onBack}>
          scan again
        </Button>
      </Card>
    </form>
  );
}

function Typed({
  pending,
  onSubmit,
  onBack,
  onScan,
}: {
  pending: boolean;
  onSubmit: (roll: string, phone4: string, setError: (m: string) => void) => void;
  onBack: () => void;
  onScan: () => void;
}) {
  const [roll, setRoll] = useState('');
  const [phone4, setPhone4] = useState('');
  const [errors, setErrors] = useState<{ roll?: string; phone4?: string; form?: string }>({});
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (roll.trim().length < 4) next.roll = 'Your full roll number, like 26BD1A0501.';
    if (!/^\d{4}$/.test(phone4)) next.phone4 = 'The last 4 digits of the phone number you registered with.';
    setErrors(next);
    if (next.roll || next.phone4) {
      sfx.fail();
      return;
    }
    onSubmit(roll, phone4, (m) => setErrors({ form: m }));
  };
  return (
    <form onSubmit={submit} noValidate>
      <Card tone="paper" tape tapeColor="sky" className={s.card} data-testid="id-typed">
        <div className={s.head}>
          <Doodle name="key" size={30} fill="var(--sun)" />
          <h2 className={s.title}>type your roll instead</h2>
        </div>
        <TextField
          label="roll number"
          value={roll}
          onChange={(e) => setRoll(e.target.value)}
          placeholder="26BD1A0501"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          error={errors.roll}
          enterKeyHint="next"
          style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}
        />
        <TextField
          label="last 4 digits of your phone"
          value={phone4}
          onChange={(e) => setPhone4(e.target.value.replace(/\D/g, '').slice(0, 4))}
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          placeholder="4210"
          hint="the phone number you gave when you registered"
          error={errors.phone4}
          enterKeyHint="go"
        />
        {errors.form && (
          <p className={s.error} role="alert">
            {errors.form}
          </p>
        )}
        <Button type="submit" tone="lime" size="lg" block loading={pending} icon="key">
          let me in
        </Button>
        <div className={s.row}>
          <Button tone="paper" size="sm" icon="qr" onClick={onScan}>
            scan instead
          </Button>
          <Button tone="paper" size="sm" ghost onClick={onBack}>
            back
          </Button>
        </div>
      </Card>
    </form>
  );
}

const PROBLEM_COPY: Record<Problem, { title: string; tone: 'pink' | 'sun' | 'sky'; body: string }> = {
  not_registered: { title: "you're not on the list", tone: 'pink', body: "show this screen at the entry desk. they'll add you in seconds, or hand you an entry kit." },
  id_bound: { title: 'this ID is already signed in on another phone', tone: 'sun', body: "if that wasn't you, show this screen at the entry desk and they'll move it to this phone." },
  bad_qr: { title: "that QR isn't a college ID", tone: 'sky', body: 'scan the QR on your student ID card, or type your roll number.' },
  other: { title: 'hmm, that did not work', tone: 'sky', body: '' },
};

function ProblemCard({ step, onScan, onTyped }: { step: Extract<Step, { k: 'problem' }>; onScan: () => void; onTyped: () => void }) {
  const copy = PROBLEM_COPY[step.code];
  return (
    <Card tone={copy.tone} tape tapeColor="lime" lift className={s.card} data-testid={`id-problem-${step.code}`} role="alert">
      <div className={s.hello}>
        <Mascot size={64} mood="oops" />
        <h2 className={s.helloTitle}>{copy.title}</h2>
      </div>
      <p className={s.body}>{copy.body || step.message}</p>
      {step.card && (
        <p className={s.deskTag}>
          for the desk: card <b>{step.card}</b>
        </p>
      )}
      <div className={s.row}>
        <Button tone="paper" icon="qr" onClick={onScan}>
          scan again
        </Button>
        {step.code !== 'id_bound' && (
          <Button tone="paper" icon="key" onClick={onTyped}>
            type my roll
          </Button>
        )}
      </div>
    </Card>
  );
}
