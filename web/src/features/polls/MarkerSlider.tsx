/*
  MarkerSlider: a draggable marker on an inked track. The marker is a little
  face that changes with the value; every step it crosses ticks (sound + haptic).
  Pointer events only, so it works with finger, mouse and pen. Keyboard: arrows.
*/
import { motion, useReducedMotion } from 'motion/react';
import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react';
import { haptics, sfx } from '../../fun';
import s from './polls.module.css';

export function MarkerSlider({ min, max, value, onChange, face, label }: { min: number; max: number; value: number; onChange: (v: number) => void; face: (v: number) => string; label: string }) {
  const reduce = useReducedMotion();
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  const steps = Math.max(1, max - min);
  const pct = ((value - min) / steps) * 100;

  const move = (clientX: number) => {
    const el = track.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
    const v = Math.round(min + t * steps);
    if (v !== value) {
      onChange(v);
      sfx.note(520 + ((v - min) / steps) * 640, 40, 'square');
      haptics.tick();
    }
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(true);
    move(e.clientX);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const v = Math.min(max, Math.max(min, value + d));
    if (v !== value) {
      onChange(v);
      sfx.tick();
      haptics.tick();
    }
  };

  return (
    <div
      className={s.marker}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      onPointerDown={down}
      onPointerMove={(e) => drag && move(e.clientX)}
      onPointerUp={() => setDrag(false)}
      onPointerCancel={() => setDrag(false)}
      onKeyDown={key}
    >
      <div className={s.markerTrack} ref={track}>
        <motion.div className={s.markerFill} initial={false} animate={{ width: `${pct}%` }} transition={reduce ? { duration: 0.05 } : { type: 'spring', stiffness: 520, damping: 34 }} />
        {Array.from({ length: steps + 1 }, (_, i) => (
          <span key={i} className={`${s.markerTick} ${min + i <= value ? s.markerTickOn : ''}`} style={{ left: `${(i / steps) * 100}%` }} aria-hidden="true" />
        ))}
        <motion.div
          className={s.markerThumb}
          initial={false}
          animate={{ left: `${pct}%`, scale: drag ? 1.22 : 1, rotate: drag ? (pct - 50) / 5 : -4 }}
          transition={reduce ? { duration: 0.05 } : { type: 'spring', stiffness: 520, damping: 22 }}
        >
          <motion.span key={face(value)} className={s.markerFace} initial={reduce ? false : { scale: 0.4, rotate: -25 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 700, damping: 14 }}>
            {face(value)}
          </motion.span>
          <span className={s.markerStem} aria-hidden="true" />
        </motion.div>
      </div>
    </div>
  );
}
