/*
  /schedule: the whole afternoon as tilted cards on a string. LIVE, DONE and
  "+10 min" stamps; highlights get a bigger wobbling card with a sticker edge.
  What the live `change.kind` says decides the show:
    delayed   the time flips like a departure board, a "+10" marker pops, shifted cards nudge
    reordered the cards shuffle (a wiggle that ripples down the list)
    ended     a DONE stamp slams onto the card
    started   the new card pulses and the one it replaced gets stamped
*/
import type { Activity } from '@afterhours/shared/features/schedule';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useServerNow } from '../../core/clock';
import { fmtClock } from '../../core/time';
import { haptics, sfx } from '../../fun';
import { Card, Doodle, ErrorState, LoadingState } from '../../kit';
import { PageHead, Stamp, ui } from '../common/ui';
import { JumpIn } from './JumpIn';
import s from './schedule.module.css';
import { KIND_LABEL, LINK_LABEL, useLastChange, useSchedule } from './useSchedule';

/** Departure-board time: every character is its own flap, staggered. */
function FlipTime({ ms }: { ms: number }) {
  const reduce = useReducedMotion();
  const [clock = '', ampm = ''] = fmtClock(ms).split(' ');
  return (
    <span className={s.flipWrap} aria-label={`${clock} ${ampm}`}>
      <span className={s.flip} aria-hidden="true">
        <span className={s.flipChars}>
          {clock.split('').map((ch, i) => (
            <span className={s.flapSlot} key={i}>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={ch}
                  className={s.flap}
                  initial={reduce ? { opacity: 0 } : { rotateX: -100, opacity: 0 }}
                  animate={{ rotateX: 0, opacity: 1 }}
                  exit={reduce ? { opacity: 0 } : { rotateX: 100, opacity: 0 }}
                  transition={{ duration: 0.3, delay: reduce ? 0 : i * 0.06 }}
                >
                  {ch}
                </motion.span>
              </AnimatePresence>
            </span>
          ))}
        </span>
        <small className={s.ampm}>{ampm}</small>
      </span>
    </span>
  );
}

interface Fx {
  /** ids that moved */
  nudged: Set<number>;
  /** the one that was delayed, and by how much */
  delayId: number | null;
  minutes: number;
  /** ids that just ended */
  stamped: Set<number>;
  /** ids that just started */
  started: Set<number>;
  shuffle: boolean;
}
const NO_FX: Fx = { nudged: new Set(), delayId: null, minutes: 0, stamped: new Set(), started: new Set(), shuffle: false };

function Row({ a, i, fx, now }: { a: Activity; i: number; fx: Fx; now: number }) {
  const reduce = useReducedMotion();
  const tilt = a.highlight ? (i % 2 ? 1.2 : -1.2) : i % 2 ? 0.8 : -0.7;
  const late = Math.round(a.delayMs / 60_000);
  const over = a.status === 'live' && now > a.endAt;
  const nudged = fx.nudged.has(a.id);
  const stamped = fx.stamped.has(a.id);
  const started = fx.started.has(a.id);
  const animate = reduce
    ? { x: 0 }
    : fx.shuffle
      ? { x: [0, i % 2 ? 18 : -18, 0], rotate: [0, i % 2 ? 2.4 : -2.4, 0] }
      : nudged
        ? { x: [0, 16, -9, 0] }
        : started
          ? { scale: [1, 1.05, 1] }
          : { x: 0, scale: 1 };
  return (
    <motion.li
      layout={!reduce}
      className={`${s.tlItem} ${a.status === 'ended' ? s.tlDone : ''}`}
      animate={animate}
      transition={{ layout: { type: 'spring', stiffness: 300, damping: 26 }, duration: 0.55, delay: fx.shuffle ? i * 0.04 : 0 }}
    >
      <div className={s.tlTime}>
        <FlipTime ms={a.startAt} />
        <span className={s.tlDot} aria-hidden="true" />
        <AnimatePresence>
          {fx.delayId !== null && nudged && (
            <motion.span
              key="late"
              className={s.lateMark}
              initial={reduce ? { opacity: 0 } : { scale: 0, rotate: -30 }}
              animate={{ scale: 1, rotate: -8, opacity: 1 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ type: 'spring', stiffness: 600, damping: 13 }}
            >
              +{fx.minutes}
            </motion.span>
          )}
        </AnimatePresence>
      </div>
      <Card
        tone={a.status === 'live' ? (a.highlight ? 'pink' : 'sun') : 'paper'}
        tilt={tilt}
        className={`${s.tlCard} ${a.highlight ? s.highlight : ''} ${a.highlight && a.status !== 'ended' && !reduce ? s.wobble : ''}`}
      >
        {a.highlight && (
          <span className={s.bigOne} aria-hidden="true">
            big one
          </span>
        )}
        <div className={ui.between}>
          <span className={s.kind}>{KIND_LABEL[a.kind]}</span>
          <span className={ui.row}>
            {a.status === 'live' && <Stamp tone={over ? 'late' : 'live'}>{over ? 'running over' : 'live'}</Stamp>}
            {a.status === 'ended' && <Stamp tone="done">done</Stamp>}
            {a.status === 'upcoming' && late > 0 && <Stamp tone="late">+{late} min</Stamp>}
            {a.status === 'upcoming' && late < 0 && <Stamp tone="sky">{late} min</Stamp>}
          </span>
        </div>
        <h3 className={a.highlight ? s.tlTitleBig : s.tlTitle}>
          {a.highlight && <Doodle name="star" size={26} fill="var(--sun)" />} {a.title}
        </h3>
        {a.blurb && <p className={s.blurb}>{a.blurb}</p>}
        <p className={s.where}>
          <Doodle name="pin" size={16} /> {a.location || 'around'} <span className={s.until}>till {fmtClock(a.endAt)}</span>
        </p>
        {a.link && a.status !== 'ended' && (
          <JumpIn to={a.link} tone={a.status === 'live' ? 'ink' : 'lime'} className={s.jump}>
            {LINK_LABEL[a.link] ?? 'jump in'}
          </JumpIn>
        )}
        <AnimatePresence>
          {stamped && (
            <motion.span
              key="done"
              className={s.slam}
              initial={reduce ? { opacity: 0 } : { scale: 3, rotate: 18, opacity: 0 }}
              animate={{ scale: 1, rotate: -12, opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.3 } }}
              transition={{ type: 'spring', stiffness: 520, damping: 16 }}
            >
              done
            </motion.span>
          )}
        </AnimatePresence>
      </Card>
    </motion.li>
  );
}

export function Timeline() {
  const q = useSchedule();
  const change = useLastChange();
  const now = useServerNow(5000);
  const [fx, setFx] = useState<Fx>(NO_FX);
  useEffect(() => {
    if (!change) return;
    const c = change.change;
    let next: Fx | null = null;
    if (c.kind === 'delayed') {
      next = { ...NO_FX, nudged: new Set([...c.shiftedIds, c.activityId]), delayId: c.activityId, minutes: c.minutes };
      sfx.whoosh();
      haptics.tick();
    } else if (c.kind === 'started') {
      next = { ...NO_FX, nudged: new Set(c.shiftedIds), started: new Set([c.activityId]), stamped: new Set(c.endedIds) };
      sfx.pop();
    } else if (c.kind === 'ended') {
      next = { ...NO_FX, stamped: new Set([c.activityId]) };
      sfx.pop();
      haptics.success();
    } else if (c.kind === 'reordered') {
      next = { ...NO_FX, shuffle: true };
      sfx.rattle();
      haptics.tick();
    }
    if (!next) return;
    setFx(next);
    const t = window.setTimeout(() => setFx(NO_FX), 2600);
    return () => window.clearTimeout(t);
  }, [change]);

  if (q.isPending) return <LoadingState label="fetching the plan..." />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const list = q.data.activities;
  return (
    <div className={ui.page}>
      <PageHead title="the afternoon" note="times move when the organisers move them. this page keeps up." color="var(--sky)" />
      <ol className={s.timeline}>
        {list.map((a, i) => (
          <Row key={a.id} a={a} i={i} fx={fx} now={now} />
        ))}
      </ol>
    </div>
  );
}
