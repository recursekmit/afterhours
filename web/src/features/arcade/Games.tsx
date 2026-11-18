/*
  The three arcade games. Each gets a fresh run (token + spec) from the server,
  plays with pointer events at 60 fps, and hands back a RunResult.
  They play on a fixed full-screen field (no scroll, no pinch-zoom, no accidental
  text selection) with a quit button in the corner.
  - Lag Spike: red to green flip, hit flash, ms readout, false-start wobble.
  - Base Rush: a keypad shaped to the target base, streak flames, a draining clock.
  - Echo: 3x3 pads with tones and buzzes; level-up bursts.
  Everything has a visual signal as well as a sound: all of it plays with sound off.
*/
import {
  ARCADE_GAMES,
  type HexbinBase,
  type MemoryStepResponse,
  MemoryStepResponseSchema,
  REACTION_MAX_MS,
  type RunResult,
  RunResultSchema,
  type RunStart,
} from '@afterhours/shared/features/arcade';
import { AnimatePresence, motion, useAnimate, useReducedMotion } from 'motion/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api } from '../../core/api';
import { serverNow, useServerNow } from '../../core/clock';
import { confetti, haptics, sfx } from '../../fun';
import { Button, Doodle, useToast } from '../../kit';
import { ui } from '../common/ui';
import s from './arcade.module.css';

type Done = (r: RunResult) => void;
type Spec<G extends RunStart['game']> = Extract<RunStart, { game: G }>;

function useSubmit(run: RunStart, onDone: Done) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return {
    busy,
    submit: (body: object) => {
      setBusy(true);
      api
        .post(`/api/arcade/runs/${run.runId}/submit`, body, RunResultSchema)
        .then(onDone)
        .catch((e: Error) => {
          setBusy(false);
          toast(e.message, { kind: 'bad', title: 'run bounced' });
        });
    },
  };
}

/** A fixed full-screen play field: locks scrolling and zoom gestures while a game is running. */
function PlayField({ tone, onQuit, children, onPointerDown, label, top }: { tone: string; onQuit: () => void; children: ReactNode; onPointerDown?: () => void; label: string; top?: ReactNode }) {
  useEffect(() => {
    const el = document.documentElement;
    const prev = { overflow: el.style.overflow, overscroll: el.style.overscrollBehavior };
    el.style.overflow = 'hidden';
    el.style.overscrollBehavior = 'none';
    const stop = (e: TouchEvent) => {
      if (e.touches.length > 1) e.preventDefault();
    };
    document.addEventListener('touchmove', stop, { passive: false });
    return () => {
      el.style.overflow = prev.overflow;
      el.style.overscrollBehavior = prev.overscroll;
      document.removeEventListener('touchmove', stop);
    };
  }, []);
  return (
    <div className={`${s.field} ${s[`field-${tone}`]}`} role="application" aria-label={label} onPointerDown={onPointerDown}>
      <div className={s.fieldBar}>
        <button type="button" className={s.quit} onPointerDown={(e) => e.stopPropagation()} onClick={onQuit}>
          <Doodle name="close" size={20} stroke="currentColor" /> quit
        </button>
        {top}
      </div>
      {children}
    </div>
  );
}

// ---- lag spike -----------------------------------------------------------------------

export function LagSpike({ run, onDone, onQuit }: { run: Spec<'reaction'>; onDone: Done; onQuit: () => void }) {
  const [round, setRound] = useState(0);
  const [phase, setPhase] = useState<'wait' | 'red' | 'green' | 'early' | 'shown'>('wait');
  const [last, setLast] = useState<number | null>(null);
  const [hits, setHits] = useState(0);
  const times = useRef<number[]>([]);
  const greenAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const reduce = useReducedMotion();
  const { submit, busy } = useSubmit(run, onDone);

  const arm = (i: number) => {
    setPhase('red');
    timer.current = window.setTimeout(() => {
      greenAt.current = performance.now();
      setPhase('green');
      sfx.tick();
      haptics.tick();
    }, run.spec.delaysMs[i] ?? 1500);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const next = (ms: number) => {
    times.current = [...times.current, ms];
    setLast(ms);
    setPhase('shown');
    if (times.current.length >= run.spec.rounds) {
      submit({ reactions: times.current });
      return;
    }
    window.setTimeout(() => {
      setRound((r) => r + 1);
      arm(times.current.length);
    }, 1000);
  };

  const tap = () => {
    if (busy) return;
    if (phase === 'wait') {
      arm(0);
      return;
    }
    if (phase === 'red') {
      window.clearTimeout(timer.current);
      setPhase('early');
      setHits((h) => h + 1);
      sfx.fail();
      haptics.fail();
      if (!reduce && scope.current) void animate(scope.current, { rotate: [0, -6, 6, -4, 3, 0], x: [0, -18, 16, -10, 6, 0] }, { duration: 0.5 });
      window.setTimeout(() => next(REACTION_MAX_MS), 800);
      return;
    }
    if (phase === 'green') {
      const ms = Math.max(1, Math.round(performance.now() - greenAt.current));
      sfx.pop();
      haptics.success();
      setHits((h) => h + 1);
      next(ms);
    }
  };

  const valid = times.current.filter((t) => t < REACTION_MAX_MS);
  const bestSoFar = valid.length ? Math.min(...valid) : null;
  const isBest = last !== null && last < REACTION_MAX_MS && last === bestSoFar && valid.length > 1;
  return (
    <PlayField
      tone={phase}
      onQuit={onQuit}
      onPointerDown={tap}
      label="lag spike"
      top={
        <p className={s.roundNo}>
          round {Math.min(round + 1, run.spec.rounds)}/{run.spec.rounds}
        </p>
      }
    >
      <div ref={scope} className={s.reactCenter}>
        {phase === 'green' && (
          <motion.svg className={s.burst} viewBox="-50 -50 100 100" aria-hidden="true" initial={reduce ? { opacity: 0 } : { scale: 0.2, rotate: -30 }} animate={{ scale: 1, rotate: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 600, damping: 14 }}>
            <polygon points="0,-48 9,-28 30,-38 26,-14 48,-9 30,6 42,28 18,24 14,46 0,30 -14,46 -18,24 -42,28 -30,6 -48,-9 -26,-14 -30,-38 -9,-28" fill="var(--sun)" stroke="var(--ink)" strokeWidth="2.4" strokeLinejoin="round" />
          </motion.svg>
        )}
        <>
          <motion.button type="button" onClick={(e) => e.detail === 0 && tap()}
            key={phase + (phase === 'shown' ? `-${round}` : '')}
            className={s.reactWord}
            initial={reduce ? { opacity: 0 } : { scale: phase === 'green' ? 0.4 : 0.8, opacity: 0, rotate: phase === 'green' ? -8 : 0 }}
            animate={{ scale: 1, opacity: 1, rotate: phase === 'green' ? 3 : 0 }}
            transition={{ type: 'spring', stiffness: 700, damping: 18 }}
          >
            {phase === 'wait' && 'tap to start'}
            {phase === 'red' && 'wait for green...'}
            {phase === 'green' && 'NOW!'}
            {phase === 'early' && 'too early!'}
            {phase === 'shown' && last !== null && (last >= REACTION_MAX_MS ? 'false start' : <span className={s.msBig}>{last}<small> ms</small></span>)}
          </motion.button>
        </>
        {isBest && <span className={s.bestSoFar}>fastest yet</span>}
        {phase === 'wait' && <p className={s.fieldHint}>five rounds. tap the second it goes green. early taps cost you.</p>}
      </div>
      <AnimatePresence>
        {hits > 0 && phase !== 'red' && (
          <motion.div key={hits} className={`${s.flash} ${phase === 'early' ? s.flashBad : ''}`} initial={{ opacity: 0.85 }} animate={{ opacity: 0 }} transition={{ duration: 0.35 }} aria-hidden="true" />
        )}
      </AnimatePresence>
      <div className={s.times}>
        {Array.from({ length: run.spec.rounds }, (_, i) => {
          const t = times.current[i];
          return (
            <span key={i} className={`${s.timeChip} ${t === undefined ? s.timeEmpty : ''}`}>
              {t === undefined ? '-' : t >= REACTION_MAX_MS ? 'x' : t}
            </span>
          );
        })}
      </div>
    </PlayField>
  );
}

// ---- base rush --------------------------------------------------------------------------

const KEYS: Record<HexbinBase, string[]> = {
  bin: ['0', '1'],
  dec: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  hex: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F'],
};
const RADIX: Record<HexbinBase, number> = { bin: 2, dec: 10, hex: 16 };
const BASE_LABEL: Record<HexbinBase, string> = { bin: 'binary', dec: 'decimal', hex: 'hex' };

/** The value a prompt like "0b1011", "0x2F" or "47" stands for (so the phone can show right/wrong at once; the server still decides the score). */
function promptValue(p: string): number {
  if (p.startsWith('0b')) return parseInt(p.slice(2), 2);
  if (p.startsWith('0x')) return parseInt(p.slice(2), 16);
  return parseInt(p, 10);
}

export function BaseRush({ run, onDone, onQuit }: { run: Spec<'hexbin'>; onDone: Done; onQuit: () => void }) {
  const qs = run.spec.questions;
  const reduce = useReducedMotion();
  const [i, setI] = useState(0);
  const [typed, setTyped] = useState('');
  const answers = useRef<{ a: string; t: number }[]>([]);
  const [streak, setStreak] = useState(0);
  const [best, setBest] = useState(0);
  const [verdict, setVerdict] = useState<'ok' | 'bad' | null>(null);
  const { submit, busy } = useSubmit(run, onDone);
  const sent = useRef(false);
  const now = useServerNow(100);
  const end = run.startedAt + run.durationMs;
  const frac = Math.max(0, Math.min(1, (end - now) / run.durationMs));
  const left = Math.max(0, Math.ceil((end - now) / 1000));
  const finish = () => {
    if (sent.current) return;
    sent.current = true;
    if (answers.current.length === 0) answers.current.push({ a: '', t: Math.max(0, serverNow() - run.startedAt) });
    submit({ answers: answers.current });
  };
  useEffect(() => {
    if (now >= end) finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now >= end]);
  const q = qs[i];
  const enter = () => {
    if (!q || !typed || busy) return;
    answers.current.push({ a: typed, t: Math.max(0, Math.round(serverNow() - run.startedAt)) });
    const ok = parseInt(typed, RADIX[q.to]) === promptValue(q.prompt);
    setVerdict(ok ? 'ok' : 'bad');
    window.setTimeout(() => setVerdict(null), 260);
    if (ok) {
      const n = streak + 1;
      setStreak(n);
      setBest((b) => Math.max(b, n));
      sfx.note(520 + Math.min(n, 10) * 60, 90, 'triangle');
      haptics.tick();
    } else {
      setStreak(0);
      sfx.fail();
      haptics.fail();
    }
    setTyped('');
    if (i + 1 >= qs.length) finish();
    else setI(i + 1);
  };
  if (!q) return null;
  const key = (k: string) => {
    setTyped((t) => (t.length < 12 ? t + k : t));
    sfx.tap();
    haptics.tap();
  };
  const hot = streak >= 3;
  return (
    <PlayField tone={verdict ?? 'idle'} onQuit={onQuit} label="base rush">
      <div className={s.rushTop}>
        <span className={s.clock}>{left}s</span>
        <div className={s.rushDrain} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)} aria-label="time left">
          <div className={`${s.rushDrainFill} ${left <= 8 ? s.rushHot : ''}`} style={{ width: `${frac * 100}%` }} />
        </div>
        <span className={`${s.streak} ${hot ? s.streakHot : ''}`}>
          <AnimatePresence>
            {hot && (
              <motion.span
                key="flame"
                className={s.flame}
                initial={reduce ? { opacity: 0 } : { scale: 0, y: 20 }}
                animate={reduce ? { opacity: 1 } : { scale: Math.min(1.9, 0.9 + streak * 0.1), y: 0, rotate: [-4, 4, -4] }}
                exit={{ scale: 0, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 500, damping: 14, rotate: { repeat: Infinity, duration: 0.5 } }}
              >
                <Doodle name="flame" size={30} fill={streak >= 8 ? 'var(--pink)' : 'var(--tangerine)'} />
              </motion.span>
            )}
          </AnimatePresence>
          x{streak}
        </span>
      </div>
      <motion.div
        key={q.i}
        className={`${s.prompt} ${verdict === 'ok' ? s.promptOk : verdict === 'bad' ? s.promptBad : ''}`}
        initial={reduce ? false : { rotateX: 90, y: -20 }}
        animate={{ rotateX: 0, y: 0, x: verdict === 'bad' && !reduce ? [0, -12, 12, -8, 0] : 0 }}
        transition={{ duration: 0.2 }}
      >
        <span className={s.promptNum}>{q.prompt}</span>
        <span className={s.promptTo}>to {BASE_LABEL[q.to]}</span>
      </motion.div>
      <div className={s.typed}>{typed || ' '}</div>
      <div className={`${s.keypad} ${s[`keys-${q.to}`]}`}>
        {KEYS[q.to].map((k) => (
          <motion.button key={k} type="button" className={s.keyBtn} onPointerDown={() => key(k)} disabled={busy} whileTap={reduce ? undefined : { scale: 0.88, rotate: (k.charCodeAt(0) % 2 ? 2 : -2) }} transition={{ type: 'spring', stiffness: 800, damping: 14 }}>
            {k}
          </motion.button>
        ))}
      </div>
      <div className={s.keyRow}>
        <motion.button type="button" className={`${s.keyBtn} ${s.keyDel}`} onPointerDown={() => setTyped((t) => t.slice(0, -1))} whileTap={{ scale: 0.92 }}>
          del
        </motion.button>
        <motion.button type="button" className={`${s.keyBtn} ${s.keyGo}`} onPointerDown={enter} disabled={!typed || busy} whileTap={{ scale: 0.92 }}>
          go
        </motion.button>
      </div>
      {best >= 5 && <span className={s.bestStreak}>best streak {best}</span>}
    </PlayField>
  );
}

// ---- echo -----------------------------------------------------------------------------------

const PAD_NOTES = [262, 294, 330, 349, 392, 440, 494, 523, 587];

export function Echo({ run, onDone, onQuit }: { run: Spec<'memory'>; onDone: Done; onQuit: () => void }) {
  const toast = useToast();
  const reduce = useReducedMotion();
  const [seq, setSeq] = useState(run.spec.sequence);
  const [level, setLevel] = useState(run.spec.level);
  const [lit, setLit] = useState<number | null>(null);
  const [showing, setShowing] = useState(true);
  const [taps, setTaps] = useState<number[]>([]);
  const [up, setUp] = useState(0);
  const busy = useRef(false);
  const now = useServerNow(250);
  const left = Math.max(0, Math.ceil((run.startedAt + run.durationMs - now) / 1000));

  useEffect(() => {
    setShowing(true);
    let k = 0;
    const timers: number[] = [];
    const step = run.spec.showMs;
    seq.forEach((pad, j) => {
      timers.push(
        window.setTimeout(() => {
          setLit(pad);
          sfx.note(PAD_NOTES[pad] ?? 440, step * 0.7);
          haptics.tick();
        }, 700 + j * step),
      );
      timers.push(window.setTimeout(() => setLit(null), 700 + j * step + step * 0.7));
      k = j;
    });
    timers.push(window.setTimeout(() => setShowing(false), 700 + (k + 1) * step));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [seq, run.spec.showMs]);

  const press = (pad: number) => {
    if (showing || busy.current) return;
    sfx.note(PAD_NOTES[pad] ?? 440, 160);
    haptics.tap();
    setLit(pad);
    window.setTimeout(() => setLit((l) => (l === pad ? null : l)), 150);
    const next = [...taps, pad];
    setTaps(next);
    if (next.length < seq.length) return;
    busy.current = true;
    api
      .post(`/api/arcade/runs/${run.runId}/step`, { taps: next }, MemoryStepResponseSchema)
      .then((r: MemoryStepResponse) => {
        busy.current = false;
        setTaps([]);
        if (r.status === 'over') {
          sfx.fail();
          haptics.fail();
          onDone(r.result);
        } else {
          sfx.success();
          haptics.success();
          if (!reduce) confetti({ x: 0.5, y: 0.55, count: 36, spread: 120, power: 0.9 });
          setUp((n) => n + 1);
          setLevel(r.level);
          setSeq(r.sequence);
        }
      })
      .catch((e: Error) => {
        busy.current = false;
        toast(e.message, { kind: 'bad' });
      });
  };
  return (
    <PlayField
      tone={showing ? 'watch' : 'turn'}
      onQuit={onQuit}
      label="echo"
      top={
        <div className={s.echoTop}>
          <span className={s.roundNo}>level {level}</span>
          <span className={s.clock}>{left}s</span>
        </div>
      }
    >
      <div className={s.echoState}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={showing ? 'w' : 't'} className={showing ? s.watch : s.turn} initial={reduce ? { opacity: 0 } : { scale: 0.5, rotate: -6, opacity: 0 }} animate={{ scale: 1, rotate: showing ? -2 : 2, opacity: 1 }} exit={{ opacity: 0 }} transition={{ type: 'spring', stiffness: 600, damping: 16 }}>
            {showing ? 'watch...' : 'your turn'}
          </motion.span>
        </AnimatePresence>
        <AnimatePresence>
          {up > 0 && (
            <motion.span key={up} className={s.levelUp} initial={reduce ? { opacity: 0 } : { scale: 0.3, y: 20, rotate: -12, opacity: 0 }} animate={{ scale: 1, y: 0, rotate: -6, opacity: 1 }} exit={{ opacity: 0, y: -30 }} transition={{ type: 'spring', stiffness: 500, damping: 12 }}>
              level up!
            </motion.span>
          )}
        </AnimatePresence>
      </div>
      <div className={s.echoDots} aria-label="taps so far">
        {seq.map((_, j) => (
          <span key={j} className={`${s.echoDot} ${j < taps.length ? s.echoDotOn : ''}`} />
        ))}
      </div>
      <div className={s.pads}>
        {Array.from({ length: run.spec.pads }, (_, p) => (
          <motion.button
            key={p}
            type="button"
            aria-label={`pad ${p + 1}`}
            className={`${s.pad} ${s[`pad-${p % 6}`]} ${lit === p ? s.padLit : ''}`}
            onPointerDown={() => press(p)}
            animate={{ scale: lit === p ? 1.08 : 1, rotate: lit === p && !reduce ? (p % 2 ? 2 : -2) : 0 }}
            whileTap={reduce ? undefined : { scale: 0.92 }}
            transition={{ type: 'spring', stiffness: 700, damping: 16 }}
          />
        ))}
      </div>
    </PlayField>
  );
}

export function GameTitle({ game }: { game: RunStart['game'] }) {
  const g = ARCADE_GAMES[game];
  return (
    <div className={ui.stack}>
      <h2 className={s.gameTitle}>{g.title}</h2>
      <p className={ui.hand}>{g.howTo}</p>
    </div>
  );
}

export function StartButton({ onStart, loading }: { onStart: () => void; loading: boolean }) {
  return (
    <Button tone="lime" size="lg" icon="play" block onClick={onStart} loading={loading}>
      insert coin
    </Button>
  );
}
