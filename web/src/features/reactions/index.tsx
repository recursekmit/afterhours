/*
  Reactions (spec 5.9): the worked example of a WEB feature. It fills four
  slots: a home card (the emoji bar), an attendee overlay (floating emoji),
  a projector overlay (the rain) and a console panel (stats).
  Server side: server/src/features/reactions. Guide: docs/EXTENDING.md.
*/
import { OkSchema } from '@afterhours/shared';
import { REACTION_KINDS, type ReactionKind, ReactionStatsSchema } from '@afterhours/shared/features/reactions';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useRef, useState } from 'react';
import { defineFeature } from '../../core/feature';
import { api, isApiError } from '../../core/api';
import { useLiveEvent } from '../../core/live';
import { haptics } from '../../fun/haptics';
import { sfx } from '../../fun/sfx';
import { Card, Meter, NumberTicker, useToast } from '../../kit';
import { Floaters } from './Floaters';
import { EMOJI, emitFloat } from './floats';
import s from './reactions.module.css';

function ReactionsBar() {
  const toast = useToast();
  const reduce = useReducedMotion();
  const [combo, setCombo] = useState(0);
  const comboTimer = useRef(0);
  const send = (kind: ReactionKind) => {
    emitFloat(kind, 1, true);
    // keep tapping and the pitch climbs with the combo
    setCombo((c) => c + 1);
    window.clearTimeout(comboTimer.current);
    comboTimer.current = window.setTimeout(() => setCombo(0), 1400);
    sfx.note(520 + Math.min(combo, 12) * 55, 70, 'triangle');
    haptics.tick();
    api.post('/api/reactions', { kind }, OkSchema).catch((e: unknown) => {
      if (isApiError(e, 'rate_limited')) toast(e.message, { kind: 'info', title: 'easy there' });
    });
  };
  return (
    <Card tone="paper" tilt={0.8} tape tapeColor="pink">
      <div className={s.bar}>
        <div className={s.barHead}>
          <h3 className={s.barTitle}>hype the room</h3>
          <AnimatePresence>
            {combo >= 3 && (
              <motion.span key="combo" className={s.combo} initial={reduce ? { opacity: 0 } : { scale: 0, rotate: 20 }} animate={{ scale: 1, rotate: -4 }} exit={{ opacity: 0, scale: 0.6 }} transition={{ type: 'spring', stiffness: 600, damping: 14 }}>
                <motion.span key={combo} initial={reduce ? false : { scale: 1.5 }} animate={{ scale: 1 }} style={{ display: 'inline-block' }}>
                  x{combo}
                </motion.span>
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        <div className={s.row}>
          {REACTION_KINDS.map((k, i) => (
            <motion.button
              key={k}
              type="button"
              className={s.pad}
              onPointerDown={() => send(k)}
              aria-label={`send ${k}`}
              whileTap={reduce ? { scale: 0.92 } : { scale: 0.82, rotate: i % 2 ? 8 : -8 }}
              transition={{ type: 'spring', stiffness: 700, damping: 12 }}
            >
              <span className={s.padEmoji}>{EMOJI[k]}</span>
            </motion.button>
          ))}
        </div>
        <p className={s.barHint}>they float up on the big screen too. 25 taps gets you a sticker.</p>
      </div>
    </Card>
  );
}

function ReactionsPanel() {
  const stats = useQuery({
    queryKey: ['reactions', 'stats'],
    queryFn: () => api.get('/api/reactions/stats', ReactionStatsSchema),
    refetchInterval: 3000,
  });
  // A live burst is a good reason to refetch right away.
  useLiveEvent('reactions.burst', () => void stats.refetch());
  const totals = stats.data?.totals ?? {};
  const max = Math.max(1, ...Object.values(totals));
  return (
    <Card tone="paper" tilt={-0.4}>
      <div className={s.stat}>
        <h3 className={s.barTitle}>
          <NumberTicker value={stats.data?.lastMinute ?? 0} /> reactions in the last minute
        </h3>
        {REACTION_KINDS.map((k) => (
          <div key={k} className={s.statRow}>
            <span className={s.statEmoji}>{EMOJI[k]}</span>
            <Meter value={(totals[k] ?? 0) / max} tone="pink" label={k} />
            <NumberTicker value={totals[k] ?? 0} />
          </div>
        ))}
      </div>
    </Card>
  );
}

export const reactions = defineFeature({
  name: 'reactions',
  home: { order: 90, Card: ReactionsBar },
  AttendeeOverlay: () => <Floaters variant="phone" />,
  ScreenOverlay: () => <Floaters variant="screen" />,
  console: { order: 80, label: 'reactions', path: 'reactions', icon: 'flame', Panel: ReactionsPanel },
});
