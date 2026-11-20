// Morse slips (docs/SLIPS.md): the wire types, the Morse helpers and the exact
// printed geometry. Pure TypeScript, no DOM, so the server (matching readings),
// the renderer (printing) and the scanner (reading) all share one source of truth.
//
//   encodeWord('cat')          symbols + gap units, from the shared Morse table
//   normaliseMorse(' -.-.  .- ')  canonical "-.-. .-"
//   decodeMorse('-.-. .- -')   'CAT' (null if any letter is not in the table)
//   reverseReading(morse)      what the upside-down (top) strip reads as naively
//   layoutSlip(design)         every rectangle and circle on the slip, in mm
//
// Import with a relative path (this file is not behind a package subpath):
//   web:    import { layoutSlip } from '../lib/slips'   (re-exported there)
//   server: import { normaliseMorse } from '../../../../shared/src/morse-slip'
import { z } from 'zod';
import { MORSE_TABLE, decodePattern, normaliseWord } from './features/morse';

// ---------------------------------------------------------------------------
// Wire types (the contract in docs/SLIPS.md, verbatim)
// ---------------------------------------------------------------------------

export type Symbol = '.' | '-';

export interface StripReading {
  /** letters separated by ' ', words by ' / ', e.g. "-.-. --- -.. ." */
  morse: string;
  /** decoded with the shared table; null if any letter is invalid */
  text: string | null;
  /** 0..1 */
  confidence: number;
  position: 'bottom' | 'top' | 'other';
}

export interface SlipScan {
  /** the bottom strip, per the reading rule */
  primary: StripReading | null;
  /** every other strip found (top strip as seen, i.e. reversed) */
  others: StripReading[];
  /** performance.now() of the frame */
  at: number;
}

export const StripReadingSchema = z.object({
  morse: z.string().max(400),
  text: z.string().max(80).nullable(),
  confidence: z.number().min(0).max(1),
  position: z.enum(['bottom', 'top', 'other']),
});

export const SlipScanSchema = z.object({
  primary: StripReadingSchema.nullable(),
  others: z.array(StripReadingSchema).max(3),
  at: z.number(),
});

// ---------------------------------------------------------------------------
// Morse helpers
// ---------------------------------------------------------------------------

/** One printed symbol and the gap before it, in units (0 for the first). */
export interface MorseElement {
  symbol: Symbol;
  gapBefore: 0 | 1 | 3 | 7;
}

export interface EncodedStrip {
  /** canonical Morse, e.g. "-.-. .- -" */
  morse: string;
  /** decoded text, e.g. "CAT" (null if the strip was given as Morse that is not all letters) */
  text: string | null;
  elements: MorseElement[];
  /** total length in units: dot 1, dash 3, gaps 1 / 3 / 7 */
  units: number;
}

const MORSE_LIKE = /^[\s.\-·•∙‧_−–—/|]+$/;

/** True if the string is written in dots and dashes rather than letters. */
export function looksLikeMorse(s: string): boolean {
  return MORSE_LIKE.test(s) && /[.\-·•∙‧_−–—]/.test(s);
}

/**
 * Canonical Morse: '.' and '-', letters separated by one space, words by ' / '.
 * Accepts typographic dots and dashes (· • − – — _), '/' or '|' or 3+ spaces between words.
 */
export function normaliseMorse(str: string): string {
  const s = str
    .replace(/[·•∙‧]/g, '.')
    .replace(/[_−–—]/g, '-')
    .replace(/\|/g, '/')
    .replace(/[^.\-/\s]/g, '')
    .replace(/\s{3,}/g, ' / ');
  return s
    .split('/')
    .map((w) => w.trim().split(/\s+/).filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' / ');
}

/** '-.-. .- -' -> 'CAT'; words come back separated by a space. null if empty or any letter is unknown. */
export function decodeMorse(str: string): string | null {
  const m = normaliseMorse(str);
  if (!m) return null;
  const words = m.split(' / ').map((w) => w.split(' ').map(decodePattern).join(''));
  const text = words.join(' ');
  return text.includes('?') ? null : text;
}

/**
 * What a strip reads as when seen upside down and read left to right:
 * the whole symbol sequence (and its gaps) reversed. "-.-. ---" -> "--- .-.-".
 */
export function reverseReading(morse: string): string {
  return [...normaliseMorse(morse)].reverse().join('');
}

function elementsFromMorse(morse: string): MorseElement[] {
  const out: MorseElement[] = [];
  morse.split(' / ').forEach((word, wi) => {
    word.split(' ').forEach((letter, li) => {
      [...letter].forEach((sym, si) => {
        const gapBefore: MorseElement['gapBefore'] = out.length === 0 ? 0 : si > 0 ? 1 : li > 0 ? 3 : wi > 0 ? 7 : 0;
        out.push({ symbol: sym as Symbol, gapBefore });
      });
    });
  });
  return out;
}

function unitsOf(elements: MorseElement[]): number {
  return elements.reduce((n, e) => n + e.gapBefore + (e.symbol === '.' ? 1 : 3), 0);
}

/** 'cat' -> symbols with gap units. Several words are allowed (7-unit gap). Throws on characters outside the table. */
export function encodeWord(word: string): EncodedStrip {
  const words = word
    .trim()
    .split(/\s+/)
    .map(normaliseWord)
    .filter(Boolean);
  if (words.length === 0) throw new Error('Nothing to encode');
  const morse = words
    .map((w) =>
      [...w]
        .map((c) => {
          const p = MORSE_TABLE[c];
          if (!p) throw new Error(`No Morse for "${c}"`);
          return p;
        })
        .join(' '),
    )
    .join(' / ');
  const elements = elementsFromMorse(morse);
  return { morse, text: words.join(' '), elements, units: unitsOf(elements) };
}

/** A strip from what an organiser typed: a word ("lab") or raw Morse (".-.. .- -..."). */
export function encodeStrip(input: string): EncodedStrip {
  if (looksLikeMorse(input)) {
    const morse = normaliseMorse(input);
    if (!morse) throw new Error('Nothing to encode');
    const elements = elementsFromMorse(morse);
    return { morse, text: decodeMorse(morse), elements, units: unitsOf(elements) };
  }
  return encodeWord(input);
}

// ---------------------------------------------------------------------------
// Slip geometry
// ---------------------------------------------------------------------------

/**
 * Which edge of the slip is at the bottom of the view when that strip is read.
 * 'right' means: turn the slip a quarter clockwise so its right edge comes to the bottom.
 */
export type SlipEdge = 'bottom' | 'right' | 'top' | 'left';
export const SLIP_EDGES: readonly SlipEdge[] = ['bottom', 'right', 'top', 'left'];

/**
 * Fixed physical proportions, in mm. The scanner measures the finder marks and
 * derives every band position from these ratios, so print and scan cannot drift.
 */
export const SLIP_SPEC = {
  defaultWidthMm: 85,
  defaultHeightMm: 55,
  /** white quiet zone between the cut edge and the frame */
  marginMm: 2.5,
  /** heavy ink frame */
  frameMm: 1.5,
  /** gap between the inside of the frame and the finders / bands */
  innerGapMm: 1,
  /** strip band height = finder mark diameter */
  bandMm: 6,
  /** gap between a finder mark and the end of a strip band */
  finderGapMm: 1,
  /** finder mark: ring outer diameter = bandMm, ring stroke, centre dot diameter */
  finderRingMm: 1,
  finderDotMm: 2.4,
  /** dot diameter = unit, capped here so the band keeps quiet space around it */
  maxUnitMm: 2.4,
  /** below this a strip is still printed but flagged as hard to scan */
  warnUnitMm: 1.25,
  /** below this layoutSlip refuses the strip (word too long for the edge) */
  minUnitMm: 0.9,
} as const;

export const SLIP_SIZES = {
  /** The after hours ticket (2.2 : 1): the default for kit slips. Short edges still carry 3+ letters. */
  ticket: { widthMm: 176, heightMm: 80, label: 'ticket, 176 x 80 (the after hours ticket)' },
  /**
   * The morse slip kit ticket: the after hours ticket at 2.2 : 1, small enough that one participant's four
   * tickets (I-IV) stack on one A4 page with crop marks. Short edges carry 42 mm of band (32 units at 1.3 mm).
   */
  quad: { widthMm: 146, heightMm: 66, label: 'kit ticket, 146 x 66 (four per A4 page)' },
  card: { widthMm: 85, heightMm: 55, label: 'business card, 85 x 55' },
  square: { widthMm: 66, heightMm: 66, label: 'square, 66 x 66 (longer side words)' },
  big: { widthMm: 105, heightMm: 74, label: 'A7, 105 x 74 (stick-on, long words)' },
} as const;
export type SlipSize = keyof typeof SLIP_SIZES;
/** What kit slips print as unless the console picks otherwise. */
export const KIT_SLIP_SIZE: SlipSize = 'ticket';

/**
 * The four engraved ticket designs (design/tickets). A ticket slip keeps the exact scanner geometry:
 * cream quiet margin, dark ink frame, a cream ribbon carrying the finders and the four Morse bands,
 * and the engraved art only inside the middle panel.
 */
export const SLIP_TICKETS = ['armillary', 'wave', 'ginkgo', 'ruins'] as const;
export type SlipTicket = (typeof SLIP_TICKETS)[number];
/** What the ticket's square frame shows. */
export const SLIP_SQUARES = ['logo', 'qr', 'glyph'] as const;
export type SlipSquare = (typeof SLIP_SQUARES)[number];
/** Concave notch at each cut corner of a ticket slip, mm. Stays clear of the frame (margin 2.5 mm). */
export const TICKET_NOTCH_MM = 3;

export interface SlipDesign {
  /** A word or raw Morse per edge. Missing or empty = blank edge. */
  strips: Partial<Record<SlipEdge, string>>;
  widthMm?: number;
  heightMm?: number;
  /** Printed small, e.g. 7 -> "#07". */
  number?: number | string;
  /** Printed small next to the number. */
  kitId?: string;
  /** Unique slips: the printed copy's serial, shown as "no. 037" (the number then reads as "slip 2"). */
  serial?: number;
  /** Print as one of the engraved tickets. Missing = the plain black-on-white slip. */
  ticket?: SlipTicket;
  /** The ticket's square frame: the Recurse mark (default), a small QR of `qr`, or the "turn me" glyph. */
  square?: SlipSquare;
  qr?: string;
}

export const SlipDesignSchema = z.object({
  strips: z.partialRecord(z.enum(['bottom', 'right', 'top', 'left']), z.string().max(60)),
  widthMm: z.number().min(40).max(200).optional(),
  heightMm: z.number().min(40).max(200).optional(),
  number: z.union([z.number().int(), z.string().max(12)]).optional(),
  kitId: z.string().max(16).optional(),
  serial: z.number().int().min(0).max(9999).optional(),
  ticket: z.enum(SLIP_TICKETS).optional(),
  square: z.enum(SLIP_SQUARES).optional(),
  qr: z.string().max(200).optional(),
});

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type SymbolShape =
  /** filled circle */
  | { kind: 'dot'; cx: number; cy: number; r: number }
  /** filled capsule, axis aligned, rounded ends of radius min(w, h) / 2 */
  | { kind: 'dash'; x: number; y: number; w: number; h: number };

export interface FinderMark {
  cx: number;
  cy: number;
  /** ring outer radius (= bandMm / 2), ring stroke width, centre dot radius */
  r: number;
  ring: number;
  dotR: number;
}

export interface StripLayout {
  edge: SlipEdge;
  input: string;
  morse: string;
  text: string | null;
  units: number;
  unitMm: number;
  /** the band this strip lives in (slip coordinates) */
  band: Rect;
  symbols: SymbolShape[];
  /** reading direction in slip coordinates when this edge is at the bottom */
  readDir: { x: number; y: number };
}

export interface SlipLayout {
  widthMm: number;
  heightMm: number;
  frame: { outer: Rect; inner: Rect; strokeMm: number };
  finders: FinderMark[];
  /** every band, empty or not */
  bands: Record<SlipEdge, Rect>;
  strips: StripLayout[];
  /** free space in the middle for personality (logo, number, doodle). Never overlaps a band. */
  decor: { area: Rect; logo: Rect; number: Rect; doodle: Rect };
  number: string | null;
  kitId: string | null;
  /** unique slips: the copy's serial, zero padded ("037"), or null */
  serial: string | null;
  /** engraved ticket design, or null for the plain slip */
  ticket: SlipTicket | null;
  square: SlipSquare;
  qr: string | null;
  /** human notes for the generator UI ("left word is long: dots are 1.1 mm") */
  warnings: string[];
  /** strips that could not be laid out (too long for the edge) */
  errors: string[];
}

/**
 * Map a point given in "edge-local" coordinates (as if `edge` were at the bottom,
 * slip turned so that edge is down) back to slip coordinates (as printed, 'bottom' down).
 */
export function edgeToSlip(edge: SlipEdge, x: number, y: number, widthMm: number, heightMm: number): { x: number; y: number } {
  switch (edge) {
    case 'bottom':
      return { x, y };
    case 'top':
      return { x: widthMm - x, y: heightMm - y };
    case 'right':
      // turned a quarter clockwise: local frame is heightMm wide, widthMm tall
      return { x: y, y: heightMm - x };
    case 'left':
      return { x: widthMm - y, y: x };
  }
}

function rectToSlip(edge: SlipEdge, r: Rect, W: number, H: number): Rect {
  const a = edgeToSlip(edge, r.x, r.y, W, H);
  const b = edgeToSlip(edge, r.x + r.w, r.y + r.h, W, H);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Local band (edge at the bottom) for a slip whose local width/height are lw x lh. */
function localBand(lw: number, lh: number): Rect {
  const S = SLIP_SPEC;
  const inset = S.marginMm + S.frameMm + S.innerGapMm;
  const x0 = inset + S.bandMm + S.finderGapMm;
  return { x: x0, y: lh - inset - S.bandMm, w: lw - 2 * x0, h: S.bandMm };
}

/** Longest strip (in units) an edge can carry at the minimum dot size. */
export function edgeCapacity(edge: SlipEdge, widthMm: number = SLIP_SPEC.defaultWidthMm, heightMm: number = SLIP_SPEC.defaultHeightMm): number {
  const lw = edge === 'bottom' || edge === 'top' ? widthMm : heightMm;
  return Math.floor(localBand(lw, 0).w / SLIP_SPEC.minUnitMm);
}

/** Exact geometry of a slip, in mm, origin at the top-left of the slip as printed ('bottom' edge down). */
export function layoutSlip(design: SlipDesign): SlipLayout {
  const S = SLIP_SPEC;
  const W = design.widthMm ?? S.defaultWidthMm;
  const H = design.heightMm ?? S.defaultHeightMm;
  const m = S.marginMm;
  const outer: Rect = { x: m, y: m, w: W - 2 * m, h: H - 2 * m };
  const inner: Rect = { x: m + S.frameMm, y: m + S.frameMm, w: W - 2 * (m + S.frameMm), h: H - 2 * (m + S.frameMm) };
  const fr = S.bandMm / 2;
  const fInset = m + S.frameMm + S.innerGapMm + fr;
  const finders: FinderMark[] = [
    [fInset, fInset],
    [W - fInset, fInset],
    [W - fInset, H - fInset],
    [fInset, H - fInset],
  ].map(([cx, cy]) => ({ cx: cx as number, cy: cy as number, r: fr, ring: S.finderRingMm, dotR: S.finderDotMm / 2 }));

  const bands = {} as Record<SlipEdge, Rect>;
  const strips: StripLayout[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  for (const edge of SLIP_EDGES) {
    const sideways = edge === 'right' || edge === 'left';
    const lw = sideways ? H : W;
    const lh = sideways ? W : H;
    const lb = localBand(lw, lh);
    bands[edge] = rectToSlip(edge, lb, W, H);
    const input = (design.strips[edge] ?? '').trim();
    if (!input) continue;
    let enc: EncodedStrip;
    try {
      enc = encodeStrip(input);
    } catch (e) {
      errors.push(`${edge}: ${(e as Error).message}`);
      continue;
    }
    const unit = Math.min(S.maxUnitMm, lb.w / enc.units);
    if (unit < S.minUnitMm) {
      errors.push(`${edge}: "${input}" is too long for this edge (${enc.units} units, fits ${Math.floor(lb.w / S.minUnitMm)}). use a shorter word or a bigger slip.`);
      continue;
    }
    if (unit < S.warnUnitMm) warnings.push(`${edge}: "${input}" is long, its dots are only ${unit.toFixed(2)} mm. it scans, but hold it close and steady.`);
    const cy = lb.y + lb.h / 2;
    let x = lb.x + (lb.w - enc.units * unit) / 2;
    const symbols: SymbolShape[] = [];
    for (const el of enc.elements) {
      x += el.gapBefore * unit;
      const len = (el.symbol === '.' ? 1 : 3) * unit;
      let shape: SymbolShape;
      if (el.symbol === '.') {
        const c = edgeToSlip(edge, x + unit / 2, cy, W, H);
        shape = { kind: 'dot', cx: round3(c.x), cy: round3(c.y), r: round3(unit / 2) };
      } else {
        const r = rectToSlip(edge, { x, y: cy - unit / 2, w: len, h: unit }, W, H);
        shape = { kind: 'dash', x: round3(r.x), y: round3(r.y), w: round3(r.w), h: round3(r.h) };
      }
      symbols.push(shape);
      x += len;
    }
    const d0 = edgeToSlip(edge, 0, 0, W, H);
    const d1 = edgeToSlip(edge, 1, 0, W, H);
    strips.push({
      edge,
      input,
      morse: enc.morse,
      text: enc.text,
      units: enc.units,
      unitMm: round3(unit),
      band: bands[edge],
      symbols,
      readDir: { x: Math.round(d1.x - d0.x), y: Math.round(d1.y - d0.y) },
    });
  }

  // Decor lives strictly inside the four bands, with a quiet gap.
  const inset = m + S.frameMm + S.innerGapMm + S.bandMm + 1.2;
  const area: Rect = { x: inset, y: inset, w: W - 2 * inset, h: H - 2 * inset };
  const logoH = Math.min(6.5, area.h * 0.28);
  const logoW = (logoH * 464) / 135;
  const logo: Rect = { x: area.x, y: area.y, w: logoW, h: logoH };
  const numW = Math.min(16, area.w * 0.3);
  const number: Rect = { x: area.x + area.w - numW, y: area.y, w: numW, h: logoH };
  const ds = Math.min(area.h * 0.5, 14);
  const doodle: Rect = { x: area.x + area.w - ds, y: area.y + area.h - ds, w: ds, h: ds };
  const num = design.number === undefined || design.number === '' ? null : typeof design.number === 'number' ? `#${String(design.number).padStart(2, '0')}` : String(design.number);

  return {
    widthMm: W,
    heightMm: H,
    frame: { outer, inner, strokeMm: S.frameMm },
    finders,
    bands,
    strips,
    decor: { area, logo, number, doodle },
    number: num,
    kitId: design.kitId?.trim() || null,
    serial: design.serial === undefined ? null : String(design.serial).padStart(3, '0'),
    ticket: design.ticket ?? null,
    square: design.square ?? (design.qr ? 'qr' : 'logo'),
    qr: design.qr?.trim() || null,
    warnings,
    errors,
  };
}

/** Where an attendee holds the slip: which slip edge is at the bottom for a clockwise quarter-turn count. */
export function edgeForQuarterTurns(quarterTurnsClockwise: number): SlipEdge {
  return SLIP_EDGES[((quarterTurnsClockwise % 4) + 4) % 4] as SlipEdge;
}
