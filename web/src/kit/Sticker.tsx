/*
  Sticker: an enamel pin drawn from pure data (shape + colour + glyph): a struck-gold rim, a pool of
  coloured enamel with a glassy shine, and the glyph raised in gold. Locked pins are an empty iron blank.
    <Sticker def={def} size={96} tilt={-6} />
    <Sticker def={def} locked />            // an iron blank with a lock
    <Sticker def={def} slap />              // entrance: pressed onto the page
*/
import type { PaletteColor, StickerDef, StickerShape } from '@afterhours/shared';
import { motion, useReducedMotion } from 'motion/react';
import type { CSSProperties } from 'react';
import { Doodle } from './Doodle';
import s from './kit.module.css';

/* enamel: fixed colours (tokens.css), so a pin looks the same on the night ground and on parchment */
const FILL: Record<PaletteColor, string> = {
  tangerine: 'var(--enamel-tangerine)',
  lime: 'var(--enamel-lime)',
  pink: 'var(--enamel-pink)',
  grape: 'var(--enamel-grape)',
  sky: 'var(--enamel-sky)',
  sun: 'var(--enamel-sun)',
  paper: 'var(--enamel-paper)',
  ink: 'var(--enamel-ink)',
};

function poly(n: number, rOuter: number, rInner: number, rot = -Math.PI / 2): string {
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = rot + (i * Math.PI) / n;
    const r = i % 2 ? rInner : rOuter;
    pts.push(`${i ? 'L' : 'M'}${(50 + Math.cos(a) * r).toFixed(1)} ${(50 + Math.sin(a) * r).toFixed(1)}`);
  }
  return `${pts.join('')}z`;
}

const SHAPES: Record<StickerShape, string> = {
  circle: 'M50 12a38 38 0 1 0 .1 0z',
  star: poly(5, 42, 22),
  burst: poly(13, 43, 33),
  blob: 'M50 12C72 8 90 26 88 50 86 74 72 90 48 88 26 87 10 72 12 48 14 28 28 14 50 12z',
  ticket: 'M12 26H88V40A10 10 0 0 0 88 60V74H12V60A10 10 0 0 0 12 40z',
  shield: 'M50 9L85 22V52Q85 77 50 91Q15 77 15 52V22z',
  heart: 'M50 87C8 58 9 27 30 19 42 14 50 24 50 31 50 24 58 14 70 19 91 27 92 58 50 87z',
  square: 'M18 15H82Q87 15 87 20V80Q87 85 82 85H18Q13 85 13 80V20Q13 15 18 15z',
};

type StickerLike = Pick<StickerDef, 'shape' | 'color' | 'glyph'> & Partial<Pick<StickerDef, 'title'>>;

export interface StickerProps {
  def: StickerLike;
  size?: number;
  /** Rotation in degrees. */
  tilt?: number;
  locked?: boolean;
  /** Entrance animation: pressed onto the page. */
  slap?: boolean;
  className?: string;
  style?: CSSProperties;
}

const INSET = 'translate(50 50) scale(0.84) translate(-50 -50)';

export function Sticker({ def, size = 96, tilt = 0, locked = false, slap = false, className, style }: StickerProps) {
  const reduce = useReducedMotion();
  const d = SHAPES[def.shape];
  const body = locked ? 'var(--enamel-iron)' : FILL[def.color];
  const glyphSize = Math.round(size * (def.shape === 'ticket' ? 0.34 : 0.44));
  const light = def.color === 'paper' || def.color === 'sun';
  return (
    <motion.div
      className={`${s.sticker} ${className ?? ''}`}
      style={{ width: size, height: size, rotate: tilt, ...style }}
      initial={slap ? (reduce ? { opacity: 0 } : { scale: 1.8, y: -30, opacity: 0 }) : false}
      animate={slap ? { scale: 1, rotate: tilt, y: 0, opacity: 1 } : undefined}
      transition={{ type: 'spring', stiffness: 520, damping: 20, mass: 0.8 }}
    >
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true" style={{ overflow: 'visible' }}>
        {/* the pin's shadow on the page */}
        <path d={d} fill="rgb(0 0 0 / 0.4)" stroke="rgb(0 0 0 / 0.4)" strokeWidth="9" strokeLinejoin="round" transform="translate(1.5 4)" />
        {/* struck rim */}
        <path d={d} fill={locked ? 'var(--enamel-iron)' : 'url(#ah-pin-metal)'} stroke={locked ? 'var(--enamel-iron-rim)' : 'url(#ah-pin-metal)'} strokeWidth="8" strokeLinejoin="round" />
        {/* enamel pool */}
        <path d={d} fill={body} stroke={locked ? 'var(--enamel-iron-rim)' : 'var(--enamel-line)'} strokeWidth="1.6" strokeLinejoin="round" strokeDasharray={locked ? '4 4' : undefined} transform={INSET} />
        {!locked && <path d={d} fill="url(#ah-pin-gloss)" transform="translate(50 50) scale(0.8) translate(-50 -50)" />}
      </svg>
      <span className={s.stickerGlyph} style={{ width: glyphSize, height: glyphSize }}>
        <Doodle
          name={locked ? 'lock' : def.glyph}
          size={glyphSize}
          stroke={locked ? 'var(--enamel-iron-rim)' : light ? 'var(--enamel-ink)' : 'var(--enamel-gold)'}
          fill={locked ? 'none' : 'var(--enamel-glyph-fill)'}
          strokeWidth={2.4}
        />
      </span>
    </motion.div>
  );
}
