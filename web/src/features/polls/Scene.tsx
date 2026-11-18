/* Projector: the poll takeover. Racing bars, the word cloud, the quiz countdown and its reveal with the series board. */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useServerNow } from '../../core/clock';
import { Avatar, NumberTicker } from '../../kit';
import { Up } from './PollBody';
import s from './polls.module.css';
import { useScreenPoll } from './status';

const FILLS = ['var(--tangerine)', 'var(--sky)', 'var(--pink)', 'var(--lime)', 'var(--sun)', 'var(--grape)'];

export default function PollScene() {
  const q = useScreenPoll();
  const now = useServerNow(200);
  const reduce = useReducedMotion();
  const st = q.data;
  if (!st?.poll) return null;
  const { poll, results, board } = st;
  const opts = 'options' in poll ? poll.options : [];
  const voters = results?.total ?? 0;

  let body = null;
  if (poll.kind === 'quiz' && poll.status === 'live') {
    const starts = poll.startsAt ?? 0;
    const pre = now < starts;
    const left = pre ? starts - now : Math.max(0, (poll.deadlineAt ?? now) - now);
    const n = Math.ceil(left / 1000);
    const frac = pre ? 1 : Math.min(1, left / Math.max(1, poll.durationMs));
    body = (
      <div className={s.sceneBars}>
        <div className={s.sceneClockRow}>
          <AnimatePresence mode="popLayout">
            <motion.div
              key={`${pre}-${n}`}
              className={`${s.sceneCount} ${!pre && n <= 5 ? s.sceneHot : ''}`}
              initial={reduce ? { opacity: 0 } : { scale: 2.2, opacity: 0, rotate: -10 }}
              animate={{ scale: 1, opacity: 1, rotate: 0 }}
              exit={{ opacity: 0, scale: 0.5 }}
              transition={{ type: 'spring', stiffness: 520, damping: 18 }}
            >
              {pre ? `${n}` : n}
            </motion.div>
          </AnimatePresence>
          {!pre && (
            <div className={s.sceneDrain}>
              <div className={s.sceneDrainFill} style={{ width: `${frac * 100}%`, background: n <= 5 ? 'var(--pink)' : 'var(--lime)' }} />
            </div>
          )}
        </div>
        <div className={s.quizGrid}>
          {opts.map((o, i) => (
            <motion.div key={i} className={`${s.quizCard} ${s[`qc${i % 4}`]}`} initial={reduce ? false : { y: 40, opacity: 0, rotate: i % 2 ? 3 : -3 }} animate={{ y: 0, opacity: 1, rotate: i % 2 ? 0.8 : -0.8 }} transition={{ delay: i * 0.1, type: 'spring', stiffness: 300, damping: 18 }}>
              <span className={s.quizLetter}>{String.fromCharCode(65 + i)}</span>
              <span className={s.quizText}>
                {o.emoji} {o.label}
              </span>
            </motion.div>
          ))}
        </div>
      </div>
    );
  } else if (results && 'counts' in results) {
    const max = Math.max(1, ...results.counts);
    const sum = Math.max(1, results.counts.reduce((a, b) => a + b, 0));
    const correct = 'correct' in results ? results.correct : null;
    const lead = Math.max(...results.counts);
    body = (
      <div className={`${s.sceneBars} ${opts.length > 4 ? s.compact : ''}`}>
        {opts.map((o, i) => (
          <motion.div
            key={i}
            className={`${s.sceneBar} ${correct === i ? s.sceneCorrect : ''} ${correct !== null && correct !== i ? s.sceneWrong : ''}`}
            initial={correct !== null && !reduce ? { rotateX: 90, opacity: 0 } : false}
            animate={{ rotateX: 0, opacity: 1, scale: correct === i && !reduce ? [1, 1.05, 1] : 1 }}
            transition={{ delay: correct !== null ? 0.5 + i * 0.35 : 0, duration: 0.5 }}
          >
            <span className={s.sceneLabel}>
              {o.emoji} {o.label}
            </span>
            <div className={s.sceneTrack}>
              <motion.div
                className={s.sceneFill}
                style={{ background: correct === null ? FILLS[i % FILLS.length] : correct === i ? 'var(--lime)' : 'var(--paper-2)' }}
                initial={{ width: '0%' }}
                animate={{ width: `${((results.counts[i] ?? 0) / max) * 100}%` }}
                transition={reduce ? { duration: 0.1 } : { type: 'spring', stiffness: 70, damping: 13 }}
              />
              {correct === null && lead > 0 && results.counts[i] === lead && <span className={s.leadFlag}>leading</span>}
            </div>
            <span className={s.sceneNum}>
              <Up value={Math.round(((results.counts[i] ?? 0) / sum) * 100)} format={(v) => `${v}%`} />
            </span>
          </motion.div>
        ))}
      </div>
    );
  } else if (results?.kind === 'wordcloud') {
    const top = Math.max(1, ...results.words.map((w) => w.count));
    body = (
      <div className={s.sceneCloud}>
        {results.words.map((w, i) => (
          <motion.span
            key={w.word}
            layout
            className={s.sceneWord}
            style={{ fontSize: `calc(var(--u) * ${2 + (w.count / top) * 6})`, color: FILLS[i % FILLS.length], rotate: ((i * 37) % 11) - 5 }}
            initial={reduce ? { opacity: 0 } : { scale: 0, y: 60 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
          >
            {w.word}
          </motion.span>
        ))}
      </div>
    );
  } else if (results?.kind === 'rating') {
    body = <div className={s.avgBig}>{results.average === null ? '-' : results.average.toFixed(1)}</div>;
  } else if (results?.kind === 'quiz') {
    body = (
      <div className={s.drumroll}>
        <motion.div className={s.drumWord} animate={reduce ? undefined : { rotate: [-2, 2, -2], x: [-6, 6, -6], scale: [1, 1.04, 1] }} transition={{ duration: 0.18, repeat: Infinity }}>
          drumroll...
        </motion.div>
        <div className={s.sceneMeta}>
          <Up value={results.total} /> locked in
        </div>
      </div>
    );
  }

  return (
    <div className={s.scene}>
      <div className={s.sceneMeta}>
        <span>{poll.status === 'live' ? (poll.kind === 'quiz' ? 'quiz time' : 'vote on your phone') : poll.status === 'revealed' ? 'the answer' : 'voting closed'}</span>
        <span>
          <NumberTicker value={voters} /> {poll.kind === 'quiz' ? 'answered' : 'voted'}
        </span>
      </div>
      <h2 className={s.sceneQ}>{poll.question}</h2>
      {body}
      {board && board.length > 0 && (
        <ol className={s.board}>
          {board.slice(0, 8).map((b) => (
            <li key={b.attendeeId} className={s.boardRow}>
              <span>#{b.rank}</span>
              <Avatar config={b.avatar} size={44} />
              <span>{b.nickname}</span>
              <span>{b.points}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
