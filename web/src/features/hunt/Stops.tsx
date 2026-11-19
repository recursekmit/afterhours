/*
  Stop variants on the trail screen.
  - MorseHelper: a tappable Morse chart (tap a letter to hear/see/feel it) and, when the
    organisers turned on the online fallback, a "play it" button that plays the hidden word as
    beeps + flash + buzz (timings only; the word itself never reaches the phone).
  - SlipStop: scan a kit slip (the shared camera reader from lib/slips, lazy-loaded; it falls back
    to a Morse keypad without a camera) or type the decoded word. Outcomes: next/branch stamp and move on, clue shows text, bonus pays once, decoy and
    unknown say "try turning it".
*/
import { type HuntCurrentStop, type HuntMe, type HuntSlipResult, HuntSlipResultSchema } from '@afterhours/shared/features/hunt';
import { MORSE_CHART, patternToUnits } from '@afterhours/shared/features/morse';
import { useMutation } from '@tanstack/react-query';
import { AnimatePresence, motion, useAnimate, useReducedMotion } from 'motion/react';
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { api } from '../../core/api';
import { celebrate, haptics, sfx } from '../../fun';
import { Button, Card, Doodle, TextField, useToast } from '../../kit';
import { playSignal } from '../morse/signal';
import s from './hunt.module.css';
import { useSetHunt } from './useHunt';

// The camera reader loads only when someone reaches a slip stop.
const SlipReader = lazy(() => import('./slipScanner'));

export function MorseHelper({ cur }: { cur: HuntCurrentStop }) {
  const [light, setLight] = useState(false);
  const [open, setOpen] = useState(false);
  const pb = useRef<{ stop: () => void } | null>(null);
  useEffect(() => () => pb.current?.stop(), []);
  const playChar = (code: string) => {
    pb.current?.stop();
    pb.current = playSignal(
      patternToUnits(code).map((u) => u * 120),
      0,
      setLight,
      () => undefined,
    );
  };
  const playWord = () => {
    if (!cur.signal) return;
    pb.current?.stop();
    pb.current = playSignal(cur.signal.segments, cur.signal.leadInMs, setLight, () => undefined);
  };
  return (
    <div className={s.morseHelp}>
      {cur.signal && (
        <div className={s.playRow}>
          <div className={`${s.lamp} ${light ? s.lampOn : ''}`} aria-hidden="true" />
          <Button tone="sky" icon="play" onClick={playWord}>
            play it
          </Button>
          <span className={s.handSmall}>no object for this one: listen, watch the lamp, or feel the buzz.</span>
        </div>
      )}
      <button type="button" className={s.chartToggle} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Doodle name="morse" size={20} /> {open ? 'hide the morse chart' : 'show the morse chart'}
      </button>
      {open && !cur.signal && <div className={`${s.lamp} ${s.lampSmall} ${light ? s.lampOn : ''}`} aria-hidden="true" />}
      {open && (
        <div className={s.chart}>
          {MORSE_CHART.map(({ char, code }) => (
            <button key={char} type="button" className={s.chartBtn} onClick={() => playChar(code)}>
              <b>{char}</b>
              <span>{code.replace(/\./g, '•').replace(/-/g, '—')}</span>
            </button>
          ))}
        </div>
      )}
      {cur.letters !== null && <p className={s.handSmall}>the word has {cur.letters} letters.</p>}
    </div>
  );
}

export function SlipStop({ me, cur }: { me: HuntMe; cur: HuntCurrentStop }) {
  const setHunt = useSetHunt();
  const toast = useToast();
  const reduce = useReducedMotion();
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const [word, setWord] = useState('');
  const [last, setLast] = useState<HuntSlipResult | null>(null);
  const send = useMutation({
    mutationFn: (read: { text?: string; morse?: string }) => api.post('/api/hunt/slip', { stopId: cur.stopId, ...read }, HuntSlipResultSchema),
    onSuccess: (r) => {
      setLast(r);
      setWord('');
      if (r.outcome === 'next' || r.outcome === 'branch') {
        sfx.success();
        haptics.celebrate();
        celebrate({ y: 0.4 });
        // this stop is about to be replaced by the next one: say what happened in a toast that outlives it
        toast(r.message, { kind: 'good', title: r.outcome === 'next' ? 'onwards' : 'a different path', icon: 'arrow', ms: 5000 });
      } else if (r.outcome === 'bonus') {
        if (r.points > 0) celebrate({ y: 0.4 });
        sfx.pop();
      } else if (r.outcome === 'clue') {
        sfx.whoosh();
      } else {
        sfx.fail();
        haptics.fail();
        if (!reduce && scope.current) void animate(scope.current, { rotate: [0, -6, 6, -3, 0] }, { duration: 0.5 });
      }
      setHunt(r.me);
    },
    onError: (e) => toast(e.message, { kind: 'bad' }),
  });
  return (
    <div ref={scope} className={s.slipBox}>
      {cur.slip && (
        <p className={s.slipWhich}>
          <span className={s.slipNo}>slip {cur.slip.slipNo}</span> {cur.slip.label}
        </p>
      )}
      <Suspense fallback={<div className={s.slipCam}>warming up the slip reader...</div>}>
        <SlipReader onRead={(read) => send.mutate(read)} />
      </Suspense>
      <form
        className={s.typeRow}
        onSubmit={(e) => {
          e.preventDefault();
          if (word.trim()) send.mutate({ text: word });
        }}
      >
        <TextField label="or type the word on the bottom edge" value={word} onChange={(e) => setWord(e.target.value.toUpperCase())} autoCapitalize="characters" placeholder="WORD" />
        <Button type="submit" tone="lime" disabled={!word.trim()} loading={send.isPending}>
          read it
        </Button>
      </form>
      <AnimatePresence mode="wait">
        {last && (
          <motion.div key={`${last.outcome}-${last.message}`} initial={reduce ? { opacity: 0 } : { y: 20, opacity: 0, rotate: -2 }} animate={{ y: 0, opacity: 1, rotate: -1 }} exit={{ opacity: 0 }}>
            <Card tone={last.outcome === 'next' || last.outcome === 'branch' ? 'lime' : last.outcome === 'bonus' ? 'sun' : last.outcome === 'clue' ? 'sky' : 'paper'} tilt={-1} className={s.slipResult}>
              <b className={s.slipOutcome}>
                {last.outcome === 'next' ? 'onwards' : last.outcome === 'branch' ? 'a different path' : last.outcome === 'clue' ? 'a clue' : last.outcome === 'bonus' ? (last.points ? `+${last.points} bonus` : 'already found') : last.outcome === 'decoy' ? 'decoy!' : 'nothing there'}
              </b>
              <span>{last.message}</span>
              {last.clue && <p className={s.slipClue}>{last.clue}</p>}
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
      <MorseHelper cur={cur} />
      <p className={s.handSmall}>turning the slip changes which edge you read. {me.kind === 'morse' ? 'some edges are decoys. no penalty for trying.' : 'every edge says something.'}</p>
    </div>
  );
}
