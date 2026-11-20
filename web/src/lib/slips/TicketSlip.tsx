/*
  A Morse slip printed as one of the four engraved after hours tickets (design/tickets).

  The scanner's geometry comes first and is untouched (layoutSlip, same SLIP_SPEC ratios):
    cut line with concave notched corners, cream quiet margin
    -> dark ink frame (the ticket's ground colour)
    -> cream ribbon: the four finder bullseyes and the four Morse bands, dark ink, nothing else
    -> the engraved panel (art only here, never in a band or its quiet gap), with a gold double rule,
       the art's own plaque ("after hours", the slip number), star divider and square frame
       (Recurse mark, a small QR, or the "turn me" glyph).
  Polarity: dark symbols on a cream ribbon. That is the same dark-on-light the scanner already reads
  (luminance contrast 13.7:1 for #131d37 on #f3e8cc, against 9.9:1 for gold #e3c48a on navy), so the
  threshold, components and finder checks need no change. See docs/SLIPS.md, "ticket slips".
*/
import { TICKET_NOTCH_MM, type SlipLayout, type SymbolShape } from '@afterhours/shared/morse-slip';
import { useId, useMemo } from 'react';
import { encode } from 'uqr';
import logoWhite from '../../assets/brand/recurse-logo-white.png';
import { TICKET_ART, TICKET_CREAM } from './tickets';

const DISPLAY = "'Cinzel', 'Trajan Pro', 'Times New Roman', serif";
const HAND = "'IM Fell English', 'EB Garamond', Georgia, serif";

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
/** Unique copies name their slip in roman numerals on the plaque: "no. 037, slip II". */
const roman = (n: string) => ROMAN[(Number(n) || 0) - 1] ?? n;

function Sym({ s }: { s: SymbolShape }) {
  if (s.kind === 'dot') return <circle cx={s.cx} cy={s.cy} r={s.r} />;
  const r = Math.min(s.w, s.h) / 2;
  return <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={r} ry={r} />;
}

/** The cut outline: a rectangle with a concave quarter-circle notch at each corner. */
export function ticketOutline(W: number, H: number, n = TICKET_NOTCH_MM, inset = 0): string {
  const a = inset;
  const b = n - inset;
  return [
    `M${a + b} ${a}`,
    `H${W - a - b}`,
    `A${b} ${b} 0 0 0 ${W - a} ${a + b}`,
    `V${H - a - b}`,
    `A${b} ${b} 0 0 0 ${W - a - b} ${H - a}`,
    `H${a + b}`,
    `A${b} ${b} 0 0 0 ${a} ${H - a - b}`,
    `V${a + b}`,
    `A${b} ${b} 0 0 0 ${a + b} ${a}`,
    'Z',
  ].join(' ');
}

/** Chamfered rectangle (the engraved panel and its rules). */
function chamfer(x: number, y: number, w: number, h: number, c: number): string {
  return `M${x + c} ${y}H${x + w - c}L${x + w} ${y + c}V${y + h - c}L${x + w - c} ${y + h}H${x + c}L${x} ${y + h - c}V${y + c}Z`;
}

/** Four-point star, the tickets' ornament. */
function star(cx: number, cy: number, r: number): string {
  const k = r * 0.22;
  return `M${cx} ${cy - r}L${cx + k} ${cy - k}L${cx + r} ${cy}L${cx + k} ${cy + k}L${cx} ${cy + r}L${cx - k} ${cy + k}L${cx - r} ${cy}L${cx - k} ${cy - k}Z`;
}

function QrPath({ text, x, y, size, ink }: { text: string; x: number; y: number; size: number; ink: string }) {
  const { path, n } = useMemo(() => {
    const { data } = encode(text, { ecc: 'M', border: 0 });
    const parts: string[] = [];
    data.forEach((row, yy) => {
      let xx = 0;
      while (xx < row.length) {
        if (row[xx]) {
          let w = 1;
          while (xx + w < row.length && row[xx + w]) w++;
          parts.push(`M${xx} ${yy}h${w}v1h${-w}z`);
          xx += w;
        } else xx++;
      }
    });
    return { path: parts.join(''), n: data.length };
  }, [text]);
  const q = 2;
  const k = size / (n + 2 * q);
  return (
    <g transform={`translate(${x} ${y}) scale(${k})`} shapeRendering="crispEdges">
      <rect width={n + 2 * q} height={n + 2 * q} fill={TICKET_CREAM} rx={1} />
      <path d={path} transform={`translate(${q} ${q})`} fill={ink} />
    </g>
  );
}

export function TicketSlipArt({ layout: L, cutLine = false, screen = false }: { layout: SlipLayout; cutLine?: boolean; screen?: boolean }) {
  const uid = useId().replace(/:/g, '');
  const art = TICKET_ART[L.ticket ?? 'armillary'];
  const W = L.widthMm;
  const H = L.heightMm;
  const { outer: o, inner: n } = L.frame;
  const p = L.decor.area;
  const ink = art.ground;
  const gold = art.ink;
  const fw = art.fieldW;
  const fh = art.fieldH;
  const pl = { x: art.plaque.x * fw, y: art.plaque.y * fh, w: art.plaque.w * fw, h: art.plaque.h * fh };
  const sq = { x: art.square.x * fw, y: art.square.y * fh, w: art.square.w * fw, h: art.square.h * fh };
  const sqIn = Math.min(sq.w, sq.h) * 0.62;
  const sqX = sq.x + (sq.w - sqIn) / 2;
  const sqY = sq.y + (sq.h - sqIn) / 2;
  const c = 1.6;
  return (
    <g data-ticket={art.id}>
      <defs>
        <clipPath id={`panel-${uid}`}>
          <path d={chamfer(p.x, p.y, p.w, p.h, c)} />
        </clipPath>
      </defs>
      {/* the cut ticket: cream margin with notched corners */}
      <path d={ticketOutline(W, H)} fill={TICKET_CREAM} />
      {cutLine && <path d={ticketOutline(W, H, TICKET_NOTCH_MM, 0.1)} fill="none" stroke="#999" strokeWidth={0.15} strokeDasharray="1 1" />}
      {/* the scanner's frame, in the ticket's own dark ink */}
      <path fillRule="evenodd" fill={ink} d={`M${o.x} ${o.y}h${o.w}v${o.h}h${-o.w}z M${n.x} ${n.y}v${n.h}h${n.w}v${-n.h}z`} />
      {/* finders and the four Morse bands, dark on the cream ribbon */}
      <g fill={ink}>
        {L.finders.map((f, i) => (
          <g key={i}>
            <circle cx={f.cx} cy={f.cy} r={f.r - f.ring / 2} fill="none" stroke={ink} strokeWidth={f.ring} />
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
      {/* the engraved panel: art only in here */}
      <path d={chamfer(p.x, p.y, p.w, p.h, c)} fill={ink} />
      <g clipPath={`url(#panel-${uid})`}>
        <svg x={p.x} y={p.y} width={p.w} height={p.h} viewBox={`0 0 ${fw} ${fh}`} preserveAspectRatio="xMidYMid slice">
          <image href={screen ? art.fieldSm : art.field} width={fw} height={fh} preserveAspectRatio="none" />
          {/* the plaque: after hours + the slip number */}
          <text x={pl.x + pl.w / 2} y={pl.y + pl.h * 0.5} textAnchor="middle" fontFamily={DISPLAY} fontWeight={700} fontSize={pl.h * 0.3} letterSpacing={pl.h * 0.02} fill={gold}>
            AFTER HOURS
          </text>
          <text x={pl.x + pl.w / 2} y={pl.y + pl.h * 0.78} textAnchor="middle" fontFamily={HAND} fontStyle="italic" fontSize={pl.h * 0.2} fill={gold}>
            {(L.serial
              ? [`no. ${L.serial}`, L.number ? `slip ${roman(L.number.replace(/^#/, ''))}` : null]
              : [L.number ? `no. ${L.number.replace(/^#/, '')}` : null, L.kitId ? `kit ${L.kitId.toLowerCase()}` : null]
            )
              .filter(Boolean)
              .join(', ') || 'recurse, kmit'}
          </text>
          {/* the square frame */}
          {L.square === 'qr' && L.qr ? (
            <QrPath text={L.qr} x={sqX} y={sqY} size={sqIn} ink={ink} />
          ) : L.square === 'glyph' ? (
            <g fill="none" stroke={gold} strokeWidth={sqIn * 0.035} strokeLinecap="round" strokeLinejoin="round">
              <path d={`M${sqX + sqIn * 0.82} ${sqY + sqIn * 0.45} A${sqIn * 0.32} ${sqIn * 0.32} 0 1 1 ${sqX + sqIn * 0.62} ${sqY + sqIn * 0.16}`} />
              <path d={`M${sqX + sqIn * 0.5} ${sqY + sqIn * 0.06} L${sqX + sqIn * 0.63} ${sqY + sqIn * 0.16} L${sqX + sqIn * 0.52} ${sqY + sqIn * 0.29}`} />
              <text x={sqX + sqIn / 2} y={sqY + sqIn * 0.98} textAnchor="middle" fontFamily={HAND} fontStyle="italic" fontSize={sqIn * 0.17} fill={gold} stroke="none">
                turn me
              </text>
            </g>
          ) : (
            <image href={logoWhite} x={sqX} y={sqY} width={sqIn} height={sqIn} preserveAspectRatio="xMidYMid meet" opacity={0.92} />
          )}
        </svg>
      </g>
      {/* gold double rule and corner stars, inside the panel */}
      <g fill="none" stroke={gold} strokeLinejoin="miter">
        <path d={chamfer(p.x + 0.7, p.y + 0.7, p.w - 1.4, p.h - 1.4, c * 0.7)} strokeWidth={0.32} />
        <path d={chamfer(p.x + 1.25, p.y + 1.25, p.w - 2.5, p.h - 2.5, c * 0.45)} strokeWidth={0.16} />
      </g>
      <g fill={gold}>
        <path d={star(p.x + 2.6, p.y + 2.6, 1.3)} />
        <path d={star(p.x + p.w - 2.6, p.y + 2.6, 1.3)} />
        <path d={star(p.x + p.w - 2.6, p.y + p.h - 2.6, 1.3)} />
        <path d={star(p.x + 2.6, p.y + p.h - 2.6, 1.3)} />
      </g>
    </g>
  );
}
