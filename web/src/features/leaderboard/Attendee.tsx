/*
  /leaderboard on the phone: "you are #N" with an arrow when you move, a gap bar
  that fills towards the person above, your neighbours, and the top list that
  springs into its new order (rows that climbed flash lime, rows that slid flash pink).
  While frozen: "???" rows and a reminder that your points still count.
*/
import type { BoardRow } from '@afterhours/shared/features/leaderboard';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useLiveEvent } from '../../core/live';
import { useMe } from '../../core/queries';
import { confetti, haptics, sfx } from '../../fun';
import { Avatar, Card, Doodle, ErrorState, LoadingState, NumberTicker } from '../../kit';
import { CountUp } from '../attendance/CountUp';
import { PageHead, Stamp, ui } from '../common/ui';
import s from './leaderboard.module.css';
import { useBoard } from './useBoard';

type Delta = Map<number, number>;

/** Which rows moved since the last render of this list: attendeeId -> places climbed (negative: slid). */
function useDeltas(rows: BoardRow[]): Delta {
  const prev = useRef<Map<number, number>>(new Map());
  const [delta, setDelta] = useState<Delta>(new Map());
  const sig = rows.map((r) => (r.hidden ? `h${r.rank}` : `${r.attendeeId}:${r.rank}`)).join(',');
  useEffect(() => {
    const next = new Map<number, number>();
    const d: Delta = new Map();
    for (const r of rows) {
      if (r.hidden) continue;
      next.set(r.attendeeId, r.rank);
      const was = prev.current.get(r.attendeeId);
      if (was !== undefined && was !== r.rank) d.set(r.attendeeId, was - r.rank);
    }
    prev.current = next;
    if (d.size === 0) return;
    setDelta(d);
    const t = window.setTimeout(() => setDelta(new Map()), 2200);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return delta;
}

export function Row({ r, me, delta = 0 }: { r: BoardRow; me?: number | null; delta?: number }) {
  const reduce = useReducedMotion();
  if (r.hidden)
    return (
      <motion.li layout={!reduce} className={`${s.row} ${s.hidden}`} initial={reduce ? false : { rotateX: 90 }} animate={{ rotateX: 0 }}>
        <span className={s.rank}>#{r.rank}</span>
        <span className={s.mystery}>???</span>
      </motion.li>
    );
  return (
    <motion.li
      layout={!reduce}
      transition={{ layout: { type: 'spring', stiffness: 330, damping: 24 } }}
      className={`${s.row} ${r.attendeeId === me ? s.mine : ''} ${r.rank <= 3 ? s[`top${r.rank}`] : ''} ${delta > 0 ? s.flashUp : delta < 0 ? s.flashDown : ''}`}
    >
      <span className={s.rank}>#{r.rank}</span>
      <Avatar config={r.avatar} size={40} />
      <span className={s.nick}>
        {r.nickname} {r.tied && <span className={s.tie}>=</span>}
      </span>
      <span className={s.total}>
        {delta !== 0 && (
          <motion.span className={`${s.pip} ${delta > 0 ? s.pipUp : s.pipDown}`} initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 600, damping: 12 }}>
            {delta > 0 ? '▲' : '▼'}
            {Math.abs(delta)}
          </motion.span>
        )}
        <NumberTicker value={r.total} />
      </span>
    </motion.li>
  );
}

function RankList({ rows, me }: { rows: BoardRow[]; me: number | null }) {
  const delta = useDeltas(rows);
  return (
    <ol className={s.list}>
      {rows.map((r) => (
        <Row key={r.hidden ? `h${r.rank}` : r.attendeeId} r={r} me={me} delta={r.hidden ? 0 : (delta.get(r.attendeeId) ?? 0)} />
      ))}
    </ol>
  );
}

/** A bar that fills towards the person above, with a "you" token riding the edge and their flag at the end. */
function GapBar({ total, behind, nick }: { total: number; behind: number; nick: string }) {
  const reduce = useReducedMotion();
  const [on, setOn] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setOn(true), 200);
    return () => window.clearTimeout(id);
  }, []);
  const frac = total / Math.max(1, total + behind);
  return (
    <div className={s.gapWrap}>
      <div className={s.gapTrack} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)} aria-label={`gap to ${nick}`}>
        <motion.div className={s.gapFill} initial={false} animate={{ width: on ? `${frac * 100}%` : '0%' }} transition={reduce ? { duration: 0.1 } : { type: 'spring', stiffness: 70, damping: 13 }} />
        <motion.span className={s.gapYou} initial={false} animate={{ left: on ? `${frac * 100}%` : '0%' }} transition={reduce ? { duration: 0.1 } : { type: 'spring', stiffness: 70, damping: 13 }}>
          you
        </motion.span>
        <span className={s.gapFlag}>{nick}</span>
      </div>
    </div>
  );
}

export function LeaderboardPage() {
  const q = useBoard(20);
  const reduce = useReducedMotion();
  const myId = useMe().data?.attendee.id ?? null;
  const [moved, setMoved] = useState<{ dir: 'up' | 'down'; by: number; n: number } | null>(null);
  useLiveEvent('leaderboard.rank', (d) => {
    if (d.previous === null || d.previous === d.rank) return;
    const up = d.rank < d.previous;
    setMoved((m) => ({ dir: up ? 'up' : 'down', by: Math.abs(d.previous! - d.rank), n: (m?.n ?? 0) + 1 }));
    if (up) {
      sfx.success();
      haptics.success();
      confetti({ count: 24, y: 0.25 });
    } else {
      sfx.note(330, 160, 'triangle');
    }
  });
  if (q.isPending) return <LoadingState label="counting points..." />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const b = q.data;
  const me = b.me;
  const rankText = me ? (me.hiddenInTop ? '???' : me.rank ? String(me.rank) : null) : null;
  return (
    <div className={ui.page}>
      <PageHead title="the board" note={`${b.players} people on it. every vote, stamp and game counts.`} color="var(--sun)" />
      {b.freeze.frozen && (
        <motion.p className={s.frozen} animate={reduce ? undefined : { rotate: [-1, 1, -1] }} transition={{ repeat: Infinity, duration: 2.4, ease: 'easeInOut' }}>
          <Doodle name="lock" size={20} /> the board is frozen for the big reveal.
          <span className={s.keepChip}>your points still count</span>
        </motion.p>
      )}
      {me && (
        <Card tone="paper" className={s.meCard}>
          <div className={s.meRow}>
            <div>
              <p className={s.meLabel}>you are</p>
              <div className={s.rankSlot}>
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.p
                    key={rankText ?? 'none'}
                    className={s.meRank}
                    initial={reduce ? { opacity: 0 } : { y: moved?.dir === 'down' ? -70 : 70, opacity: 0, scale: 0.7 }}
                    animate={{ y: 0, opacity: 1, scale: 1 }}
                    exit={reduce ? { opacity: 0 } : { y: moved?.dir === 'down' ? 70 : -70, opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 420, damping: 18 }}
                  >
                    {rankText ? `#${rankText}` : 'unranked'}
                  </motion.p>
                </AnimatePresence>
              </div>
            </div>
            {moved && (
              <motion.span
                key={moved.n}
                className={`${s.arrow} ${moved.dir === 'up' ? s.up : s.down}`}
                initial={reduce ? { opacity: 0 } : { scale: 0, y: moved.dir === 'up' ? 40 : -40, rotate: -30 }}
                animate={reduce ? { opacity: 1 } : { scale: 1, y: [moved.dir === 'up' ? 40 : -40, 0, moved.dir === 'up' ? -8 : 8, 0], rotate: 0 }}
                transition={{ duration: 0.7, type: 'tween' }}
                role="status"
              >
                {moved.dir === 'up' ? '▲' : '▼'} {moved.by}
              </motion.span>
            )}
            <div className={s.mePts}>
              <CountUp value={me.liveTotal} />
              <span className={s.meLabel}>points</span>
            </div>
          </div>
          {b.freeze.frozen && me.liveTotal > me.total && (
            <p className={s.gap}>
              +<CountUp value={me.liveTotal - me.total} /> since the freeze, locked until the reveal.
            </p>
          )}
          {me.behind !== null && me.nextNickname && (
            <div className={ui.stack}>
              <p className={s.gap}>{me.behind === 0 ? `level with ${me.nextNickname}, they got there first` : `${me.behind} pts behind ${me.nextNickname}`}</p>
              <GapBar total={me.total} behind={me.behind} nick={me.nextNickname} />
            </div>
          )}
          {me.lead !== null && <p className={s.gap}>you lead by {me.lead}. don't get comfy.</p>}
          {me.tied && <Stamp tone="sky">tied</Stamp>}
        </Card>
      )}
      {me && me.neighbours.length > 0 && !me.hiddenInTop && (
        <Card tone="paper" tilt={0.6}>
          <h3 className={ui.cardTitle}>around you</h3>
          <RankList rows={me.neighbours} me={myId} />
        </Card>
      )}
      <Card tone="paper" tilt={-0.4} tape tapeColor="sun">
        <h3 className={ui.cardTitle}>top {b.rows.length}</h3>
        <RankList rows={b.rows} me={myId} />
      </Card>
    </div>
  );
}
