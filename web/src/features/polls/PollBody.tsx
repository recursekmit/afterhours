/*
  One poll, any kind: the voting UI while it is live and you have not voted,
  then racing results. Quiz is a little game show: 3-2-1, a draining timer to
  deadlineAt, a stamped locked answer, and the reveal flips cards green/pink.
*/
import { type PollResults, type PollView, type PublicPoll, type PublicPollOf, type VoteRequest, VoteResponseSchema, POLL_LIMITS } from '@afterhours/shared/features/polls';
import { useMutation } from '@tanstack/react-query';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { api, isApiError } from '../../core/api';
import { useServerNow } from '../../core/clock';
import { confetti, haptics, sfx } from '../../fun';
import { Button, Doodle, Hourglass, Meter, NumberTicker, type Tone, useToast } from '../../kit';
import { Stamp, ui } from '../common/ui';
import { MarkerSlider } from './MarkerSlider';
import s from './polls.module.css';
import { usePatchCurrent } from './usePolls';

/** NumberTicker that counts up from 0 when it first appears (the kit one only animates changes). */
export function Up({ value, format }: { value: number; format?: (n: number) => string }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), 60);
    return () => window.clearTimeout(id);
  }, [value]);
  return <NumberTicker value={v} format={format} />;
}

const TONES: Tone[] =['tangerine', 'sky', 'pink', 'lime', 'sun', 'grape'];
const FACES = ['😖', '😕', '😐', '🙂', '😍'];

function useVote(poll: PublicPoll, onRejected?: (msg: string) => void) {
  const patch = usePatchCurrent();
  const toast = useToast();
  const reduce = useReducedMotion();
  return useMutation({
    mutationFn: (body: VoteRequest) => api.post(`/api/polls/${poll.id}/vote`, body, VoteResponseSchema).then((r) => ({ r, body })),
    onSuccess: ({ r, body }) => {
      patch((v) => (v.poll.id === poll.id ? { ...v, myVote: body, results: r.results, voters: r.voters } : v));
      sfx.success();
      haptics.success();
      if (!reduce && poll.kind !== 'quiz') confetti({ count: 30, y: 0.4 });
    },
    onError: (e) => {
      if (isApiError(e, 'word_rejected') && onRejected) onRejected(e.message);
      else toast(e.message, { kind: 'bad', title: 'vote bounced' });
      haptics.fail();
    },
  });
}

// ---- voting ---------------------------------------------------------------------------

function ChoiceVote({ poll }: { poll: PublicPollOf<'single'> | PublicPollOf<'quiz'> }) {
  const vote = useVote(poll);
  const reduce = useReducedMotion();
  const [picked, setPicked] = useState<number | null>(null);
  return (
    <div className={s.options}>
      {poll.options.map((o, i) => {
        const mine = picked === i;
        const other = picked !== null && !mine;
        return (
          <motion.button
            key={i}
            type="button"
            className={`${s.option} ${s[`tone-${TONES[i % TONES.length]}`]}`}
            initial={reduce ? false : { opacity: 0, x: i % 2 ? 60 : -60, rotate: i % 2 ? 6 : -6 }}
            animate={{ opacity: other ? 0.45 : 1, x: 0, rotate: mine ? 0 : i % 2 ? 1 : -1, scale: mine ? 1.05 : other ? 0.96 : 1 }}
            transition={{ type: 'spring', stiffness: 420, damping: 20, delay: picked === null && !reduce ? i * 0.06 : 0 }}
            whileTap={reduce ? { scale: 0.96 } : { scale: 0.9, scaleY: 0.84, rotate: i % 2 ? 3.5 : -3.5 }}
            disabled={vote.isPending || picked !== null}
            onClick={() => {
              setPicked(i);
              vote.mutate(poll.kind === 'quiz' ? { kind: 'quiz', choice: i } : { kind: 'single', choice: i }, { onError: () => setPicked(null) });
            }}
          >
            {poll.kind === 'quiz' && <span className={s.letter}>{String.fromCharCode(65 + i)}</span>}
            {o.emoji && <span className={s.optEmoji}>{o.emoji}</span>}
            <span>{o.label}</span>
          </motion.button>
        );
      })}
    </div>
  );
}

function MultiVote({ poll }: { poll: PublicPollOf<'multi'> }) {
  const vote = useVote(poll);
  const [picked, setPicked] = useState<number[]>([]);
  const toggle = (i: number) => {
    sfx.tick();
    setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : p.length >= poll.maxChoices ? p : [...p, i]));
  };
  return (
    <div className={ui.stack}>
      <p className={ui.hand}>pick up to {poll.maxChoices}</p>
      <div className={s.options}>
        {poll.options.map((o, i) => (
          <motion.button
            key={i}
            type="button"
            aria-pressed={picked.includes(i)}
            className={`${s.option} ${picked.includes(i) ? s[`tone-${TONES[i % TONES.length]}`] : s.optionOff}`}
            animate={{ rotate: picked.includes(i) ? (i % 2 ? 1.8 : -1.8) : 0, scale: picked.includes(i) ? 1.03 : 1 }}
            transition={{ type: 'spring', stiffness: 500, damping: 16 }}
            whileTap={{ scale: 0.9, scaleY: 0.84, rotate: i % 2 ? 3.5 : -3.5 }}
            onClick={() => toggle(i)}
          >
            {o.emoji && <span className={s.optEmoji}>{o.emoji}</span>}
            <span className={s.optLabel}>{o.label}</span>
            <AnimatePresence>
              {picked.includes(i) && (
                <motion.span className={s.tickBadge} initial={{ scale: 0, rotate: -40 }} animate={{ scale: 1, rotate: 0 }} exit={{ scale: 0 }} transition={{ type: 'spring', stiffness: 700, damping: 14 }}>
                  <Doodle name="check" size={20} stroke="currentColor" strokeWidth={3.4} />
                </motion.span>
              )}
            </AnimatePresence>
          </motion.button>
        ))}
      </div>
      <Button tone="ink" block icon="check" disabled={picked.length === 0} loading={vote.isPending} onClick={() => vote.mutate({ kind: 'multi', choices: picked })}>
        lock them in
      </Button>
    </div>
  );
}

function ThisOrThatVote({ poll }: { poll: PublicPollOf<'this_or_that'> }) {
  const vote = useVote(poll);
  const [chosen, setChosen] = useState<0 | 1 | null>(null);
  const reduce = useReducedMotion();
  return (
    <div className={s.tot}>
      {([0, 1] as const).map((i) => (
        <motion.button
          key={i}
          type="button"
          className={`${s.half} ${i === 0 ? s['tone-pink'] : s['tone-sky']}`}
          initial={reduce ? false : { x: i === 0 ? -160 : 160, rotate: i === 0 ? -10 : 10, opacity: 0 }}
          animate={chosen === null ? { scale: 1, x: 0, opacity: 1, rotate: i === 0 ? -2 : 2 } : chosen === i ? { scale: 1.18, rotate: 0, x: i === 0 ? '52%' : '-52%' } : { x: i === 0 ? -320 : 320, opacity: 0, rotate: i === 0 ? -20 : 20 }}
          transition={{ type: 'spring', stiffness: 380, damping: 18 }}
          whileTap={reduce ? { scale: 0.97 } : { scale: 0.9, scaleY: 0.86, rotate: i === 0 ? 3 : -3 }}
          disabled={vote.isPending || chosen !== null}
          onClick={() => {
            setChosen(i);
            vote.mutate({ kind: 'this_or_that', choice: i }, { onError: () => setChosen(null) });
          }}
        >
          {poll.options[i].emoji && <span className={s.halfEmoji}>{poll.options[i].emoji}</span>}
          <span className={s.halfLabel}>{poll.options[i].label}</span>
        </motion.button>
      ))}
      <span className={s.or} aria-hidden="true">
        or
      </span>
    </div>
  );
}

function RatingVote({ poll }: { poll: PublicPollOf<'rating'> }) {
  const vote = useVote(poll);
  const { min, max, lowLabel, highLabel } = poll.scale;
  const [v, setV] = useState(Math.ceil((min + max) / 2));
  const faceOf = (n: number) => FACES[Math.round(((n - min) / Math.max(1, max - min)) * (FACES.length - 1))] ?? '🙂';
  return (
    <div className={ui.stack}>
      <div className={s.rateNum} aria-live="polite">
        {v}
      </div>
      <MarkerSlider min={min} max={max} value={v} onChange={setV} face={faceOf} label="your rating" />
      <div className={ui.between}>
        <span className={ui.hand}>{lowLabel || min}</span>
        <span className={ui.hand}>{highLabel || max}</span>
      </div>
      <Button tone="ink" block icon="check" loading={vote.isPending} onClick={() => vote.mutate({ kind: 'rating', value: v })}>
        that's my number
      </Button>
    </div>
  );
}

function WordVote({ poll }: { poll: PublicPollOf<'wordcloud'> }) {
  const [rejected, setRejected] = useState<string | null>(null);
  const vote = useVote(poll, setRejected);
  const [words, setWords] = useState<string[]>(Array.from({ length: poll.maxWords }, () => ''));
  const [flying, setFlying] = useState(false);
  const max = poll.maxLen || POLL_LIMITS.wordMaxLen;
  const filled = words.map((w) => w.trim()).filter(Boolean);
  return (
    <div className={ui.stack}>
      {words.map((w, i) => (
        <motion.div
          key={i}
          className={s.wordRow}
          animate={flying && w.trim() ? { y: -120, scale: 0.3, opacity: 0, rotate: -8 } : { y: 0, scale: 1, opacity: 1, rotate: 0 }}
          transition={{ duration: 0.38, delay: i * 0.08, ease: [0.5, 0, 0.9, 0.4] }}
        >
          <input
            className={s.wordInput}
            value={w}
            maxLength={max}
            placeholder={i === 0 ? 'one word...' : 'and another?'}
            aria-label={`word ${i + 1}`}
            onChange={(e) => {
              setRejected(null);
              setWords((l) => l.map((x, j) => (j === i ? e.target.value : x)));
            }}
          />
          <span className={`${s.charMeter} ${w.length >= max ? s.charFull : ''}`}>{max - w.length}</span>
        </motion.div>
      ))}
      <AnimatePresence>
        {rejected && (
          <motion.p
            key={rejected}
            role="alert"
            className={s.bubble}
            initial={{ scale: 0.3, rotate: -10, opacity: 0, originX: 0.1, originY: 0 }}
            animate={{ scale: 1, rotate: -2, opacity: 1, x: [0, -8, 8, -5, 5, 0] }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ type: 'spring', stiffness: 520, damping: 15 }}
          >
            <svg className={s.bubbleTail} width="34" height="26" viewBox="0 0 34 26" aria-hidden="true">
              <path d="M2 24C10 20 14 12 13 2c6 5 13 7 20 6C26 12 20 18 2 24z" fill="var(--paper-3)" stroke="var(--ink)" strokeWidth="3" strokeLinejoin="round" />
            </svg>
            {rejected}
          </motion.p>
        )}
      </AnimatePresence>
      <Button
        tone="ink"
        block
        icon="spark"
        disabled={filled.length === 0}
        loading={vote.isPending}
        onClick={() => {
          setFlying(true);
          sfx.whoosh();
          vote.mutate({ kind: 'wordcloud', words: filled }, { onError: () => setFlying(false) });
        }}
      >
        throw it in the cloud
      </Button>
    </div>
  );
}

function QuizVote({ poll }: { poll: PublicPollOf<'quiz'> }) {
  const now = useServerNow(100);
  const starts = poll.startsAt ?? 0;
  const reduce = useReducedMotion();
  const n = Math.ceil((starts - now) / 1000);
  const pre = now < starts;
  // One blip per number of the 3-2-1.
  useEffect(() => {
    if (!pre) return;
    sfx.note(n === 1 ? 880 : 520, 110, 'square');
    haptics.tick();
  }, [n, pre]);
  if (pre) {
    return (
      <div className={s.leadIn}>
        <span className={s.leadHand}>ready?</span>
        <AnimatePresence mode="popLayout">
          <motion.div
            key={n}
            className={s.three}
            initial={reduce ? { opacity: 0 } : { scale: 3, opacity: 0, rotate: -16 }}
            animate={{ scale: 1, opacity: 1, rotate: n % 2 ? -4 : 4 }}
            exit={reduce ? { opacity: 0 } : { scale: 0.3, opacity: 0, rotate: 20 }}
            transition={{ type: 'spring', stiffness: 520, damping: 17 }}
          >
            {n}
          </motion.div>
        </AnimatePresence>
      </div>
    );
  }
  const closed = poll.deadlineAt !== null && now >= poll.deadlineAt;
  return (
    <div className={ui.stack}>
      <QuizTimer poll={poll} now={now} />
      {closed ? (
        <div className={s.locked}>
          <Stamp tone="late" rot={-8}>
            too slow
          </Stamp>
          <p className={ui.hand}>time ran out. eyes on the big screen for the answer.</p>
        </div>
      ) : (
        <ChoiceVote poll={poll} />
      )}
    </div>
  );
}

/** The enchanted exam's sand glass: an hourglass and a draining line, locked to the server's deadlineAt (through the clock offset). */
function QuizTimer({ poll, now }: { poll: PublicPollOf<'quiz'>; now: number }) {
  const end = poll.deadlineAt ?? now;
  const left = Math.max(0, end - now);
  const frac = Math.min(1, left / Math.max(1, poll.durationMs));
  const hot = left < 5000 && left > 0;
  const sec = Math.ceil(left / 1000);
  const last = useRef(sec);
  useEffect(() => {
    if (sec !== last.current && sec <= 5 && sec > 0) {
      sfx.tick();
      haptics.tick();
    }
    last.current = sec;
  }, [sec]);
  return (
    <div className={`${s.timer} ${hot ? s.timerHot : ''}`}>
      <Hourglass frac={frac} size={46} />
      <div className={s.drainTrack} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)} aria-label="time left">
        <div className={`${s.drainFill} ${hot ? s.drainHot : ''}`} style={{ width: `${frac * 100}%` }} />
      </div>
      <span className={s.timerNum}>{sec}</span>
    </div>
  );
}

// ---- results ----------------------------------------------------------------------------

function optionsOf(p: PublicPoll) {
  return 'options' in p ? p.options : [];
}

function Bars({ poll, results, mine }: { poll: PublicPoll; results: Extract<PollResults, { counts: number[] }>; mine: number[] }) {
  const opts = optionsOf(poll);
  const total = Math.max(1, Math.max(...results.counts, 1));
  const sum = Math.max(1, results.counts.reduce((a, b) => a + b, 0));
  const correct = 'correct' in results && typeof results.correct === 'number' ? results.correct : null;
  const reduce = useReducedMotion();
  // Bars start empty and race up; on a quiz reveal the cards flip one by one with a tick.
  const [raced, setRaced] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setRaced(true), 120);
    return () => window.clearTimeout(id);
  }, []);
  useEffect(() => {
    if (correct === null) return;
    const ids = opts.map((_, i) => window.setTimeout(() => (i === correct ? sfx.success() : sfx.tick()), i * 260 + 200));
    return () => ids.forEach((id) => window.clearTimeout(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [correct]);
  return (
    <ul className={s.bars}>
      {opts.map((o, i) => {
        const n = results.counts[i] ?? 0;
        const isMine = mine.includes(i);
        const tone: Tone = correct !== null ? (i === correct ? 'lime' : isMine ? 'pink' : 'paper') : (TONES[i % TONES.length] ?? 'sun');
        const reveal = correct !== null ? (i === correct ? s.revRight : isMine ? s.revWrong : s.revPlain) : '';
        return (
          <motion.li
            key={i}
            className={`${s.bar} ${reveal} ${isMine ? s.barMine : ''}`}
            initial={correct !== null && !reduce ? { rotateX: 90, opacity: 0 } : false}
            animate={{ rotateX: 0, opacity: 1, scale: correct === i && !reduce ? [1, 1.06, 1] : 1 }}
            transition={{ delay: i * (correct !== null ? 0.26 : 0.08), duration: 0.4 }}
          >
            <div className={ui.between}>
              <span className={s.barLabel}>
                {o.emoji} {o.label} {isMine && <Stamp tone="ink" rot={-4}>you</Stamp>} {correct === i && <Stamp tone="live" rot={3}>right</Stamp>}
              </span>
              <span className={s.barNum}>
                <Up value={Math.round((n / sum) * 100)} format={(v) => `${v}%`} />
              </span>
            </div>
            <Meter value={raced ? n / total : 0} tone={tone} label={o.label} />
            <span className={s.barCount}>
              <Up value={n} /> {n === 1 ? 'vote' : 'votes'}
            </span>
          </motion.li>
        );
      })}
    </ul>
  );
}

function Results({ view }: { view: PollView }) {
  const { poll, results, myVote, myQuiz } = view;
  if (!results) return null;
  if (results.kind === 'rating') {
    const top = Math.max(1, ...results.histogram);
    return (
      <div className={ui.stack}>
        <p className={s.avg}>
          average{' '}
          <b>{results.average === null ? '-' : <Up value={Math.round(results.average * 10)} format={(v) => (v / 10).toFixed(1)} />}</b>
          {myVote?.kind === 'rating' && <span className={ui.hand}> (you said {myVote.value})</span>}
        </p>
        <div className={s.histo}>
          {results.histogram.map((n, i) => (
            <div key={i} className={s.histoCol}>
              <motion.div
                className={`${s.histoBar} ${myVote?.kind === 'rating' && myVote.value === results.min + i ? s.histoMine : ''}`}
                initial={{ height: '0%' }}
                animate={{ height: `${(n / top) * 100}%` }}
                transition={{ type: 'spring', stiffness: 130, damping: 13, delay: i * 0.05 }}
              />
              <span className={s.histoLabel}>{results.min + i}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (results.kind === 'wordcloud') {
    const top = Math.max(1, ...results.words.map((w) => w.count));
    const mine = myVote?.kind === 'wordcloud' ? myVote.words : [];
    return (
      <div className={s.cloud}>
        {results.words.map((w, i) => (
          <motion.span
            key={w.word}
            layout
            className={`${s.cloudWord} ${mine.includes(w.word) ? s.cloudMine : ''}`}
            style={{ fontSize: `${0.9 + (w.count / top) * 1.8}rem`, rotate: ((i * 37) % 9) - 4 }}
            initial={mine.includes(w.word) ? { scale: 0.2, y: 260, opacity: 0, rotate: -30 } : { scale: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 220, damping: 14 }}
          >
            {w.word}
          </motion.span>
        ))}
        {results.words.length === 0 && <p className={ui.hand}>the cloud is empty. be first.</p>}
      </div>
    );
  }
  if (results.kind === 'quiz' && !results.revealed) {
    return (
      <div className={s.locked}>
        <motion.span
          className={s.lockStamp}
          initial={{ scale: 3.2, rotate: 22, opacity: 0 }}
          animate={{ scale: 1, rotate: -8, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 540, damping: 15 }}
        >
          locked in
        </motion.span>
        {myVote?.kind === 'quiz' && 'options' in poll && (
          <p className={s.lockedPick}>
            <span className={s.letter}>{String.fromCharCode(65 + myVote.choice)}</span> {poll.options[myVote.choice]?.label}
          </p>
        )}
        <p className={ui.hand}>answer shows up at the reveal. eyes on the big screen.</p>
      </div>
    );
  }
  const mine = myVote ? (myVote.kind === 'multi' ? myVote.choices : 'choice' in myVote ? [myVote.choice] : []) : [];
  return (
    <div className={ui.stack}>
      {myQuiz && (
        <motion.div
          className={`${s.quizResult} ${myQuiz.correct ? s.quizRight : s.quizWrong}`}
          initial={{ scale: 0.4, rotate: -8, opacity: 0 }}
          animate={{ scale: 1, rotate: myQuiz.correct ? -1.5 : 1.5, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 420, damping: 14, delay: 0.9 }}
        >
          <span className={s.quizBig}>{myQuiz.correct ? <Up value={myQuiz.points} format={(n) => `+${n}`} /> : 'nope'}</span>
          <span className={ui.hand}>{myQuiz.correct ? `right in ${(myQuiz.elapsedMs / 1000).toFixed(1)} s, ${myQuiz.speedBonus} of that was speed` : 'next one is yours'}</span>
        </motion.div>
      )}
      {'counts' in results && <Bars poll={poll} results={results} mine={mine} />}
    </div>
  );
}

// ---- the whole thing ------------------------------------------------------------------

export function PollBody({ view }: { view: PollView }) {
  const { poll } = view;
  const live = poll.status === 'live';
  const canVote = live && !view.myVote;
  return (
    <div className={s.body}>
      <div className={ui.between}>
        <Stamp tone={live ? 'live' : poll.status === 'revealed' ? 'sky' : 'done'}>{live ? (poll.kind === 'quiz' ? 'quiz' : 'live poll') : poll.status}</Stamp>
        <span className={s.voters}>
          <NumberTicker value={view.voters} /> {poll.kind === 'quiz' ? 'answered' : 'voted'}
        </span>
      </div>
      <h2 className={s.question}>{poll.question}</h2>
      {canVote ? (
        poll.kind === 'single' ? (
          <ChoiceVote poll={poll} />
        ) : poll.kind === 'multi' ? (
          <MultiVote poll={poll} />
        ) : poll.kind === 'this_or_that' ? (
          <ThisOrThatVote poll={poll} />
        ) : poll.kind === 'rating' ? (
          <RatingVote poll={poll} />
        ) : poll.kind === 'wordcloud' ? (
          <WordVote poll={poll} />
        ) : (
          <QuizVote poll={poll} />
        )
      ) : view.results ? (
        <Results view={view} />
      ) : (
        <p className={ui.hand}>{live ? 'thanks! results land in a sec.' : "you missed this one. results show up when it's revealed."}</p>
      )}
    </div>
  );
}
