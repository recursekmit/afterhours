/*
  Check-in on the phone.
  - /checkin: 4-box code entry (auto-advance, uppercase), or scan the QR beside
    the code on the projector. Deep link /checkin?a=<activity>&code=<code> checks
    in straight away (that is what the projector QR opens).
  - Success: the sticker slaps on, "you're #14 here" counts up, confetti.
  - Wrong code: shake + buzz. Too many: a cooldown ring until retryAfter.
  - Home card + banner when an organiser opens a check-in.
*/
import { CHECKIN_CODE_ALPHABET, CHECKIN_CODE_LENGTH, type CheckinResponse, CheckinResponseSchema, MyAttendanceSchema } from '@afterhours/shared/features/attendance';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, isApiError } from '../../core/api';
import { useServerNow, serverNow } from '../../core/clock';
import { useLiveEvent } from '../../core/live';
import { celebrate, haptics, sfx } from '../../fun';
import { Button, Card, Doodle, ErrorState, LinkButton, LoadingState, NumberTicker, ProgressRing, Sticker, useToast } from '../../kit';
import { CodeBoxes } from '../common/CodeBoxes';
import { Scanner, canScanInApp } from '../common/Scanner';
import { PageHead, ui } from '../common/ui';
import s from './attendance.module.css';
import { CountUp } from './CountUp';

export const attendanceKey = ['attendance', 'me'] as const;

export function useMyAttendance() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: attendanceKey, queryFn: () => api.get('/api/attendance/me', MyAttendanceSchema), refetchInterval: 60_000 });
  useLiveEvent('attendance.state', () => void qc.invalidateQueries({ queryKey: attendanceKey }));
  useLiveEvent('attendance.counts', (d) =>
    qc.setQueryData(attendanceKey, (old: typeof q.data) => (old ? { ...old, open: old.open.map((o) => ({ ...o, count: d.counts[o.activityId] ?? o.count })) } : old)),
  );
  return q;
}

/** Pull "code" (and "a") out of whatever a QR held: our URL, or a bare code. */
function parseScan(text: string): { code: string; activityId?: string } | null {
  try {
    const u = new URL(text);
    const code = u.searchParams.get('code');
    if (code) return { code, activityId: u.searchParams.get('a') ?? undefined };
  } catch {
    /* not a URL */
  }
  const bare = text.trim().toUpperCase();
  return bare.length === CHECKIN_CODE_LENGTH ? { code: bare } : null;
}

const STICKER = { shape: 'ticket', color: 'lime', glyph: 'check' } as const;

function Success({ r, onAgain }: { r: CheckinResponse; onAgain: () => void }) {
  useEffect(() => {
    if (r.newlyCheckedIn) celebrate({ y: 0.35 });
  }, [r.newlyCheckedIn]);
  return (
    <Card tone="lime" tilt={-1.2} tape className={s.success}>
      <Sticker def={STICKER} size={120} tilt={-8} slap />
      <p className={s.youre}>
        you're{' '}
        <motion.span className={s.pos} initial={{ scale: 0.3, rotate: -30, opacity: 0 }} animate={{ scale: 1, rotate: -4, opacity: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 12, delay: 0.25 }}>
          #<CountUp value={r.position} delayMs={350} />
        </motion.span>{' '}
        here
      </p>
      <h2 className={s.what}>{r.title}</h2>
      {r.newlyCheckedIn && (
        <motion.span className={s.plusTen} initial={{ scale: 0, rotate: 20 }} animate={{ scale: 1, rotate: -5 }} transition={{ type: 'spring', stiffness: 600, damping: 11, delay: 0.7 }}>
          +<CountUp value={r.points} delayMs={800} />
        </motion.span>
      )}
      <p className={ui.hand}>{r.newlyCheckedIn ? `${r.count} people in so far.` : 'you were already in. no double points, nice try.'}</p>
      <div className={ui.row}>
        <LinkButton to="/" tone="ink" icon="home">
          back home
        </LinkButton>
        <Button tone="paper" onClick={onAgain}>
          another code
        </Button>
      </div>
    </Card>
  );
}

function Cooldown({ until, onDone }: { until: number; onDone: () => void }) {
  const now = useServerNow(250);
  const total = useRef(Math.max(1, until - serverNow()));
  const left = until - now;
  useEffect(() => {
    if (left <= 0) onDone();
  }, [left, onDone]);
  return (
    <div className={s.cooldown}>
      <ProgressRing value={1 - left / total.current} size={96} thickness={12} tone="pink" label="cooldown">
        <span className={s.coolNum}>{Math.max(0, Math.ceil(left / 1000))}</span>
      </ProgressRing>
      <p className={ui.hand}>too many wrong guesses. look at the big screen, breathe.</p>
    </div>
  );
}

export function CheckinPage() {
  const [params, setParams] = useSearchParams();
  const me = useMyAttendance();
  const qc = useQueryClient();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [shake, setShake] = useState(0);
  const [nope, setNope] = useState(false);
  const [result, setResult] = useState<CheckinResponse | null>(null);
  const [coolUntil, setCoolUntil] = useState<number | null>(null);
  const [scan, setScan] = useState(false);
  const deepTried = useRef(false);

  const submit = useMutation({
    mutationFn: (b: { code: string; activityId?: string }) => api.post('/api/attendance/checkin', b, CheckinResponseSchema),
    onSuccess: (r) => {
      setResult(r);
      setCode('');
      sfx.success();
      haptics.success();
      void qc.invalidateQueries({ queryKey: attendanceKey });
    },
    onError: (e) => {
      setCode('');
      setShake((n) => n + 1);
      setNope(true);
      window.setTimeout(() => setNope(false), 900);
      sfx.fail();
      haptics.fail();
      if (isApiError(e, 'rate_limited')) setCoolUntil(serverNow() + (e.retryAfter ?? 15) * 1000);
      else toast(e.message, { kind: 'bad', title: 'not quite' });
    },
  });

  // Deep link from the projector QR: check in straight away.
  useEffect(() => {
    const c = params.get('code');
    if (!c || deepTried.current) return;
    deepTried.current = true;
    submit.mutate({ code: c, activityId: params.get('a') ?? undefined });
    setParams({}, { replace: true });
  }, [params, setParams, submit]);

  if (me.isPending) return <LoadingState label="checking the door..." />;
  if (me.isError) return <ErrorState error={me.error} onRetry={() => void me.refetch()} />;
  const open = me.data.open;
  const pending = open.filter((o) => !o.checkedIn);

  return (
    <div className={ui.page}>
      <PageHead title="check in" note="the code is on the big screen. it changes every 30 seconds." color="var(--lime)" />
      <AnimatePresence mode="wait">
        {result ? (
          <motion.div key="ok" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
            <Success r={result} onAgain={() => setResult(null)} />
          </motion.div>
        ) : (
          <motion.div key="form" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className={ui.stack}>
            <Card tone={nope ? 'pink' : 'paper'} tilt={-0.6} tape tapeColor="pink" className={s.entry}>
              <AnimatePresence>
                {nope && (
                  <motion.span className={s.nope} initial={{ scale: 2.4, rotate: 16, opacity: 0 }} animate={{ scale: 1, rotate: -9, opacity: 1 }} exit={{ opacity: 0, y: -10 }} transition={{ type: 'spring', stiffness: 600, damping: 14 }}>
                    nope
                  </motion.span>
                )}
              </AnimatePresence>
              {open.length === 0 ? (
                <p className={s.closed}>no check-in is open right now. the screen will say when.</p>
              ) : (
                <p className={s.openFor}>
                  open for <b>{pending[0]?.title ?? open[0]?.title}</b>
                  {open.length > 1 ? ` and ${open.length - 1} more` : ''}
                </p>
              )}
              {coolUntil ? (
                <Cooldown until={coolUntil} onDone={() => setCoolUntil(null)} />
              ) : scan ? (
                <Scanner
                  onCode={(text) => {
                    setScan(false);
                    const p = parseScan(text);
                    if (p) submit.mutate(p);
                    else toast("that QR isn't a check-in code.", { kind: 'bad' });
                  }}
                  onClose={() => setScan(false)}
                />
              ) : (
                <>
                  <CodeBoxes
                    length={CHECKIN_CODE_LENGTH}
                    value={code}
                    onChange={setCode}
                    alphabet={CHECKIN_CODE_ALPHABET}
                    shake={shake}
                    disabled={submit.isPending}
                    onComplete={(v) => submit.mutate({ code: v })}
                  />
                  <div className={s.actions}>
                    <Button tone="lime" icon="check" loading={submit.isPending} disabled={code.length !== CHECKIN_CODE_LENGTH} onClick={() => submit.mutate({ code })}>
                      i'm here
                    </Button>
                    <Button tone="sky" icon="qr" onClick={() => setScan(true)}>
                      {canScanInApp() ? 'scan instead' : 'scan the qr'}
                    </Button>
                  </div>
                </>
              )}
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {open.length > 0 && (
        <p className={s.counter}>
          <Doodle name="users" size={26} fill="var(--lime)" />
          <b>
            <NumberTicker value={open.reduce((n, o) => n + o.count, 0)} />
          </b>{' '}
          checked in
        </p>
      )}

      {me.data.checkins.length > 0 && (
        <Card tone="paper" tilt={0.8}>
          <h3 className={ui.cardTitle}>where you've been</h3>
          <ul className={s.been}>
            {me.data.checkins.map((c) => (
              <li key={c.activityId}>
                <Doodle name="check" size={20} /> {c.title}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** Home card: only when a check-in is open that you have not done. */
export function CheckinCard() {
  const me = useMyAttendance();
  const pending = me.data?.open.filter((o) => !o.checkedIn) ?? [];
  if (pending.length === 0) return null;
  const o = pending[0]!;
  return (
    <Card tone="lime" tilt={1.2} tape="right" tapeColor="pink" className={s.homeCard}>
      <div className={s.homeRow}>
        <Sticker def={STICKER} size={68} tilt={-10} />
        <div className={ui.stack}>
          <p className={ui.kicker}>check-in is open</p>
          <h3 className={s.homeTitle}>{o.title}</h3>
          <p className={ui.hand}>
            <NumberTicker value={o.count} /> in already. +10 and a sticker.
          </p>
        </div>
      </div>
      <LinkButton to="/checkin" tone="ink" icon="ticket" block>
        type the code
      </LinkButton>
    </Card>
  );
}

/** Banner when a check-in opens, wherever you are in the app. */
export function CheckinOverlay() {
  const toast = useToast();
  useLiveEvent('attendance.state', (d) => {
    if (d.open) toast(`check in for ${d.title}: the code is on the big screen.`, { title: 'check-in open', url: '/checkin', icon: 'ticket', kind: 'info', ms: 6000 });
  });
  return null;
}
