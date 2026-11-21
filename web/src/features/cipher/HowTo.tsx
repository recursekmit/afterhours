/*
  Short looping how-to drawings, one per kind of trial. Pure SVG + CSS keyframes; with reduced motion they
  hold still on the frame that explains the most.
*/
import type { SlipEdge } from '@afterhours/shared/morse-slip';
import s from './cipher.module.css';

/** A slip turning a quarter at a time; the strip at the bottom of the view is the one you read. */
function Turn({ edge }: { edge?: SlipEdge | null }) {
  const rot = edge === 'right' ? 90 : edge === 'top' ? 180 : edge === 'left' ? 270 : 0;
  return (
    <svg viewBox="0 0 120 80" className={s.howSvg} aria-hidden="true">
      <rect x={6} y={60} width={108} height={14} className={s.howBand} />
      <g className={edge ? s.howFixed : s.howTurn} style={edge ? { transform: `rotate(${-rot}deg)` } : undefined}>
        <rect x={34} y={18} width={52} height={36} rx={2} className={s.howSlip} />
        <rect x={40} y={47} width={40} height={4} className={s.howStripOn} />
        <rect x={40} y={21} width={40} height={4} className={s.howStrip} />
        <rect x={37} y={24} width={4} height={24} className={s.howStrip} />
        <rect x={79} y={24} width={4} height={24} className={s.howStrip} />
      </g>
      <text x={60} y={71} textAnchor="middle" className={s.howText}>
        the bottom strip is read
      </text>
    </svg>
  );
}

function Tap() {
  return (
    <svg viewBox="0 0 120 80" className={s.howSvg} aria-hidden="true">
      <rect x={30} y={44} width={60} height={22} rx={4} className={s.howWood} />
      <circle cx={60} cy={38} r={13} className={`${s.howKnob} ${s.howPress}`} />
      <g className={s.howPips}>
        <rect x={20} y={10} width={8} height={6} rx={3} />
        <rect x={32} y={10} width={20} height={6} rx={3} />
        <rect x={56} y={10} width={8} height={6} rx={3} />
        <rect x={68} y={10} width={20} height={6} rx={3} />
        <rect x={92} y={10} width={8} height={6} rx={3} />
      </g>
    </svg>
  );
}

function Listen() {
  return (
    <svg viewBox="0 0 120 80" className={s.howSvg} aria-hidden="true">
      <circle cx={34} cy={40} r={16} className={`${s.howLamp} ${s.howBlink}`} />
      <path d="M58 40h8M74 40h22" className={s.howCode} />
      <text x={78} y={66} textAnchor="middle" className={s.howText}>
        short, long: read the chart
      </text>
    </svg>
  );
}

function Sort() {
  return (
    <svg viewBox="0 0 120 80" className={s.howSvg} aria-hidden="true">
      {['N', 'E', 'S', 'W'].map((l, i) => (
        <g key={l} className={s.howSortItem} style={{ animationDelay: `${i * 0.25}s` }}>
          <rect x={8 + i * 27} y={18} width={22} height={18} rx={2} className={s.howSlip} />
          <text x={19 + i * 27} y={31} textAnchor="middle" className={s.howText}>
            {l}
          </text>
        </g>
      ))}
      <text x={60} y={60} textAnchor="middle" className={s.howText}>
        decode all four, then sort them a to z
      </text>
    </svg>
  );
}

function Swap() {
  return (
    <svg viewBox="0 0 120 80" className={s.howSvg} aria-hidden="true">
      <rect x={14} y={24} width={36} height={24} rx={2} className={`${s.howSlip} ${s.howSwapA}`} />
      <rect x={70} y={24} width={36} height={24} rx={2} className={`${s.howSlip} ${s.howSwapB}`} />
      <text x={60} y={68} textAnchor="middle" className={s.howText}>
        you scan theirs, they scan yours
      </text>
    </svg>
  );
}

export type HowKind = 'turn' | 'tap' | 'listen' | 'sort' | 'swap';

export function HowTo({ kind, edge }: { kind: HowKind; edge?: SlipEdge | null }) {
  return <figure className={s.howTo}>{kind === 'turn' ? <Turn edge={edge} /> : kind === 'tap' ? <Tap /> : kind === 'listen' ? <Listen /> : kind === 'sort' ? <Sort /> : <Swap />}</figure>;
}
