import { describe, expect, it } from 'vitest';
import { MORSE_TABLE } from './features/morse';
import {
  SLIP_EDGES,
  SLIP_SPEC,
  SlipScanSchema,
  decodeMorse,
  edgeCapacity,
  edgeForQuarterTurns,
  encodeStrip,
  encodeWord,
  layoutSlip,
  looksLikeMorse,
  normaliseMorse,
  reverseReading,
} from './morse-slip';

describe('morse helpers', () => {
  it('encodes a word with the standard gaps, from the shared table', () => {
    const e = encodeWord('cat');
    expect(e.morse).toBe(`${MORSE_TABLE.C} ${MORSE_TABLE.A} ${MORSE_TABLE.T}`);
    expect(e.text).toBe('CAT');
    expect(e.elements.map((x) => x.symbol).join('')).toBe('-.-..--');
    expect(e.elements.map((x) => x.gapBefore)).toEqual([0, 1, 1, 1, 3, 1, 3]);
    // C = 3+1+1+1+3+1+1 = 11, A = 1+1+3 = 5, T = 3, two letter gaps = 6
    expect(e.units).toBe(25);
  });

  it('encodes several words with a 7 unit gap', () => {
    const e = encodeWord('hi  yo');
    expect(e.morse).toBe('.... .. / -.-- ---');
    expect(e.text).toBe('HI YO');
    expect(e.elements.filter((x) => x.gapBefore === 7)).toHaveLength(1);
  });

  it('refuses characters outside the table', () => {
    expect(() => encodeWord('')).toThrow();
    expect(() => encodeWord('!!')).toThrow();
  });

  it('normalises sloppy Morse', () => {
    expect(normaliseMorse('  -.-.   ---  -.. .  ')).toBe('-.-. / --- -.. .');
    expect(normaliseMorse('-.-. --- -.. .')).toBe('-.-. --- -.. .');
    expect(normaliseMorse('–·–· — ')).toBe('-.-. -');
    expect(normaliseMorse('... | ---')).toBe('... / ---');
    expect(normaliseMorse('.. /  / --')).toBe('.. / --');
    expect(normaliseMorse('')).toBe('');
  });

  it('decodes Morse, null on any unknown letter', () => {
    expect(decodeMorse('-.-. --- -.. .')).toBe('CODE');
    expect(decodeMorse('.... .. / -.-- ---')).toBe('HI YO');
    expect(decodeMorse('........')).toBeNull();
    expect(decodeMorse('')).toBeNull();
  });

  it('reverses a reading the way an upside-down strip reads', () => {
    expect(reverseReading('-.-. ---')).toBe('--- .-.-');
    expect(reverseReading(reverseReading('.... .. / -.-- ---'))).toBe('.... .. / -.-- ---');
    expect(reverseReading('.-')).toBe('-.');
    // NET = "-. . -", upside down it reads "- . .-" = TEA: a planted secret
    expect(decodeMorse(reverseReading(encodeWord('net').morse))).toBe('TEA');
  });

  it('takes a word or raw Morse as strip input', () => {
    expect(looksLikeMorse('.- -...')).toBe(true);
    expect(looksLikeMorse('lab')).toBe(false);
    expect(encodeStrip('.-.. .- -...').text).toBe('LAB');
    expect(encodeStrip('........').text).toBeNull();
    expect(encodeStrip('lab').morse).toBe('.-.. .- -...');
  });

  it('validates the scan payload shape', () => {
    expect(SlipScanSchema.safeParse({ primary: { morse: '.-', text: 'A', confidence: 0.9, position: 'bottom' }, others: [], at: 1 }).success).toBe(true);
    expect(SlipScanSchema.safeParse({ primary: { morse: '.-', text: 'A', confidence: 2, position: 'bottom' }, others: [], at: 1 }).success).toBe(false);
  });
});

describe('layoutSlip', () => {
  const words = { bottom: 'code', right: 'hi', top: 'lab', left: 'sun' };
  const L = layoutSlip({ strips: words, number: 7 });

  it('has a frame, four identical finders and four bands', () => {
    expect(L.widthMm).toBe(85);
    expect(L.heightMm).toBe(55);
    expect(L.finders).toHaveLength(4);
    expect(new Set(L.finders.map((f) => `${f.r}/${f.ring}/${f.dotR}`)).size).toBe(1);
    expect(L.strips.map((s) => s.edge)).toEqual(['bottom', 'right', 'top', 'left']);
    expect(L.number).toBe('#07');
    expect(L.errors).toEqual([]);
  });

  it('puts every symbol inside its band and inside the frame', () => {
    for (const s of L.strips) {
      for (const sym of s.symbols) {
        const r = sym.kind === 'dot' ? { x: sym.cx - sym.r, y: sym.cy - sym.r, w: 2 * sym.r, h: 2 * sym.r } : sym;
        expect(r.x).toBeGreaterThanOrEqual(s.band.x - 1e-6);
        expect(r.y).toBeGreaterThanOrEqual(s.band.y - 1e-6);
        expect(r.x + r.w).toBeLessThanOrEqual(s.band.x + s.band.w + 1e-6);
        expect(r.y + r.h).toBeLessThanOrEqual(s.band.y + s.band.h + 1e-6);
      }
    }
  });

  it('keeps bands, finders and decor apart', () => {
    const rects = [...SLIP_EDGES.map((e) => L.bands[e]), ...L.finders.map((f) => ({ x: f.cx - f.r, y: f.cy - f.r, w: 2 * f.r, h: 2 * f.r })), L.decor.area];
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        const overlap = a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;
        expect(overlap, `${i} vs ${j}`).toBe(false);
      }
  });

  it('places each strip along its own edge, upright from that edge', () => {
    const at = (e: string) => L.strips.find((s) => s.edge === e)!;
    expect(at('bottom').band.y).toBeGreaterThan(40);
    expect(at('top').band.y).toBeLessThan(15);
    expect(at('right').band.x).toBeGreaterThan(70);
    expect(at('left').band.x).toBeLessThan(15);
    expect(at('bottom').readDir).toEqual({ x: 1, y: 0 });
    expect(at('top').readDir).toEqual({ x: -1, y: 0 });
    expect(at('right').readDir).toEqual({ x: 0, y: -1 });
    expect(at('left').readDir).toEqual({ x: 0, y: 1 });
    // the first symbol of the right strip (H = ....) is the lowest one: it reads bottom to top
    const right = at('right').symbols;
    const ys = right.map((s) => (s.kind === 'dot' ? s.cy : s.y));
    expect(ys[0]).toBeGreaterThan(ys[ys.length - 1]!);
    // vertical bands carry vertical dashes
    const lefty = at('left').symbols.find((s) => s.kind === 'dash');
    expect(lefty && lefty.kind === 'dash' && lefty.h > lefty.w).toBe(true);
  });

  it('sizes dots from the word length, capped and floored', () => {
    const short = layoutSlip({ strips: { bottom: 'e' } });
    expect(short.strips[0]!.unitMm).toBe(SLIP_SPEC.maxUnitMm);
    const long = layoutSlip({ strips: { left: 'recurse' } });
    expect(long.strips).toHaveLength(0);
    expect(long.errors[0]).toMatch(/too long/);
    const mid = layoutSlip({ strips: { bottom: 'recurse' } });
    expect(mid.strips[0]!.unitMm).toBeGreaterThan(SLIP_SPEC.minUnitMm);
    expect(edgeCapacity('bottom')).toBeGreaterThan(edgeCapacity('left'));
  });

  it('maps quarter turns to edges', () => {
    expect([0, 1, 2, 3, 4, -1].map(edgeForQuarterTurns)).toEqual(['bottom', 'right', 'top', 'left', 'bottom', 'left']);
  });
});
