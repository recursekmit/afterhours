/*
  SlipSheet: printable A4 sheets of cut-out Morse slips, crop marks in the gutters.
  Same approach as the kit card sheet (surfaces/admin/KitSheet): a portal overlay
  with a toolbar, body[data-printing] hides the app when printing (global.css),
  and @page A4 with no margins. Each page is one SVG in mm, so slips print at
  exact size: set the print dialog to 100 % / "actual size", never "fit to page".

    <SlipSheet slips={[{ strips: { bottom: 'code', right: 'hi' }, number: 1 }]} title="hunt, set A" onClose={...} />
*/
import { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { KIT_SLIP_SIZE, SLIP_SIZES, SLIP_TICKETS, type SlipDesign, type SlipLayout, type SlipTicket, layoutSlip } from '@afterhours/shared/morse-slip';
import logo from '../../assets/brand/recurse-logo-black.png';
import { Button } from '../../kit';
import { SlipArt } from './renderSlip';
import s from './slips.module.css';

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 10;
const HEADER = 12;
const GUTTER = 8;
const MARK = 4;

/** One slip as the trails console's slip-print endpoint returns it (structural, see shared/features/hunt SlipPrintSheet). */
export interface SlipPrintItem {
  slipNo: number;
  kitId?: string | null;
  /** unique sets: the printed copy's serial ("no. 037") */
  serial?: number | null;
  /** unique sets: the copy's own ticket design (balanced over the four); 'mixed' printing uses it */
  ticket?: SlipTicket | null;
  edges: Partial<Record<'bottom' | 'right' | 'top' | 'left', { word: string; morse: string } | null>>;
}

/** How a set prints: one of the four tickets, all four in turn, or the plain 85 x 55 card. */
export type PrintAs = SlipTicket | 'mixed' | 'card';

/**
 * Print-endpoint item -> SlipDesign (the word if there is one, else the raw Morse).
 * Kit slips print as tickets by default (176 x 80); 'mixed' cycles the four designs by slip number.
 */
export function designFromPrintItem(item: SlipPrintItem, size?: { widthMm: number; heightMm: number }, as: PrintAs = 'mixed'): SlipDesign {
  const strips: SlipDesign['strips'] = {};
  for (const edge of ['bottom', 'right', 'top', 'left'] as const) {
    const e = item.edges[edge];
    if (e) strips[edge] = e.word?.trim() ? e.word : e.morse;
  }
  const serial = item.serial ?? undefined;
  if (as === 'card') return { strips, number: item.slipNo, kitId: item.kitId ?? undefined, serial, ...(size ?? SLIP_SIZES.card) };
  // mixed: a unique copy's own design (all four, balanced per set), else design N mod 4 by slip number
  const ticket = as === 'mixed' ? (item.ticket ?? (SLIP_TICKETS[(Math.max(1, item.slipNo) - 1) % SLIP_TICKETS.length] as SlipTicket)) : as;
  const dims = size ?? SLIP_SIZES[KIT_SLIP_SIZE];
  return { strips, number: item.slipNo, kitId: item.kitId ?? undefined, serial, widthMm: dims.widthMm, heightMm: dims.heightMm, ticket };
}

interface Placed {
  layout: SlipLayout;
  x: number;
  y: number;
}

/** Pages of placed slips (all slips on a sheet share the first slip's size). */
export function paginate(layouts: SlipLayout[]): { pages: Placed[][]; cols: number; rows: number } {
  const W = layouts[0]?.widthMm ?? 85;
  const H = layouts[0]?.heightMm ?? 55;
  const cols = Math.max(1, Math.floor((PAGE_W - 2 * MARGIN + GUTTER) / (W + GUTTER)));
  const rows = Math.max(1, Math.floor((PAGE_H - 2 * MARGIN - HEADER + GUTTER) / (H + GUTTER)));
  const gridW = cols * W + (cols - 1) * GUTTER;
  const gridH = rows * H + (rows - 1) * GUTTER;
  const x0 = (PAGE_W - gridW) / 2;
  const y0 = MARGIN + HEADER + (PAGE_H - 2 * MARGIN - HEADER - gridH) / 2;
  const per = cols * rows;
  const pages: Placed[][] = [];
  layouts.forEach((layout, i) => {
    const k = i % per;
    if (k === 0) pages.push([]);
    (pages[pages.length - 1] as Placed[]).push({ layout, x: x0 + (k % cols) * (W + GUTTER), y: y0 + Math.floor(k / cols) * (H + GUTTER) });
  });
  return { pages, cols, rows };
}

function CropMarks({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const g = 1.2; // gap between the mark and the slip corner
  const l = MARK;
  const d = [
    // each corner: one horizontal and one vertical tick pointing away from the slip
    `M${x - g} ${y}h${-l} M${x} ${y - g}v${-l}`,
    `M${x + w + g} ${y}h${l} M${x + w} ${y - g}v${-l}`,
    `M${x + w + g} ${y + h}h${l} M${x + w} ${y + h + g}v${l}`,
    `M${x - g} ${y + h}h${-l} M${x} ${y + h + g}v${l}`,
  ].join(' ');
  return <path d={d} stroke="#000" strokeWidth={0.2} fill="none" />;
}

export function SlipPage({ placed, title, page, pages }: { placed: Placed[]; title: string; page: number; pages: number }) {
  // unique copies: say which serials are on this page, so a stack can be checked before it is cut
  const serials = [...new Set(placed.map((p) => p.layout.serial).filter((x): x is string => x !== null))];
  const copies = serials.length === 0 ? '' : serials.length === 1 ? `no. ${serials[0]}, ` : `no. ${serials[0]} to ${serials[serials.length - 1]}, `;
  return (
    <svg
      className={s.sheetPage}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${PAGE_W} ${PAGE_H}`}
      width={`${PAGE_W}mm`}
      height={`${PAGE_H}mm`}
      role="img"
      aria-label={`slip sheet page ${page} of ${pages}`}
      data-testid="slip-sheet-page"
    >
      <rect width={PAGE_W} height={PAGE_H} fill="#fff" />
      <image href={logo} x={MARGIN} y={MARGIN - 1} height={7} width={24} preserveAspectRatio="xMinYMid meet" />
      <text x={MARGIN + 27} y={MARGIN + 4.2} fontFamily="'Cinzel', 'Times New Roman', serif" fontWeight={700} fontSize={4.2}>
        AFTER HOURS, MORSE SLIPS
      </text>
      <text x={MARGIN + 27} y={MARGIN + 9} fontFamily="'IM Fell English', Georgia, serif" fontStyle="italic" fontSize={3.2}>
        {title ? `${title}, ` : ''}
        {copies}page {page} of {pages}. print at 100 %, cut on the marks{placed[0]?.layout.ticket ? ' and round the notched corners' : ''}
      </text>
      {placed.map((p, i) => (
        <g key={i}>
          <CropMarks x={p.x} y={p.y} w={p.layout.widthMm} h={p.layout.heightMm} />
          <g transform={`translate(${p.x} ${p.y})`}>
            <SlipArt layout={p.layout} cutLine={Boolean(p.layout.ticket)} />
          </g>
        </g>
      ))}
    </svg>
  );
}

export interface SlipSheetProps {
  slips: SlipDesign[];
  title?: string;
  onClose: () => void;
}

export function SlipSheet({ slips, title = '', onClose }: SlipSheetProps) {
  const layouts = useMemo(() => slips.map(layoutSlip), [slips]);
  const { pages, cols, rows } = useMemo(() => paginate(layouts), [layouts]);
  const problems = layouts.flatMap((l) => l.errors.map((e) => `slip ${l.number ?? '?'}: ${e}`));
  useEffect(() => {
    document.body.dataset.printing = 'slips';
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      delete document.body.dataset.printing;
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return createPortal(
    <div className={s.sheetOverlay} id="print-root" role="dialog" aria-label="Printable Morse slips">
      <div className={s.sheetBar}>
        <div>
          <h2 className={s.sheetTitle}>{slips.length} morse slips</h2>
          <p className={s.sheetNote}>
            A4, {cols * rows} per page. print at 100 % (actual size), then cut on the marks.{' '}
            {layouts[0]?.ticket ? 'tickets print in colour on matte paper (no gloss: glare hides the dots); trim the notched corners on the dashed line.' : 'black ink on plain white paper.'}
            {problems.length > 0 && <b className={s.sheetWarn}> {problems.length} strip(s) left blank: {problems.join(' ')}</b>}
          </p>
        </div>
        <div className={s.sheetBtns}>
          <Button tone="lime" icon="print" onClick={() => window.print()}>
            print
          </Button>
          <Button tone="paper" onClick={onClose}>
            back
          </Button>
        </div>
      </div>
      <div className={s.sheetPages}>
        {pages.map((p, i) => (
          <SlipPage key={i} placed={p} title={title} page={i + 1} pages={pages.length} />
        ))}
      </div>
    </div>,
    document.body,
  );
}
