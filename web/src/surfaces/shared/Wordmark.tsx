/*
  Wordmark: "after hours" struck in engraved gold capitals inside the tickets' notched cartouche,
  a four-point star between the words. Every letter is still a toy: tap it for a note and a glint.
*/
import { motion, useReducedMotion } from 'motion/react';
import { haptics } from '../../fun/haptics';
import { sfx } from '../../fun/sfx';
import s from './wordmark.module.css';

const SCALE = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.5];

function Letter({ ch, i }: { ch: string; i: number }) {
  const reduce = useReducedMotion();
  return (
    <motion.button
      type="button"
      className={s.letter}
      aria-label={ch}
      initial={reduce ? false : { y: -10, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: reduce ? 0 : 0.04 * i }}
      whileTap={reduce ? undefined : { scale: 0.9 }}
      onPointerDown={() => {
        sfx.note(SCALE[(i * 3 + ch.charCodeAt(0)) % SCALE.length] ?? 660, 150, 'triangle');
        haptics.tick();
      }}
    >
      {ch}
    </motion.button>
  );
}

export function Wordmark({ size = 62 }: { size?: number }) {
  return (
    <h1 className={s.wordmark} aria-label="after hours" style={{ fontSize: size * 0.72 }}>
      <span className={s.line} aria-hidden="true">
        {'after'.split('').map((c, i) => (
          <Letter key={`a${i}`} ch={c} i={i} />
        ))}
      </span>
      <span className={s.star} aria-hidden="true">
        <i />
        <svg viewBox="0 0 20 20" width="0.42em" height="0.42em">
          <path d="M10 0L12 8L20 10L12 12L10 20L8 12L0 10L8 8Z" fill="currentColor" />
        </svg>
        <i />
      </span>
      <span className={s.line} aria-hidden="true">
        {'hours'.split('').map((c, i) => (
          <Letter key={`h${i}`} ch={c} i={i + 5} />
        ))}
      </span>
    </h1>
  );
}
