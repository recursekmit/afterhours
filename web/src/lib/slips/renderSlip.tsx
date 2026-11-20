/*
  A Morse slip as crisp SVG, drawn straight from layoutSlip() geometry (mm units),
  so what prints is exactly what the scanner expects.

    <SlipSvg layout={layoutSlip(design)} />            real size (85 x 55 mm on paper)
    <SlipSvg layout={...} displayWidth="100%" />        scaled for screens
    <SlipArt layout={...} />                            the bare <g>, for sheets

  Black ink on white, heavy frame, bullseye finders, generous quiet zones.
  Personality lives only in the middle (never in a band): the Recurse mark,
  the slip number, "after hours" and a little "turn me" doodle.
*/
import type { CSSProperties } from 'react';
import { type SlipLayout, type SymbolShape } from '@afterhours/shared/morse-slip';
import logo from '../../assets/brand/recurse-logo-black.png';
import { TicketSlipArt } from './TicketSlip';

const INK = '#000';
const PAPER = '#fff';

function Sym({ s }: { s: SymbolShape }) {
  if (s.kind === 'dot') return <circle cx={s.cx} cy={s.cy} r={s.r} />;
  const r = Math.min(s.w, s.h) / 2;
  return <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={r} ry={r} />;
}

/** The slip contents in mm, origin top-left. */
export function SlipArt({ layout: L, cutLine = false, screen = false }: { layout: SlipLayout; cutLine?: boolean; screen?: boolean }) {
  if (L.ticket) return <TicketSlipArt layout={L} cutLine={cutLine} screen={screen} />;
  return <PlainSlipArt layout={L} cutLine={cutLine} />;
}

function PlainSlipArt({ layout: L, cutLine = false }: { layout: SlipLayout; cutLine?: boolean }) {
  const { outer: o, inner: n } = L.frame;
  const { logo: lg, number: nb, doodle: dd, area } = L.decor;
  const cx = dd.x + dd.w / 2;
  const cy = dd.y + dd.h * 0.4;
  const R = dd.w * 0.25;
  const hand = "'IM Fell English', 'EB Garamond', Georgia, serif";
  const display = "'Cinzel', 'Trajan Pro', 'Times New Roman', serif";
  return (
    <g>
      <rect x={0} y={0} width={L.widthMm} height={L.heightMm} fill={PAPER} />
      {cutLine && <rect x={0.1} y={0.1} width={L.widthMm - 0.2} height={L.heightMm - 0.2} fill="none" stroke="#999" strokeWidth={0.15} strokeDasharray="1 1" />}
      <path
        fillRule="evenodd"
        fill={INK}
        d={`M${o.x} ${o.y}h${o.w}v${o.h}h${-o.w}z M${n.x} ${n.y}v${n.h}h${n.w}v${-n.h}z`}
      />
      <g fill={INK}>
        {L.finders.map((f, i) => (
          <g key={i}>
            <circle cx={f.cx} cy={f.cy} r={f.r - f.ring / 2} fill="none" stroke={INK} strokeWidth={f.ring} />
            <circle cx={f.cx} cy={f.cy} r={f.dotR} />
          </g>
        ))}
        {L.strips.map((s) => (
          <g key={s.edge} data-edge={s.edge}>
            {s.symbols.map((sym, i) => (
              <Sym key={i} s={sym} />
            ))}
          </g>
        ))}
      </g>
      {/* personality, inside the bands only */}
      <image href={logo} x={lg.x} y={lg.y} width={lg.w} height={lg.h} preserveAspectRatio="xMinYMid meet" />
      {L.number && (
        <text x={nb.x + nb.w} y={nb.y + nb.h * 0.82} textAnchor="end" fontFamily={display} fontSize={nb.h * 0.95} fill={INK}>
          {L.number}
        </text>
      )}
      <text x={area.x} y={area.y + area.h * 0.62} fontFamily={display} fontSize={Math.min(5.2, area.h * 0.2)} fill={INK}>
        after hours
      </text>
      <text x={area.x} y={area.y + area.h * 0.62 + Math.min(4, area.h * 0.15)} fontFamily={hand} fontWeight={700} fontSize={Math.min(2.6, area.h * 0.1)} fill={INK}>
        {L.kitId ? `kit ${L.kitId.toLowerCase()}, ` : ''}the bottom edge counts
      </text>
      <g fill="none" stroke={INK} strokeWidth={0.55} strokeLinecap="round" strokeLinejoin="round">
        {/* a wobbly three-quarter turn with an arrow head */}
        <path d={`M${cx + R} ${cy + 0.3} C ${cx + R} ${cy + R * 1.15}, ${cx - R * 1.1} ${cy + R * 1.1}, ${cx - R} ${cy} S ${cx - R * 0.2} ${cy - R * 1.1}, ${cx + R * 0.15} ${cy - R}`} />
        <path d={`M${cx - R * 0.35} ${cy - R * 1.45} L ${cx + R * 0.2} ${cy - R} L ${cx - R * 0.3} ${cy - R * 0.55}`} />
      </g>
      <text x={cx} y={dd.y + dd.h * 0.94} textAnchor="middle" fontFamily={hand} fontWeight={700} fontSize={Math.min(2.4, dd.w * 0.17)} fill={INK}>
        turn me
      </text>
    </g>
  );
}

export interface SlipSvgProps {
  layout: SlipLayout;
  /** CSS width; default is the real printed size in mm */
  displayWidth?: string | number;
  cutLine?: boolean;
  /** use the small screen art for ticket slips (print uses the full-resolution art) */
  screen?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

/** A whole slip, at real size unless displayWidth is given. */
export function SlipSvg({ layout, displayWidth, cutLine, screen, className, style, title }: SlipSvgProps) {
  const w = displayWidth ?? `${layout.widthMm}mm`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${layout.widthMm} ${layout.heightMm}`}
      width={w}
      height={displayWidth === undefined ? `${layout.heightMm}mm` : undefined}
      className={className}
      style={{ display: 'block', aspectRatio: `${layout.widthMm} / ${layout.heightMm}`, height: 'auto', ...style }}
      role="img"
      aria-label={title ?? `Morse slip ${layout.number ?? ''}: ${layout.strips.map((s) => `${s.edge} ${s.text ?? s.morse}`).join(', ')}`}
      data-testid="slip-svg"
    >
      <SlipArt layout={layout} cutLine={cutLine} screen={screen} />
    </svg>
  );
}
