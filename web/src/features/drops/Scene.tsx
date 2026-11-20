/*
  Projector: the flash-drop takeover scene (siren, 3-2-1, the challenge, a live "17/20 claimed", the
  podium, the reveal) and the always-on overlay: a bottom ticker built from the live feed (clear of the
  Recurse corner mark) and the hype meter, which sets the room on fire at max.
*/
import type { Challenge, FeedItem, PublicDrop } from '@afterhours/shared/features/drops';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import type { SceneStatus } from '../../core/feature';
import { useServerNow } from '../../core/clock';
import { useLiveEvent } from '../../core/live';
import { sfx } from '../../fun';
import { Avatar, Doodle, NumberTicker } from '../../kit';
import { useFeed, useHype, useScreenDrop } from './api';
import s from './drops.module.css';

const HOLD_MS = 12_000;

function clock(ms: number): string {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return t >= 60 ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` : String(t);
}

export function useDropSceneStatus(): SceneStatus {
  const q = useScreenDrop();
  const now = useServerNow(1000);
  const d = q.data?.drop;
  if (!d) return 'off';
  if (d.status === 'live') return 'takeover';
  if (d.closedAt && now - d.closedAt < HOLD_MS) return 'takeover';
  return 'off';
}

function MorseRow({ patterns }: { patterns: string[] }) {
  return (
    <div className={s.morse} aria-label="morse code">
      {patterns.map((p, i) => (
        <span key={i} className={s.morseLetter}>
          {p.split('').map((c, j) => (
            <i key={j} className={c === '-' ? s.dash : s.dot} />
          ))}
        </span>
      ))}
    </div>
  );
}

function ChallengeView({ drop, challenge }: { drop: PublicDrop; challenge: Challenge | null }) {
  if (drop.kind === 'code' && challenge) {
    return challenge.display === 'plain' ? <p className={s.bigCode}>{challenge.text}</p> : <MorseRow patterns={challenge.patterns} />;
  }
  if (drop.kind === 'speed') {
    return (
      <div className={s.sceneQ}>
        <p className={s.sceneQuestion}>{drop.question}</p>
        {drop.choices && drop.choices.length > 0 && (
          <ol className={s.sceneChoices}>
            {drop.choices.map((c, i) => (
              <li key={i} style={{ background: ['var(--sun)', 'var(--sky)', 'var(--pink)', 'var(--lime)'][i % 4] }}>
                {c}
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  }
  if (drop.kind === 'golden') {
    return (
      <p className={s.sceneHint}>
        <Doodle name="crown" size={64} fill="var(--sun)" /> {drop.hint || 'it is somewhere in the venue.'}
      </p>
    );
  }
  return <p className={s.sceneHint}>react on your phones. tap the big button. together.</p>;
}

export default function DropScene() {
  const q = useScreenDrop();
  const now = useServerNow(200);
  const reduce = useReducedMotion();
  const sirenFor = useRef<number | null>(null);
  const d = q.data?.drop;
  useEffect(() => {
    if (d && d.status === 'live' && d.opensAt && now < d.opensAt && sirenFor.current !== d.id) {
      sirenFor.current = d.id;
      [880, 660, 880, 660].forEach((f, i) => window.setTimeout(() => sfx.note(f, 140, 'square'), i * 160));
    }
  }, [d, now]);
  if (!q.data || !d) return null;
  const { tally, challenge } = q.data;
  const lead = d.status === 'live' && d.opensAt !== null && now < d.opensAt;
  const open = d.status === 'live' && !lead;
  const left = d.closesAt ? Math.max(0, d.closesAt - now) : 0;
  const goal = tally?.goal ?? d.goal ?? 1;
  return (
    <div className={s.scene}>
      <div className={s.sceneTop}>
        <span className={s.sceneKind}>
          <Doodle name="bolt" size={48} fill="var(--sun)" /> flash drop
        </span>
        {open && (
          <span className={`${s.sceneClock} ${left < 10_000 ? s.clockHot : ''}`}>
            {clock(left)}
          </span>
        )}
      </div>
      <h1 className={s.sceneTitle}>{d.title}</h1>
      {lead && d.opensAt !== null ? (
        <AnimatePresence mode="popLayout">
          <motion.p
            key={Math.ceil((d.opensAt - now) / 1000)}
            className={s.sceneLead}
            initial={reduce ? { opacity: 0 } : { scale: 3, opacity: 0, rotate: -14 }}
            animate={{ scale: 1, opacity: 1, rotate: 0 }}
            exit={{ opacity: 0 }}
            transition={{ type: 'spring', stiffness: 480, damping: 16 }}
          >
            {Math.max(1, Math.ceil((d.opensAt - now) / 1000))}
          </motion.p>
        </AnimatePresence>
      ) : (
        <>
          {open && <ChallengeView drop={d} challenge={challenge} />}
          {!open && d.reveal && (
            <p className={s.sceneReveal}>
              it was <b>{d.reveal}</b>
            </p>
          )}
          {!open && d.status === 'cancelled' && <p className={s.sceneReveal}>called off by the organisers.</p>}
          {!open && d.kind === 'room' && d.status === 'closed' && <p className={s.sceneReveal}>{d.achieved ? 'the room did it! everyone gets points.' : 'so close. next one.'}</p>}
          <div className={s.sceneTally}>
            {d.kind === 'room' ? (
              <>
                <div className={s.sceneBar}>
                  <motion.i initial={false} animate={{ width: `${Math.min(100, ((tally?.count ?? 0) / goal) * 100)}%` }} />
                </div>
                <p className={s.sceneCount}>
                  <NumberTicker value={tally?.count ?? 0} />/{goal}
                </p>
              </>
            ) : d.kind === 'code' && tally?.slots ? (
              <>
                <div className={s.sceneBar}>
                  <motion.i initial={false} animate={{ width: `${Math.min(100, (tally.claimed / tally.slots) * 100)}%` }} />
                </div>
                <p className={s.sceneCount}>
                  <NumberTicker value={Math.min(tally.claimed, tally.slots)} />/{tally.slots} claimed
                </p>
              </>
            ) : (
              <p className={s.sceneCount}>{tally ? `${tally.players} in` : ''}</p>
            )}
          </div>
          {tally && tally.winners.length > 0 && (
            <ol className={s.scenePodium}>
              <AnimatePresence initial={false}>
                {tally.winners.slice(0, 5).map((w) => (
                  <motion.li key={`${w.rank}-${w.nickname}`} initial={reduce ? { opacity: 0 } : { y: 40, opacity: 0, rotate: -6 }} animate={{ y: 0, opacity: 1, rotate: w.rank % 2 ? -1.5 : 1.5 }} transition={{ type: 'spring', stiffness: 300, damping: 18 }}>
                    <span className={s.winRank}>#{w.rank}</span>
                    <Avatar config={w.avatar} size={56} />
                    <b>{w.nickname}</b>
                    <span className={s.winPts}>+{w.points}</span>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ol>
          )}
        </>
      )}
    </div>
  );
}

const TONE: Record<FeedItem['tone'], string> = { drop: 'var(--lime)', win: 'var(--sun)', info: 'var(--sky)', hype: 'var(--pink)', note: 'var(--paper-3)' };

/** Always over the projector: the ticker and the hype meter. */
export function DropsScreenOverlay() {
  const feed = useFeed(8);
  const hype = useHype();
  const reduce = useReducedMotion();
  const [fire, setFire] = useState(0);
  useLiveEvent('drops.on-fire', () => setFire(Date.now()));
  useEffect(() => {
    if (!fire) return;
    const t = window.setTimeout(() => setFire(0), 5000);
    return () => window.clearTimeout(t);
  }, [fire]);
  const items = feed.data?.muted ? [] : (feed.data?.items ?? []).slice(-4).reverse();
  const h = hype.data;
  return (
    <>
      <div className={s.ticker} aria-live="polite">
        {h?.enabled && (
          <div className={s.hype} title={`${h.perMin} a minute`}>
            <Doodle name="flame" size={30} fill={h.level >= 1 ? 'var(--tangerine)' : 'var(--sun)'} />
            <span className={s.hypeBar}>
              <motion.i initial={false} animate={{ width: `${Math.round(Math.min(1, h.level) * 100)}%` }} transition={{ type: 'spring', stiffness: 90, damping: 16 }} />
            </span>
          </div>
        )}
        <ul className={s.tickerLines}>
          <AnimatePresence initial={false}>
            {items.map((it) => (
              <motion.li key={it.id} layout={!reduce} initial={reduce ? { opacity: 0 } : { opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, width: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 24 }}>
                <span className={s.lineIcon} style={{ background: TONE[it.tone] }}>
                  <Doodle name={it.icon} size={20} />
                </span>
                {it.text}
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      </div>
      <AnimatePresence>
        {fire > 0 && (
          <motion.div
            className={s.onFire}
            initial={reduce ? { opacity: 0 } : { scale: 0.3, rotate: -20, opacity: 0 }}
            animate={{ scale: 1, rotate: -4, opacity: 1 }}
            exit={{ opacity: 0, scale: 1.4 }}
            transition={{ type: 'spring', stiffness: 260, damping: 12 }}
          >
            <Doodle name="flame" size={120} fill="var(--tangerine)" />
            the room is on fire
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
