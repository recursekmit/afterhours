/*
  Polls on the phone.
  - PollOverlay: when a poll launches it takes over wherever you are. It can be
    collapsed to a "poll is live" pill and comes back on tap. Never traps you.
    Quiz results ('polls.quiz-result') celebrate here too.
  - /polls: the current poll and the history.
  - Home card: the current poll in short.
*/
import type { PollView } from '@afterhours/shared/features/polls';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { useLiveEvent } from '../../core/live';
import { celebrate, haptics, sfx } from '../../fun';
import { Button, Card, Doodle, EmptyState, ErrorState, IconButton, LinkButton, LoadingState, useToast } from '../../kit';
import { PageHead, ui } from '../common/ui';
import { PollBody } from './PollBody';
import s from './polls.module.css';
import { useCurrentPoll, usePollHistory } from './usePolls';

export function PollOverlay() {
  const q = useCurrentPoll();
  const { pathname } = useLocation();
  const toast = useToast();
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);

  useLiveEvent('polls.launched', () => {
    sfx.fanfare();
    haptics.celebrate();
    if (!pathname.startsWith('/polls')) setOpen(true);
  });
  useLiveEvent('polls.quiz-result', (r) => {
    if (r.correct) {
      celebrate({ y: 0.4 });
      toast(`right answer, +${r.points}`, { kind: 'points', title: 'nailed it' });
    } else toast('not this time. next one.', { kind: 'bad', title: 'quiz' });
  });

  const view = q.data?.view ?? null;
  const live = view?.poll.status === 'live';
  const needsMe = live && !view?.myVote;
  // Close the takeover a moment after the poll stops being live.
  useEffect(() => {
    if (!live && open) {
      const t = window.setTimeout(() => setOpen(false), 2500);
      return () => window.clearTimeout(t);
    }
  }, [live, open]);

  if (!view || pathname.startsWith('/polls')) return null;
  const showPill = live && !open;
  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div className={s.takeover} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} role="dialog" aria-modal="true" aria-label="live poll">
            <motion.div
              className={s.takeoverCard}
              initial={reduce ? { opacity: 0 } : { y: 700, rotate: 14, scale: 0.7 }}
              animate={{ y: 0, rotate: -1, scale: 1, opacity: 1 }}
              exit={reduce ? { opacity: 0 } : { y: 600, rotate: -8 }}
              transition={{ type: 'spring', stiffness: 240, damping: 14, mass: 0.9 }}
            >
              <IconButton icon="close" label="hide poll" size="sm" className={s.takeoverClose} onClick={() => setOpen(false)} />
              <PollBody view={view} />
              <Button tone="paper" size="sm" ghost onClick={() => setOpen(false)} className={s.later}>
                later, take me back
              </Button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showPill && (
          <motion.button
            type="button"
            className={`${s.pill} ${needsMe ? s.pillHot : ''}`}
            initial={reduce ? { opacity: 0 } : { y: 80, rotate: -10 }}
            animate={{ y: 0, rotate: -3, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            onClick={() => setOpen(true)}
          >
            <Doodle name="bars" size={22} /> {needsMe ? (view.poll.kind === 'quiz' ? 'quiz is live, tap in' : 'poll is live, vote') : 'poll is live'}
          </motion.button>
        )}
      </AnimatePresence>
    </>
  );
}

function HistoryItem({ v }: { v: PollView }) {
  return (
    <Card tone="paper" tilt={v.poll.id % 2 ? 0.6 : -0.6}>
      <PollBody view={v} />
    </Card>
  );
}

export function PollsPage() {
  const q = useCurrentPoll();
  const h = usePollHistory();
  if (q.isPending) return <LoadingState label="finding the poll..." />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const view = q.data.view;
  const past = (h.data?.items ?? []).filter((v) => v.poll.id !== view?.poll.id);
  return (
    <div className={ui.page}>
      <PageHead title="polls" note="when a poll goes live it lands here. vote, then watch the bars race." color="var(--grape)" />
      {view ? (
        <Card tone={view.poll.status === 'live' ? 'sun' : 'paper'} tilt={-0.8} tape tapeColor="pink">
          <PollBody view={view} />
        </Card>
      ) : (
        <EmptyState title="no poll yet" hint="the organisers launch them during the talks. your phone will buzz." />
      )}
      {past.length > 0 && <h2 className={ui.cardTitle}>earlier</h2>}
      {past.map((v) => (
        <HistoryItem key={v.poll.id} v={v} />
      ))}
    </div>
  );
}

export function PollHomeCard() {
  const q = useCurrentPoll();
  const view = q.data?.view;
  if (!view) return null;
  const live = view.poll.status === 'live';
  return (
    <Card tone={live ? 'sun' : 'paper'} tilt={live ? -1.4 : 0.6} tape="left" tapeColor="sky" className={s.homeCard}>
      <div className={ui.between}>
        <span className={ui.kicker}>{live ? (view.poll.kind === 'quiz' ? 'quiz time' : 'live poll') : 'last poll'}</span>
        <span className={s.voters}>{view.voters} in</span>
      </div>
      <h3 className={s.homeQ}>{view.poll.question}</h3>
      <LinkButton to="/polls" tone={live && !view.myVote ? 'ink' : 'paper'} size="sm" icon="bars">
        {live && !view.myVote ? 'vote now' : 'see results'}
      </LinkButton>
    </Card>
  );
}
