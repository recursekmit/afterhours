/*
  Home: the "room is alive" strip. Your streak chip, a tease when a drop is about to land, and the last few
  lines of the live feed. It is a card in the page flow, never floating, so it can't cover a control.
*/
import type { FeedItem } from '@afterhours/shared/features/drops';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useServerNow } from '../../core/clock';
import { Doodle } from '../../kit';
import { useCurrentDrop, useFeed, useStreak } from './api';
import s from './drops.module.css';

const TONE: Record<FeedItem['tone'], string> = { drop: 'var(--lime)', win: 'var(--sun)', info: 'var(--sky)', hype: 'var(--pink)', note: 'var(--paper-3)' };

export function StreakChip() {
  const q = useStreak();
  const st = q.data;
  if (!st) return null;
  const hot = st.streak >= 3;
  return (
    <div className={`${s.streak} ${hot ? s.streakHot : ''}`} aria-label={`streak: ${st.streak} activities in a row`}>
      <Doodle name="flame" size={26} fill={hot ? 'var(--tangerine)' : 'var(--paper-3)'} />
      <span className={s.streakNum}>{st.streak}</span>
      <span className={s.streakText}>{st.streak === 0 ? 'join the next thing to start a streak' : `in a row${st.best > st.streak ? `, best ${st.best}` : ''}`}</span>
      <span className={s.dots} aria-hidden="true">
        {st.recent.slice(-5).map((r, i) => (
          <i key={i} data-did={r.did} data-live={r.live} title={r.title} />
        ))}
      </span>
    </div>
  );
}

function Tease() {
  const q = useCurrentDrop();
  const now = useServerNow(1000);
  const at = q.data?.nextAt ?? null;
  if (!at || at <= now || (q.data?.drop && q.data.drop.status === 'live')) return null;
  const t = Math.ceil((at - now) / 1000);
  return (
    <p className={s.tease} role="status">
      <Doodle name="bolt" size={22} fill="var(--sun)" /> something drops in{' '}
      <b>
        {Math.floor(t / 60)}:{String(t % 60).padStart(2, '0')}
      </b>
      . phone out.
    </p>
  );
}

export function DropsHomeCard() {
  const feed = useFeed(6);
  const reduce = useReducedMotion();
  const items = (feed.data?.items ?? []).slice(-3).reverse();
  return (
    <section className={s.strip} aria-label="what's happening">
      <StreakChip />
      <Tease />
      {!feed.data?.muted && items.length > 0 && (
        <ul className={s.feed} aria-live="polite">
          <AnimatePresence initial={false}>
            {items.map((it) => (
              <motion.li
                key={it.id}
                layout={!reduce}
                className={s.line}
                initial={reduce ? { opacity: 0 } : { opacity: 0, x: -30, rotate: -2 }}
                animate={{ opacity: 1, x: 0, rotate: 0 }}
                exit={{ opacity: 0 }}
                transition={{ type: 'spring', stiffness: 320, damping: 24 }}
              >
                <span className={s.lineIcon} style={{ background: TONE[it.tone] }}>
                  <Doodle name={it.icon} size={18} />
                </span>
                <span>{it.text}</span>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </section>
  );
}
