/*
  Projector: the last signal. Announced: a countdown and the chart. Live: a great lamp flashes and beeps the
  word, slowly, looped, with the whole chart beside it and the first catches dropping in. Closed: the
  proclamation of the winning guild, with the race and (after the reveal) the word.
*/
import { GUILD_INFO } from '@afterhours/shared/features/cipher';
import { MORSE_CHART } from '@afterhours/shared/features/morse';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Avatar, Countdown, WaxSeal } from '../../kit';
import { playSignal } from '../morse/signal';
import { useCipherScreen } from './api';
import s from './cipher.module.css';

const MORSE_CHART_LETTERS = MORSE_CHART.filter((c) => /[A-Z]/.test(c.char));

export default function SignalScene() {
  const q = useCipherScreen();
  const o = q.data;
  const reduce = useReducedMotion();
  const [light, setLight] = useState(false);
  const played = useRef<number | null>(null);
  const pb = useRef<{ stop: () => void } | null>(null);
  const sig = o?.signal;
  const play = o?.signalPlay ?? null;
  useEffect(() => {
    if (!sig || sig.status !== 'live' || !play || played.current === sig.id) return;
    played.current = sig.id;
    pb.current?.stop();
    pb.current = playSignal(play.segments, play.leadInMs, setLight, () => setLight(false));
  }, [sig, play]);
  useEffect(() => () => pb.current?.stop(), []);
  if (!o || !sig) return null;

  if (sig.status === 'closed') {
    const winner = sig.winner ? GUILD_INFO[sig.winner] : null;
    const max = Math.max(1, ...o.guilds.map((g) => g.average));
    return (
      <div className={s.proclaim} data-guild={sig.winner ?? 'armillary'} data-testid="signal-proclamation">
        <motion.div initial={reduce ? false : { scale: 2, rotate: -14, opacity: 0 }} animate={{ scale: 1, rotate: -4, opacity: 1 }} transition={{ type: 'spring', stiffness: 160, damping: 14 }}>
          <WaxSeal glyph="crown" size={160} press={!reduce} />
        </motion.div>
        <p className={s.proclaimKicker}>hear ye: the cipher is decided</p>
        <h2 className={s.proclaimTitle}>{winner ? `${winner.title} wins` : 'the signal is sent'}</h2>
        {sig.word && (
          <p className={s.proclaimWord}>
            the last signal was <b>{sig.word}</b>, {sig.correct} caught it
          </p>
        )}
        <div className={s.proclaimRace}>
          {[...o.guilds]
            .sort((a, b) => a.rank - b.rank)
            .map((g) => (
              <div key={g.guild} className={s.proclaimRow} data-guild={g.guild}>
                <span className={s.raceSwatch} />
                <span className={s.proclaimName}>{GUILD_INFO[g.guild].short}</span>
                <div className={s.raceTrack}>
                  <motion.div className={s.raceBar} initial={{ width: 0 }} animate={{ width: `${Math.max(2, (g.average / max) * 100)}%` }} transition={{ delay: 0.4 + g.rank * 0.2 }} />
                </div>
                <span className={s.raceNum}>{g.average.toFixed(1)}</span>
              </div>
            ))}
        </div>
      </div>
    );
  }

  return (
    <div className={s.signalStage} data-testid="signal-scene">
      <div className={s.signalLeft}>
        <h2 className={s.sceneTitle}>the last signal</h2>
        {sig.status === 'warned' && sig.fireAt !== null ? (
          <>
            <p className={s.sceneNote}>goes out in</p>
            <Countdown to={sig.fireAt} className={s.signalCount} />
            <p className={s.sceneNote}>finished the pact? get your phone out. one word, three times, slowly.</p>
          </>
        ) : (
          <>
            <div className={`${s.lamp} ${light ? s.lampOn : ''}`} data-testid="signal-lamp" aria-label="the signal lamp" />
            <p className={s.sceneNote}>
              {sig.letters} letters, looped three times. type it on your phone. {sig.correct} caught it.
            </p>
            <div className={s.firstRow}>
              {o.firstAnswers.map((a) => (
                <span key={a.rank} className={s.firstOne} data-guild={a.guild}>
                  <Avatar config={a.avatar} size={56} />
                  <span>
                    #{a.rank} {a.nickname}
                  </span>
                </span>
              ))}
            </div>
          </>
        )}
      </div>
      <div className={s.bigChart} aria-label="morse chart">
        {MORSE_CHART_LETTERS.map(({ char, code }) => (
          <span key={char} className={s.bigChartCell}>
            <b>{char}</b>
            <i>{code.replace(/\./g, '•').replace(/-/g, '—')}</i>
          </span>
        ))}
      </div>
    </div>
  );
}
