/*
  Floaters: emoji that drift up the screen. Mounted as the attendee overlay
  (your phone) and the projector overlay (big, from everyone).
*/
import { useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveEvent } from '../../core/live';
import { EMOJI, emitFloat, onFloat } from './floats';
import s from './reactions.module.css';
import type { ReactionKind } from '@afterhours/shared/features/reactions';

interface Float {
  id: number;
  kind: ReactionKind;
  x: number;
  dur: number;
  size: number;
  sway: number;
  sway2: number;
  rot: number;
  spin: boolean;
}

/** Projector rain keeps to the side margins so the scene in the middle stays readable. */
const sideX = () => (Math.random() < 0.5 ? 1 + Math.random() * 12 : 87 + Math.random() * 12);

export function Floaters({ variant }: { variant: 'phone' | 'screen' }) {
  const [floats, setFloats] = useState<Float[]>([]);
  const seq = useRef(0);
  const reduce = useReducedMotion();
  const cap = variant === 'screen' ? 70 : 24;

  const spawn = useCallback(
    (kind: ReactionKind, count: number, local: boolean) => {
      const n = Math.min(count, variant === 'screen' ? 10 : 4);
      const made: Float[] = [];
      for (let i = 0; i < n; i++) {
        made.push({
          id: ++seq.current,
          kind,
          x: variant === 'screen' ? sideX() : local ? 8 + Math.random() * 84 : Math.random() * 100,
          dur: (variant === 'screen' ? 5 : 3.4) + Math.random() * 1.8,
          size: variant === 'screen' ? 56 + Math.random() * 44 : 30 + Math.random() * 20,
          sway: (Math.random() - 0.5) * (variant === 'screen' ? 150 : 110),
          sway2: (Math.random() - 0.5) * 130,
          rot: 8 + Math.random() * 22,
          spin: kind === 'party' || kind === 'lol',
        });
      }
      setFloats((l) => [...l, ...made].slice(-cap));
      for (const f of made) window.setTimeout(() => setFloats((l) => l.filter((x) => x.id !== f.id)), f.dur * 1000 + 200);
    },
    [cap, variant],
  );

  useLiveEvent('reactions.burst', (d) => {
    for (const [kind, count] of Object.entries(d.counts) as [ReactionKind, number][]) spawn(kind, count, false);
  });
  useEffect(() => onFloat(spawn), [spawn]);

  return (
    <div className={`${s.floaters} ${variant === 'screen' ? s.screen : ''}`} aria-hidden="true" data-testid="reaction-floaters">
      {floats.map((f) => (
        <span
          key={f.id}
          className={s.float}
          data-kind={f.kind}
          style={{
            left: `${f.x}%`,
            fontSize: f.size,
            animationDuration: `${reduce ? f.dur * 0.6 : f.dur}s`,
            ['--sway' as string]: `${reduce ? 0 : f.sway}px`,
            ['--sway2' as string]: `${reduce ? 0 : f.sway2}px`,
            ['--rot' as string]: `${reduce ? 0 : f.rot}deg`,
            animationName: f.spin && !reduce ? 'rise-spin' : undefined,
          }}
        >
          {EMOJI[f.kind]}
        </span>
      ))}
    </div>
  );
}

export { emitFloat };
