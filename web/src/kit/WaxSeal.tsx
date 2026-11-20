/*
  WaxSeal: a blob of sealing wax pressed with a glyph (trail stamps, letters, sealed announcements).
    <WaxSeal glyph="map" size={64} seed={3} />
    <WaxSeal glyph="star" press />        // entrance: the seal is pressed into the page
  The rim is irregular (seeded, so a seal looks the same every render); the glyph sits in a pressed ring.
*/
import { motion, useReducedMotion } from 'motion/react';
import type { CSSProperties } from 'react';
import { Doodle, type IconName } from './Doodle';

function rim(seed: number): string {
  const n = 18;
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 44 + ((seed * 7 + i * 13) % 5) - (i % 3 === 0 ? 2.5 : 0);
    pts.push(`${(50 + Math.cos(a) * r).toFixed(1)} ${(50 + Math.sin(a) * r).toFixed(1)}`);
  }
  return `M${pts.join('L')}Z`;
}

export function WaxSeal({ glyph, size = 64, seed = 1, press = false, tilt = 0, className, style }: { glyph: IconName; size?: number; seed?: number; press?: boolean; tilt?: number; className?: string; style?: CSSProperties }) {
  const reduce = useReducedMotion();
  const g = Math.round(size * 0.42);
  return (
    <motion.span
      className={className}
      style={{ position: 'relative', display: 'inline-grid', placeItems: 'center', width: size, height: size, flex: 'none', rotate: tilt, ...style }}
      initial={press ? (reduce ? { opacity: 0 } : { scale: 1.6, opacity: 0 }) : false}
      animate={press ? { scale: 1, opacity: 1 } : undefined}
      transition={{ type: 'spring', stiffness: 420, damping: 16 }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 100 100" width={size} height={size} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
        <path d={rim(seed)} fill="rgb(40 8 10 / 0.45)" transform="translate(2 4)" />
        <path d={rim(seed)} fill="url(#ah-wax)" stroke="var(--wax-dark)" strokeWidth="1.5" strokeLinejoin="round" />
        {/* the pressed ring: a shadowed groove and its lit lip */}
        <circle cx="50" cy="50" r="31" fill="var(--wax)" stroke="var(--wax-dark)" strokeWidth="3" />
        <circle cx="50.8" cy="51.4" r="31" fill="none" stroke="var(--wax-light)" strokeWidth="1.2" opacity="0.7" />
        <ellipse cx="38" cy="30" rx="12" ry="6" fill="#fff" opacity="0.13" transform="rotate(-30 38 30)" />
      </svg>
      <span style={{ position: 'relative', display: 'grid', placeItems: 'center', filter: 'drop-shadow(0 1px 0 rgb(255 180 160 / 0.35))' }}>
        <Doodle name={glyph} size={g} stroke="var(--wax-dark)" fill="rgb(60 6 10 / 0.35)" strokeWidth={2.6} />
      </span>
    </motion.span>
  );
}
