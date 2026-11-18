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
import { type SlipDesign, type SlipLayout, layoutSlip } from '../../../../shared/src/morse-slip';
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
  edges: Partial<Record<'bottom' | 'right' | 'top' | 'left', { word: string; morse: string } | null>>;
}

/** Print-endpoint item -> SlipDesign (the word if there is one, else the raw Morse). */
export function designFromPrintItem(item: SlipPrintItem, size?: { widthMm: number; heightMm: number }): SlipDesign {
  const strips: SlipDesign['strips'] = {};
  for (const edge of ['bottom', 'right', 'top', 'left'] as const) {
    const e = item.edges[edge];
    if (e) strips[edge] = e.word?.trim() ? e.word : e.morse;
  }
  return { strips, number: item.slipNo, kitId: item.kitId ?? undefined, ...size };
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
      <text x={MARGIN + 27} y={MARGIN + 4.2} fontFamily="'Bowlby One', 'Arial Black', sans-serif" fontSize={4.2}>
        after hours, morse slips
      </text>
      <text x={MARGIN + 27} y={MARGIN + 9} fontFamily="'Shantell Sans', cursive" fontWeight={700} fontSize={3}>
        {title ? `${title}, ` : ''}page {page} of {pages}. print at 100 %, cut on the marks
      </text>
      {placed.map((p, i) => (
        <g key={i}>
          <CropMarks x={p.x} y={p.y} w={p.layout.widthMm} h={p.layout.heightMm} />
          <g transform={`translate(${p.x} ${p.y})`}>
            <SlipArt layout={p.layout} />
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
            A4, {cols * rows} per page. print at 100 % (actual size), black ink on plain white paper, then cut on the marks.
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
