/*
  Engraved ornaments, the tickets' line art as small SVGs (gold, currentColor by default):
    <Star4 size={18} />                 the four-point star
    <CornerFlourish corner="tl" />      a scroll + star for card corners
    <CornerStars />                     four small stars pinned to a positioned parent's corners
    <Rule />                            a horizontal double rule with a star in the middle
    <Divider />                         the ticket's vertical star divider
    <Plaque>after hours</Plaque>        the notched cartouche around a title
  Pure decoration: aria-hidden, no pointer events.
*/
import type { CSSProperties, ReactNode } from 'react';
import s from './ornament.module.css';

const starPath = (cx: number, cy: number, r: number, k = 0.2) =>
  `M${cx} ${cy - r}L${cx + r * k} ${cy - r * k}L${cx + r} ${cy}L${cx + r * k} ${cy + r * k}L${cx} ${cy + r}L${cx - r * k} ${cy + r * k}L${cx - r} ${cy}L${cx - r * k} ${cy - r * k}Z`;

export function Star4({ size = 16, className, style, color = 'currentColor' }: { size?: number; className?: string; style?: CSSProperties; color?: string }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} className={className} style={style} aria-hidden="true">
      <path d={starPath(10, 10, 10)} fill={color} />
      <circle cx={10} cy={10} r={1.2} fill="var(--paper, #000)" opacity={0.6} />
    </svg>
  );
}

export function CornerFlourish({ corner = 'tl', size = 34, className }: { corner?: 'tl' | 'tr' | 'br' | 'bl'; size?: number; className?: string }) {
  const rot = { tl: 0, tr: 90, br: 180, bl: 270 }[corner];
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} className={className} style={{ transform: `rotate(${rot}deg)` }} aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth={1.1} strokeLinecap="round">
        <path d="M4 30 V10 Q4 4 10 4 H30" />
        <path d="M9 24 Q9 9 24 9" opacity={0.7} />
        <path d="M14 4 q4 6 0 10 q-3 -4 0 -10" opacity={0.85} />
        <path d="M4 14 q6 4 10 0 q-4 -3 -10 0" opacity={0.85} />
      </g>
      <path d={starPath(11, 11, 6)} fill="currentColor" />
    </svg>
  );
}

export function CornerStars({ size = 10, inset = 7 }: { size?: number; inset?: number }) {
  const st: CSSProperties = { width: size, height: size };
  return (
    <span className={s.corners} style={{ '--o-inset': `${inset}px` } as CSSProperties} aria-hidden="true">
      <Star4 size={size} className={`${s.cs} ${s.tl}`} style={st} />
      <Star4 size={size} className={`${s.cs} ${s.tr}`} style={st} />
      <Star4 size={size} className={`${s.cs} ${s.br}`} style={st} />
      <Star4 size={size} className={`${s.cs} ${s.bl}`} style={st} />
    </span>
  );
}

export function Rule({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <span className={`${s.rule} ${className ?? ''}`} style={style} aria-hidden="true">
      <i />
      <Star4 size={14} />
      <i />
    </span>
  );
}

export function Divider({ height = 120, className }: { height?: number; className?: string }) {
  return (
    <svg viewBox={`0 0 16 ${height}`} width={16} height={height} className={className} aria-hidden="true">
      <line x1={8} y1={4} x2={8} y2={height - 4} stroke="currentColor" strokeWidth={1} />
      <path d={starPath(8, height / 2, 7)} fill="currentColor" />
      <path d={starPath(8, 6, 4)} fill="currentColor" />
      <path d={starPath(8, height - 6, 4)} fill="currentColor" />
    </svg>
  );
}

/** The notched cartouche from the tickets, around a title. */
export function Plaque({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <span className={`${s.plaque} ${className ?? ''}`} style={style}>
      {children}
    </span>
  );
}
