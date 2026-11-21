/*
  The four winds: a compass dial with a rune at each point. N = slip I's top edge, E = right, S = bottom,
  W = left. A found wind lights its rune in gold; the cursed north (read upside down) burns violet-red.
*/
import { EDGE_RUNE } from '@afterhours/shared/features/cipher';
import type { SlipEdge } from '@afterhours/shared/morse-slip';
import s from './cipher.module.css';

const AT: Record<SlipEdge, [number, number]> = { top: [100, 30], right: [170, 100], bottom: [100, 170], left: [30, 100] };
/** A small original rune per wind (engraved strokes, not letters from any alphabet). */
const RUNE: Record<SlipEdge, string> = {
  top: 'M0 -12V12M0 -12L8 -4M0 -12L-8 -4',
  right: 'M-10 0H10M10 0L2 -8M10 0L2 8M-4 -8V8',
  bottom: 'M0 -12V12M-8 4L0 12L8 4M-7 -6H7',
  left: 'M10 0H-10M-10 0L-2 -8M-10 0L-2 8M4 -8L4 8',
};

export function Compass({ found, cursed, flash }: { found: Record<SlipEdge, boolean>; cursed: boolean; flash?: SlipEdge | null }) {
  const n = Object.values(found).filter(Boolean).length;
  return (
    <figure className={s.compass} aria-label={`${n} of 4 winds found`} data-testid="compass">
      <svg viewBox="0 0 200 200" role="img">
        <circle cx={100} cy={100} r={92} className={s.dialRing} />
        <circle cx={100} cy={100} r={84} className={s.dialRingThin} />
        <circle cx={100} cy={100} r={52} className={s.dialRingThin} />
        {/* the rose */}
        <path d="M100 40L108 92L160 100L108 108L100 160L92 108L40 100L92 92Z" className={s.dialRose} />
        <path d="M100 66L104 96L134 100L104 104L100 134L96 104L66 100L96 96Z" className={s.dialRoseIn} />
        <text x={100} y={105} textAnchor="middle" className={s.dialCount}>
          {n}/4
        </text>
        {(Object.keys(AT) as SlipEdge[]).map((e) => {
          const [x, y] = AT[e];
          const lit = found[e];
          const isCursed = e === 'top' && cursed;
          return (
            <g key={e} transform={`translate(${x} ${y})`} className={`${s.rune} ${lit ? (isCursed ? s.runeCursed : s.runeLit) : ''} ${flash === e ? s.runeFlash : ''}`} data-testid={`rune-${e}`} data-lit={lit ? 'yes' : 'no'}>
              <circle r={22} className={s.runeDisc} />
              <path d={RUNE[e]} className={s.runeMark} />
              <text y={e === 'top' ? -28 : e === 'bottom' ? 36 : 4} x={e === 'left' ? -34 : e === 'right' ? 34 : 0} textAnchor="middle" className={s.runeLetter}>
                {EDGE_RUNE[e].compass}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
