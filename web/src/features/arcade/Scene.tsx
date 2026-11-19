/* Projector: three scoreboards, the puzzle-hour house strip, plus a record-breaker takeover on arcade.record. */
import { ARCADE_GAMES, type ArcadeRecord, TopResponseSchema } from '@afterhours/shared/features/arcade';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { api } from '../../core/api';
import { useLiveEvent } from '../../core/live';
import { confetti } from '../../fun';
import { Avatar, Doodle } from '../../kit';
import { useHouses } from './rounds/useRounds';
import s from './arcade.module.css';

const BG = { reaction: 'var(--pink)', hexbin: 'var(--sky)', memory: 'var(--lime)' } as const;

export default function ArcadeScene() {
  const q = useQuery({ queryKey: ['arcade', 'top', 5], queryFn: () => api.get('/api/arcade/top?limit=5', TopResponseSchema), refetchInterval: 15_000 });
  useLiveEvent('arcade.top', () => void q.refetch());
  const houses = useHouses();
  const reduce = useReducedMotion();
  const [rec, setRec] = useState<ArcadeRecord | null>(null);
  useLiveEvent('arcade.record', (r) => {
    setRec(r);
    if (!reduce) confetti({ count: 120, y: 0.5 });
  });
  useEffect(() => {
    if (!rec) return;
    const t = window.setTimeout(() => setRec(null), 7000);
    return () => window.clearTimeout(t);
  }, [rec]);
  return (
    <div className={s.scene}>
      <h2 className={s.sceneTitle}>arcade high scores</h2>
      <div className={s.boards}>
        {q.data?.boards.map((b, i) => (
          <div key={b.game} className={s.board} style={{ background: BG[b.game], rotate: `${(i - 1) * 1.5}deg` }}>
            <span className={s.boardHead}>{ARCADE_GAMES[b.game].title}</span>
            {b.entries.map((e) => (
              <div key={e.attendeeId} className={s.boardRow}>
                <span>#{e.rank}</span>
                <Avatar config={e.avatar} size={40} />
                <span className={s.boardNick}>{e.nickname}</span>
                <span>{e.label}</span>
              </div>
            ))}
            {b.entries.length === 0 && <span className={s.boardRow}>no scores yet</span>}
          </div>
        ))}
      </div>
      {houses.data && houses.data.round > 0 && (
        <div className={s.houses}>
          <span className={s.housesHead}>houses, round {houses.data.round}</span>
          {[...houses.data.houses]
            .sort((a, b) => a.rank - b.rank || a.id - b.id)
            .map((h) => (
              <motion.div key={h.id} layout className={s.houseChip} style={{ background: `var(--${h.tone})` }}>
                <span>#{h.rank}</span>
                <Doodle name={h.glyph} size={36} />
                <span className={s.boardNick}>{h.name}</span>
                <span>{h.points}</span>
              </motion.div>
            ))}
        </div>
      )}
      <AnimatePresence>
        {rec && (
          <motion.div className={s.record} initial={{ opacity: 0, scale: 1.2 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
            <span className={s.recordBig}>NEW #1</span>
            <Avatar config={rec.avatar} size={160} />
            <span className={s.recordText}>
              {rec.nickname}: {rec.label} on {ARCADE_GAMES[rec.game].title}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
