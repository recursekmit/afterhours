/*
  Projector: the top 10 race. During the reveal it flips rows from 10 down to 1
  on 'leaderboard.reveal', with a drum roll before #1, then a crown and confetti.
  The closing moment of the event, so everything is huge: readable from the back of a hall.
*/
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useServerNow } from '../../core/clock';
import { useLiveEvent } from '../../core/live';
import { confetti, sfx } from '../../fun';
import { Avatar, Doodle, NumberTicker } from '../../kit';
import s from './leaderboard.module.css';
import { useBoard } from './useBoard';

export default function LeaderboardScene() {
  const q = useBoard(10);
  const reduce = useReducedMotion();
  const now = useServerNow(250);
  const b = q.data;
  const reveal = b?.freeze.reveal;
  const first = b?.rows.find((r) => r.rank === 1 && !r.hidden);
  const celebrated = useRef(false);
  const [flash, setFlash] = useState<number | null>(null);
  const [moves, setMoves] = useState<Map<number, number>>(new Map());

  // Each uncovered place pops, flashes and throws a little confetti; #1 is the big one (below).
  useLiveEvent('leaderboard.reveal', (step) => {
    setFlash(step.rank);
    sfx.pop();
    if (!reduce && step.rank > 1) confetti({ x: 0.7, y: 0.2 + step.rank * 0.05, count: 18, spread: 60, power: 0.7 });
    window.setTimeout(() => setFlash((f) => (f === step.rank ? null : f)), 1400);
  });
  // Rows that climbed or slid on a normal reshuffle.
  useLiveEvent('leaderboard.moves', (m) => {
    const d = new Map<number, number>();
    for (const mv of m.moves) if (mv.from !== null && mv.from !== mv.to) d.set(mv.attendeeId, mv.from - mv.to);
    setMoves(d);
    window.setTimeout(() => setMoves(new Map()), 3500);
  });

  const firstShown = Boolean(first);
  useEffect(() => {
    if (reveal?.startedAt && firstShown && !celebrated.current) {
      celebrated.current = true;
      sfx.fanfare();
      if (!reduce) {
        confetti({ x: 0.15, y: 0.7, count: 180, spread: 90, power: 1.6 });
        confetti({ x: 0.85, y: 0.7, count: 180, spread: 90, power: 1.6 });
        window.setTimeout(() => confetti({ x: 0.5, y: 0.5, count: 160, spread: 140, power: 1.5 }), 700);
        window.setTimeout(() => confetti({ x: 0.3, y: 0.8, count: 100, spread: 100, power: 1.8 }), 1500);
      } else confetti({ count: 80 });
    }
    if (!firstShown) celebrated.current = false;
  }, [reveal?.startedAt, firstShown, reduce]);

  if (!b) return null;
  const nextAt = reveal?.schedule?.[reveal.revealed] ?? null;
  const revealing = Boolean(reveal?.startedAt && !reveal.done);
  const drumRoll = Boolean(revealing && reveal && reveal.revealed === reveal.topN - 1 && nextAt && nextAt > now);
  const champion = Boolean(reveal?.startedAt && first);
  const left = reveal ? reveal.topN - reveal.revealed : 0;

  return (
    <div className={s.scene}>
      <div className={s.sceneSide}>
        <AnimatePresence mode="wait">
          {champion && first && !first.hidden ? (
            <motion.div
              key="champ"
              className={s.champ}
              initial={reduce ? { opacity: 0 } : { scale: 0.2, rotate: -20, opacity: 0 }}
              animate={{ scale: 1, rotate: -2, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 220, damping: 12, delay: 0.25 }}
            >
              <motion.span
                className={s.champCrown}
                initial={reduce ? { opacity: 0 } : { y: -260, rotate: -40, opacity: 0 }}
                animate={{ y: 0, rotate: -8, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 260, damping: 11, delay: 0.7 }}
              >
                <Doodle name="crown" size={190} fill="var(--sun)" />
              </motion.span>
              <div className={s.champAvatar}>
                <Avatar config={first.avatar} size={300} />
              </div>
              <p className={s.champLabel}>your champion</p>
              <h2 className={s.champName}>{first.nickname}</h2>
              <p className={s.champPts}>
                <NumberTicker value={first.total} /> points
              </p>
            </motion.div>
          ) : drumRoll ? (
            <motion.div key="drum" className={s.drumBlock} initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
              <motion.p className={s.drum} animate={reduce ? {} : { rotate: [-3, 3, -3], x: [-8, 8, -8], scale: [1, 1.08, 1] }} transition={{ repeat: Infinity, duration: 0.22 }}>
                drum roll...
              </motion.p>
              <p className={s.sceneHand}>who is number one?</p>
              <span className={s.drumCount}>{nextAt ? Math.max(0, Math.ceil((nextAt - now) / 1000)) : ''}</span>
            </motion.div>
          ) : (
            <motion.div key="title" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <h2 className={s.sceneTitle}>{revealing ? 'and the top 10 is...' : b.freeze.frozen ? 'the board is frozen' : 'the board'}</h2>
              <p className={s.sceneHand}>
                {revealing ? `${left} more place${left === 1 ? '' : 's'} to uncover.` : `${b.players} people playing. points from votes, check-ins, the hunt, morse and the arcade.`}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <ol className={s.sceneList}>
        {b.rows.map((r) =>
          r.hidden ? (
            <motion.li key={`h${r.rank}`} layout className={`${s.sceneRow} ${s.sceneHidden} ${revealing && drumRoll && r.rank === 1 ? s.sceneSuspense : ''}`}>
              <span>#{r.rank}</span>
              <span />
              <span className={s.sceneMystery}>? ? ?</span>
              <span />
            </motion.li>
          ) : (
            <motion.li
              key={r.attendeeId}
              layout={!reduce}
              className={`${s.sceneRow} ${r.rank === 1 ? s.sceneFirst : ''} ${flash === r.rank ? s.sceneFlash : ''} ${s.rel}`}
              initial={reduce ? { opacity: 0 } : { rotateX: -100, scale: 1.12, opacity: 0.2 }}
              animate={{ rotateX: 0, scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 220, damping: 14, layout: { type: 'spring', stiffness: 260, damping: 24 } }}
            >
              {r.rank === 1 && reveal?.startedAt && <Doodle name="crown" size={64} fill="var(--sun)" className={s.crown} />}
              <span>#{r.rank}</span>
              <Avatar config={r.avatar} size={58} />
              <span className={s.sceneNick}>{r.nickname}</span>
              <span className={s.sceneTotal}>
                {(moves.get(r.attendeeId) ?? 0) !== 0 && (
                  <span className={`${s.scenePip} ${(moves.get(r.attendeeId) ?? 0) > 0 ? s.pipUp : s.pipDown}`}>
                    {(moves.get(r.attendeeId) ?? 0) > 0 ? '▲' : '▼'}
                    {Math.abs(moves.get(r.attendeeId) ?? 0)}
                  </span>
                )}
                <NumberTicker value={r.total} />
              </span>
            </motion.li>
          ),
        )}
      </ol>
    </div>
  );
}
