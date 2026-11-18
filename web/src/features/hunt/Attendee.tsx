/*
  Trails on the phone (the treasure hunt is trail 1, a Morse trail and slip trails are others).
  - /hunt: the open trails, with your progress on each.
  - /hunt/t/:trailId: the passport (stamp slots that slam down), the current clue on a torn
    paper card with "n others on this stop", scratch-off hints with their cost,
    scan (in-app or camera app) or type the sticker code / the answer.
    Wrong answer: shake + a ring until lockedUntil. Finish: rank, time, bonuses.
  - /hunt/s/:token: what a sticker QR opens. Survives sign-in (the URL stays put).
  Stop variants: riddle (type), scan (sticker only), morse (decode the object; chart helper and
  an optional "play it"), slip (scan a kit slip or type its bottom strip). See Stops.tsx.
*/
import { type HuntAttemptResult, HuntAttemptResultSchema, HuntHintResultSchema, type HuntMe, HuntMeSchema, type HuntSolvedStop, TREASURE_TRAIL_ID, type TrailSummary, extractHuntCode } from '@afterhours/shared/features/hunt';
import { useMutation } from '@tanstack/react-query';
import { AnimatePresence, motion, useAnimate, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../../core/api';
import { useServerNow } from '../../core/clock';
import { fmtElapsed } from '../../core/time';
import { celebrate, haptics, sfx } from '../../fun';
import { Button, Card, Doodle, ErrorState, LinkButton, LoadingState, NumberTicker, ProgressRing, Sticker, TextField, useToast } from '../../kit';
import { Scanner } from '../common/Scanner';
import { PageHead, Stamp, ui } from '../common/ui';
import s from './hunt.module.css';
import { MorseHelper, SlipStop } from './Stops';
import { useHunt, useHuntBoard, useSetHunt, useTrails } from './useHunt';

function Passport({ me }: { me: HuntMe }) {
  const slots = Array.from({ length: me.total }, (_, i) => me.solved[i] ?? null);
  return (
    <Card tone="paper" tilt={0.6} className={s.passport}>
      <div className={ui.between}>
        <h3 className={ui.cardTitle}>passport</h3>
        <span className={s.count}>
          <NumberTicker value={me.solved.length} />/{me.total}
        </span>
      </div>
      <div className={s.slots}>
        {slots.map((st, i) => (
          <div key={i} className={s.slot}>
            {st ? <Sticker def={{ shape: 'circle', color: st.color, glyph: st.glyph }} size={62} tilt={((i * 29) % 21) - 10} slap /> : <span className={s.slotNum}>{i + 1}</span>}
          </div>
        ))}
      </div>
    </Card>
  );
}

function LockRing({ until }: { until: number }) {
  const now = useServerNow(250);
  const start = useRef(now);
  const left = until - now;
  if (left <= 0) return null;
  return (
    <div className={s.lock}>
      <ProgressRing value={1 - left / Math.max(1, until - start.current)} size={64} thickness={9} tone="pink" label="cooldown">
        <span className={s.lockNum}>{Math.ceil(left / 1000)}</span>
      </ProgressRing>
      <span className={ui.hand}>breathe. try again in a sec.</span>
    </div>
  );
}

function SolvedCard({ stop, onClose }: { stop: HuntSolvedStop; onClose?: () => void }) {
  useEffect(() => {
    celebrate({ y: 0.35 });
  }, []);
  return (
    <Card tone="lime" tilt={-1.5} tape className={s.solved}>
      <Sticker def={{ shape: 'circle', color: stop.color, glyph: stop.glyph }} size={110} tilt={-10} slap />
      <h2 className={s.solvedTitle}>stamped: {stop.title}</h2>
      {stop.reveal && <p className={s.reveal}>{stop.reveal}</p>}
      <p className={ui.hand}>
        +{stop.points} points. {stop.solvedBy === 1 ? 'you found it first!' : `${stop.solvedBy} people have found it.`}
      </p>
      {onClose && (
        <Button tone="ink" icon="arrow" onClick={onClose}>
          next clue
        </Button>
      )}
    </Card>
  );
}

function Finish({ me }: { me: HuntMe }) {
  const f = me.finish!;
  useEffect(() => {
    celebrate({ y: 0.3 });
    sfx.fanfare();
  }, []);
  return (
    <Card tone="sun" tilt={-1} tape className={s.finish}>
      <p className={ui.kicker}>you finished the hunt</p>
      <div className={s.rank}>#{f.rank}</div>
      <p className={s.time}>{fmtElapsed(f.elapsedMs)}</p>
      <ul className={s.bonus}>
        <li>
          stamps <b>{me.pointsEarned - f.rankBonus - f.speedBonus}</b>
        </li>
        <li>
          finish-order bonus <b>+{f.rankBonus}</b>
        </li>
        <li>
          speed bonus <b>+{f.speedBonus}</b>
        </li>
      </ul>
      {f.usedNoHints && <Stamp tone="ink">no hints, legend</Stamp>}
      <p className={ui.hand}>{f.finishers} finished so far.</p>
    </Card>
  );
}

function StartButton({ trailId, onStarted }: { trailId: number; onStarted: (me: HuntMe) => void }) {
  const [n, setN] = useState<number | null>(null);
  const toast = useToast();
  const start = useMutation({
    mutationFn: () => api.post('/api/hunt/start', { trailId }, HuntMeSchema),
    onSuccess: onStarted,
    onError: (e) => {
      setN(null);
      toast(e.message, { kind: 'bad' });
    },
  });
  useEffect(() => {
    if (n === null) return;
    if (n === 0) {
      start.mutate();
      return;
    }
    sfx.tick();
    haptics.tick();
    const t = window.setTimeout(() => setN(n - 1), 700);
    return () => window.clearTimeout(t);
  }, [n, start]);
  return n !== null ? (
    <AnimatePresence mode="popLayout">
      <motion.div key={n} className={s.three} initial={{ scale: 2.2, rotate: -14, opacity: 0 }} animate={{ scale: 1, rotate: 0, opacity: 1 }} exit={{ opacity: 0, scale: 0.5 }}>
        {n === 0 ? 'go!' : n}
      </motion.div>
    </AnimatePresence>
  ) : (
    <Button tone="tangerine" size="lg" icon="flag" block onClick={() => setN(3)}>
      {trailId === TREASURE_TRAIL_ID ? 'start my hunt' : 'start this trail'}
    </Button>
  );
}

function Clue({ me, onResult }: { me: HuntMe; onResult: (r: HuntAttemptResult) => void }) {
  const cur = me.current!;
  const setHunt = useSetHunt();
  const toast = useToast();
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const reduce = useReducedMotion();
  const [answer, setAnswer] = useState('');
  const [code, setCode] = useState('');
  const [scan, setScan] = useState(false);
  const now = useServerNow(1000);
  const locked = cur.lockedUntil > now;

  const handle = (r: HuntAttemptResult) => {
    setHunt(r.me);
    if (r.result === 'unlocked') {
      sfx.success();
      haptics.success();
      toast(r.message, { kind: 'good', title: 'found it' });
    } else if (r.result === 'wrong' || r.result === 'locked') {
      sfx.fail();
      haptics.fail();
      if (!reduce && scope.current) void animate(scope.current, { x: [0, -16, 14, -9, 6, 0] }, { duration: 0.45 });
      toast(r.message, { kind: 'bad', title: 'nope' });
    } else if (r.result === 'not_yours') {
      if (!reduce && scope.current) void animate(scope.current, { rotate: [0, -3, 3, -1, 0] }, { duration: 0.6 });
      toast(r.message, { kind: 'info', title: 'not this one' });
    } else if (r.result === 'already') toast(r.message, { kind: 'info' });
    else {
      sfx.success();
      haptics.celebrate();
    }
    onResult(r);
  };
  const attempt = useMutation({
    mutationFn: (b: { kind: 'scan'; code: string } | { kind: 'answer'; answer: string }) =>
      b.kind === 'scan' ? api.post('/api/hunt/scan', { code: b.code, trailId: me.trailId }, HuntAttemptResultSchema) : api.post('/api/hunt/answer', { stopId: cur.stopId, answer: b.answer }, HuntAttemptResultSchema),
    onSuccess: (r) => {
      setAnswer('');
      setCode('');
      handle(r);
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  const hint = useMutation({
    mutationFn: (n: number) => api.post('/api/hunt/hint', { stopId: cur.stopId, n }, HuntHintResultSchema),
    onSuccess: (r) => {
      setHunt(r.me);
      sfx.whoosh();
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });

  return (
    <div ref={scope} className={ui.stack}>
      <div className={s.clueCard}>
        <div className={ui.between}>
          <span className={s.clueNum}>
            {me.orderMode === 'graph' ? `stop ${cur.index + 1}` : `clue ${cur.index}/${cur.total}`} {cur.isFinal && <Stamp tone="late">finale</Stamp>}
          </span>
          <span className={s.worth}>
            worth <NumberTicker value={cur.worth} />
          </span>
        </div>
        <p className={s.clueText}>{cur.clue}</p>
        {cur.clueImage && <img className={s.clueImg} src={cur.clueImage} alt="clue" />}
        {cur.challenge === 'morse' && <Stamp tone="sky">decode the morse</Stamp>}
        {cur.needsScan && <p className={s.needsScan}>find the object and scan its QR first: that opens the answer box.</p>}
        {cur.hereNow > 0 && (
          <p className={s.here}>
            <Doodle name="users" size={18} /> {cur.hereNow} {cur.hereNow === 1 ? 'other person is' : 'others are'} on this stop
          </p>
        )}
      </div>

      {cur.hints.map((h, i) => (
        <motion.p key={i} className={s.hint} initial={{ rotateX: 90 }} animate={{ rotateX: 0 }}>
          <b>hint {i + 1}:</b> {h}
        </motion.p>
      ))}
      {cur.hintsLeft > 0 && cur.nextHintCost !== null && (
        <button type="button" className={s.scratch} onClick={() => hint.mutate(cur.hints.length + 1)} disabled={hint.isPending}>
          scratch for hint {cur.hints.length + 1} <span className={s.cost}>-{cur.nextHintCost} pts</span>
        </button>
      )}

      {cur.challenge === 'slip' ? (
        <SlipStop me={me} cur={cur} />
      ) : (
        <>
      {cur.challenge === 'morse' && <MorseHelper cur={cur} />}
      {scan ? (
        <Scanner
          onCode={(text) => {
            setScan(false);
            attempt.mutate({ kind: 'scan', code: extractHuntCode(text) });
          }}
          onClose={() => setScan(false)}
        />
      ) : (
        <Button tone="sky" icon="qr" block onClick={() => setScan(true)}>
          found the sticker? scan it
        </Button>
      )}
      <form
        className={s.typeRow}
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) attempt.mutate({ kind: 'scan', code: extractHuntCode(code.replace(/\s/g, '')) });
        }}
      >
        <TextField label={cur.challenge === 'scan' || cur.needsScan ? 'or type the code under the qr' : 'found the sticker? type its code'} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCD-EFGH" autoCapitalize="characters" />
        <Button type="submit" tone="paper" disabled={!code.trim()} loading={attempt.isPending}>
          go
        </Button>
      </form>
      {cur.canType && (
        <form
          className={s.typeRow}
          onSubmit={(e) => {
            e.preventDefault();
            if (answer.trim()) attempt.mutate({ kind: 'answer', answer });
          }}
        >
          <TextField label={cur.challenge === 'morse' ? 'what does the morse say?' : 'know the answer? type it'} value={answer} onChange={(e) => setAnswer(e.target.value)} disabled={locked} />
          <Button type="submit" tone="lime" disabled={!answer.trim() || locked} loading={attempt.isPending}>
            try
          </Button>
        </form>
      )}
      {locked && <LockRing until={cur.lockedUntil} />}
        </>
      )}
    </div>
  );
}

function Finishers({ trailId }: { trailId: number }) {
  const b = useHuntBoard(trailId);
  const list = b.data?.finishers ?? [];
  if (list.length === 0) return null;
  return (
    <div className={s.finishers}>
      <span className={ui.kicker}>finished:</span>
      {list.slice(0, 8).map((f) => (
        <span key={f.attendeeId} className={s.finChip}>
          #{f.rank} {f.nickname}
        </span>
      ))}
    </div>
  );
}

/** /hunt/t/:trailId (and the old /hunt view of trail 1, via TrailsPage when only it is open). */
export function TrailPage() {
  const { trailId = String(TREASURE_TRAIL_ID) } = useParams();
  return <HuntPage trailId={Number(trailId) || TREASURE_TRAIL_ID} />;
}

export function HuntPage({ trailId = TREASURE_TRAIL_ID }: { trailId?: number }) {
  const q = useHunt(trailId);
  const setHunt = useSetHunt();
  const [just, setJust] = useState<HuntSolvedStop | null>(null);
  if (q.isPending) return <LoadingState label="unfolding the map..." />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const me = q.data;
  return (
    <div className={ui.page}>
      <Link to="/hunt" className={s.back}>
        <Doodle name="arrow" size={20} style={{ transform: 'rotate(180deg)' }} /> all trails
      </Link>
      <PageHead
        title={me.title || 'the hunt'}
        note={
          me.orderMode === 'shuffled'
            ? 'your clue order is yours alone. the last stop is the same for everyone.'
            : me.orderMode === 'graph'
              ? 'what you scan decides where you go next. every path ends at a finale.'
              : 'everyone walks the same stops in the same order.'
        }
        color={me.kind === 'morse' ? 'var(--sky)' : 'var(--tangerine)'}
      />
      {me.status !== 'open' && !me.finish ? (
        <Card tone="paper" tilt={-1}>
          <p className={s.closed}>{me.status === 'draft' ? 'the hunt opens later. the organisers will shout.' : 'the hunt is closed. thanks for playing!'}</p>
        </Card>
      ) : just ? (
        <SolvedCard stop={just} onClose={me.finish ? undefined : () => setJust(null)} />
      ) : me.finish ? (
        <Finish me={me} />
      ) : !me.started ? (
        <Card tone="sun" tilt={-1} tape className={s.startCard}>
          <p className={s.startText}>
            {me.total} stops. scan the qr sticker at each one, or solve the clue. hints cost points. first finishers get bonuses.
          </p>
          <StartButton trailId={trailId} onStarted={setHunt} />
        </Card>
      ) : me.current ? (
        <Clue me={me} onResult={(r) => r.result === 'solved' && setJust(r.stop)} />
      ) : null}
      <Passport me={me} />
      <p className={s.crowd}>
        <b>{me.crowd.hunting}</b> on this trail, <b>{me.crowd.finished}</b> finished
      </p>
      <Finishers trailId={trailId} />
    </div>
  );
}

/** /hunt/s/:token: a sticker QR. Try it as a scan, then show what happened. */
export function HuntScanLanding() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const setHunt = useSetHunt();
  const [r, setR] = useState<HuntAttemptResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const tried = useRef(false);
  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    api
      .post('/api/hunt/scan', { code: token }, HuntAttemptResultSchema)
      .then((res) => {
        setHunt(res.me);
        setR(res);
        if (res.result === 'solved') haptics.celebrate();
      })
      .catch((e: Error) => setErr(e.message));
  }, [token, setHunt]);
  if (err)
    return (
      <div className={ui.page}>
        <ErrorState error={err} title="that sticker did not stick" />
        <LinkButton to="/hunt" tone="ink">
          to my passport
        </LinkButton>
      </div>
    );
  if (!r) return <LoadingState label="reading the sticker..." />;
  return (
    <div className={ui.page}>
      {r.result === 'solved' ? (
        <SolvedCard stop={r.stop} onClose={() => navigate(`/hunt/t/${r.me.trailId}`, { replace: true })} />
      ) : (
        <motion.div animate={{ rotate: [0, -3, 3, -1, 0] }} transition={{ duration: 0.6 }}>
          <Card tone={r.result === 'already' ? 'sky' : 'pink'} tilt={-1}>
            <h2 className={ui.cardTitle}>{r.result === 'already' ? 'already stamped' : r.result === 'not_yours' ? 'not your stop (yet)' : r.result === 'unlocked' ? 'found it' : 'hmm'}</h2>
            <p className={s.reveal}>{r.message}</p>
          </Card>
        </motion.div>
      )}
      <LinkButton to={`/hunt/t/${r.me.trailId}`} tone="ink" icon="map" replace>
        to my passport
      </LinkButton>
    </div>
  );
}

const KIND_TONE: Record<TrailSummary['kind'], 'tangerine' | 'sky' | 'grape'> = { hunt: 'tangerine', morse: 'sky', other: 'grape' };

function TrailCard({ t, i }: { t: TrailSummary; i: number }) {
  return (
    <Link to={`/hunt/t/${t.id}`} className={s.trailLink}>
      <Card tone={KIND_TONE[t.kind]} tilt={i % 2 ? 1 : -1} press className={s.trailCard}>
        <div className={ui.between}>
          <span className={s.trailKind}>{t.kind === 'hunt' ? 'treasure hunt' : t.kind === 'morse' ? 'morse trail' : 'trail'}</span>
          {t.status === 'closed' ? <Stamp tone="done">closed</Stamp> : t.finishedRank ? <Stamp tone="ink">#{t.finishedRank}</Stamp> : t.started ? <Stamp tone="live">on it</Stamp> : null}
        </div>
        <h3 className={s.trailTitle}>{t.title}</h3>
        <div className={ui.between}>
          <span className={s.trailMeta}>
            {t.solved}/{t.total} stamps
          </span>
          <span className={s.trailMeta}>
            {t.hunting} on it, {t.finished} done
          </span>
        </div>
      </Card>
    </Link>
  );
}

/** /hunt: every open trail. */
export function TrailsPage() {
  const q = useTrails();
  if (q.isPending) return <LoadingState label="unfolding the maps..." />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const trails = q.data.trails;
  return (
    <div className={ui.page}>
      <PageHead title="trails" note="treasure hunts and morse trails. scan, decode, turn your slips. each trail pays its own points." color="var(--tangerine)" />
      {trails.length === 0 ? (
        <Card tone="paper" tilt={-1}>
          <p className={s.closed}>no trail is open yet. the organisers will shout.</p>
        </Card>
      ) : (
        trails.map((t, i) => <TrailCard key={t.id} t={t} i={i} />)
      )}
    </div>
  );
}

export function HuntHomeCard() {
  const q = useTrails();
  const open = (q.data?.trails ?? []).filter((t) => t.status === 'open');
  if (open.length === 0) return null;
  const mine = open.find((t) => t.started && !t.finishedRank) ?? open[0]!;
  return (
    <Card tone="tangerine" tilt={-0.8} tape="right" tapeColor="sun" className={s.homeCard}>
      <div className={ui.between}>
        <span className={ui.kicker}>{open.length === 1 ? 'a trail is open' : `${open.length} trails are open`}</span>
        <span className={s.count}>
          {mine.solved}/{mine.total}
        </span>
      </div>
      <h3 className={s.homeTitle}>{mine.title}</h3>
      <p className={ui.hand}>
        {mine.hunting} on it right now, {mine.finished} done
      </p>
      <LinkButton to={open.length === 1 ? `/hunt/t/${mine.id}` : '/hunt'} tone="ink" icon="map" size="sm">
        {mine.started ? 'my passport' : 'pick a trail'}
      </LinkButton>
    </Card>
  );
}
