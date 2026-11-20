/*
  Card: an engraved ticket. Gold rule with an inner hairline (the double rule) and a star in each corner.
    <Card tone="sun" tape>...</Card>
    <Card press onClick={...}>tappable</Card>
  Tape: (kept for the API) a star seal set into the top rule; Torn: a stub with a perforated edge.
  `tilt` is accepted for compatibility and ignored: the engraved style sits straight.
*/
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import type { Tone } from './Button';
import { CornerStars, Star4 } from './Ornament';
import s from './kit.module.css';

export function Tape({ side = 'center' }: { side?: 'center' | 'left' | 'right'; color?: 'sun' | 'pink' | 'sky' | 'lime' }) {
  const c = [s.tape, side === 'left' ? s['tape-left'] : side === 'right' ? s['tape-right'] : ''];
  return (
    <span className={c.filter(Boolean).join(' ')} aria-hidden="true">
      <Star4 size={14} />
    </span>
  );
}

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  tone?: Tone;
  /** Rotation in degrees. */
  tilt?: number;
  tape?: boolean | 'left' | 'right';
  tapeColor?: 'sun' | 'pink' | 'sky' | 'lime';
  halftone?: boolean;
  /** Pad the content (default true). */
  pad?: boolean;
  lift?: boolean;
  flat?: boolean;
  /** Tappable: squishes on press. */
  press?: boolean;
  children?: ReactNode;
}

export function Card({ tone = 'paper', tilt: _tilt, tape, tapeColor, halftone, pad = true, lift, flat, press, className, style, children, ...rest }: CardProps) {
  const cn = [s.card, s[`tone-${tone}`], pad ? s['card-pad'] : '', halftone ? s['card-halftone'] : '', lift ? s['card-lift'] : '', flat ? s['card-flat'] : '', press ? s['card-press'] : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <div data-ground={tone === 'paper' ? 'parchment' : undefined} {...rest} className={cn} style={style as CSSProperties} role={press && !rest.role ? 'button' : rest.role} tabIndex={press ? 0 : rest.tabIndex}>
      {!flat && <CornerStars size={9} inset={9} />}
      {tape && <Tape side={tape === true ? 'center' : tape} color={tapeColor} />}
      {children}
    </div>
  );
}

export function Torn({ tone = 'tangerine', className, style, children }: { tone?: Tone; className?: string; style?: CSSProperties; children?: ReactNode }) {
  return (
    <div className={`${s.torn} ${s[`tone-${tone}`]} ${className ?? ''}`} style={style}>
      {children}
    </div>
  );
}
