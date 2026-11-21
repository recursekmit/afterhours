/*
  Unique slips: the scanner on the words the generator really hands out (docs/SLIPS.md, "unique slips").
  fixtures/unique-sample.json is generator output (server/src/features/hunt/unique.test.ts checks that):
  slip 1 of every 8th copy of the seeded 80 (four edges each) and two copies of the slip hunt's slip.
  Each copy is laid out as an after hours ticket (176 x 80, the exact scanner geometry), "photographed"
  by the synthetic camera in a 1080p portrait frame under hall conditions, and read by the pipeline
  the phones run.

  Pass bar (same as the other harnesses): >= 95 % correct primaries, 0 wrong (a wrong reading on a
  unique slip could claim someone else's copy), and no reading at all in the 45 degree zone.
*/
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { type SlipEdge, SLIP_SIZES, edgeForQuarterTurns, layoutSlip } from '@afterhours/shared/morse-slip';
import './config';
import sample from './fixtures/unique-sample.json';
import { processFrame } from './pipeline';
import { type CameraOptions, type FloatImage, cameraScene, rasterSlip, rng } from './testing/synth';

// the morse tickets print four per A4 page (SLIP_SIZES.quad, 146 x 66): the smallest ticket, so the hardest case
const T = SLIP_SIZES.quad;
const COPIES = sample.copies.map((c) => {
  const L = layoutSlip({ strips: c.edges as Partial<Record<SlipEdge, string>>, widthMm: T.widthMm, heightMm: T.heightMm, number: c.slip, serial: c.serial });
  return { id: `no. ${String(c.serial).padStart(3, '0')} slip ${c.slip}`, L, print: rasterSlip(L, 10, { seed: c.serial }) as FloatImage };
});

const pm = (r: () => number, a: number) => (r() * 2 - 1) * a;
type Cond = { name: string; make: (r: () => number) => Partial<CameraOptions>; tilt?: number };
const CONDITIONS: Cond[] = [
  { name: 'clean, flat', make: () => ({ blur: 0.6 }) },
  { name: 'tilt up to 25 deg', make: () => ({ blur: 0.7 }), tilt: 25 },
  { name: 'perspective (20 / 15 deg)', make: (r) => ({ pitchDeg: pm(r, 20), yawDeg: pm(r, 15), blur: 0.7 }) },
  { name: 'out of focus (sigma 1.4)', make: () => ({ blur: 1.4 }) },
  { name: 'motion blur (4 px)', make: () => ({ motionBlur: 4, blur: 0.6 }) },
  { name: 'dim hall', make: () => ({ exposure: 0.35, noise: 0.025, blur: 1.0 }) },
  { name: 'low contrast + gradient', make: () => ({ contrast: 0.45, gradient: 0.5, noise: 0.015, blur: 0.8 }) },
  {
    name: 'everything at once',
    make: (r) => ({ pitchDeg: pm(r, 12), yawDeg: pm(r, 10), blur: 1.0, noise: 0.03, exposure: 0.6, gradient: 0.4, shadow: r() < 0.5 ? 0.4 : 0 }),
    tilt: 12,
  },
];

interface Row {
  n: number;
  ok: number;
  wrong: number;
  none: number;
}
const table = new Map<string, Row>();
const zone = { n: 0, read: 0 };
const misses: string[] = [];

function frame(print: FloatImage, q: number, tilt: number, opts: Partial<CameraOptions>, seed: number) {
  const r = rng(seed * 7919 + 13);
  return processFrame(
    cameraScene(print, { slipMm: { w: T.widthMm, h: T.heightMm }, width: 1080, height: 1920, rollDeg: q * 90 + tilt, pxPerMm: 4.6 + r() * 0.9, offset: { x: pm(r, 20), y: pm(r, 80) }, seed, ...opts }),
    seed,
  );
}

describe('unique slips: the scanner reads generated words', () => {
  it('the sample is real: 12 copies, every edge word different', () => {
    expect(COPIES).toHaveLength(12);
    const words = sample.copies.flatMap((c) => Object.values(c.edges));
    expect(new Set(words).size).toBe(words.length);
    for (const c of COPIES) expect(c.L.errors).toEqual([]);
    // dots never smaller than 1.3 mm
    for (const c of COPIES) for (const st of c.L.strips) expect(st.unitMm).toBeGreaterThanOrEqual(1.3);
  });

  for (const [ci, cond] of CONDITIONS.entries()) {
    it(cond.name, () => {
      const row: Row = { n: 0, ok: 0, wrong: 0, none: 0 };
      table.set(cond.name, row);
      for (const [si, c] of COPIES.entries())
        for (let q = 0; q < 4; q++) {
          const seed = 7000 + 1000 * ci + 10 * si + q;
          const r = rng(seed);
          const tilt = cond.tilt ? pm(r, cond.tilt) : pm(r, 8);
          const res = frame(c.print, q, tilt, cond.make(r), seed);
          const want = c.L.strips.find((s) => s.edge === edgeForQuarterTurns(q))?.morse ?? null;
          const got = res.scan?.primary?.morse ?? null;
          row.n++;
          if (want === null) {
            // a blank edge (the slip hunt's top): right answer is no reading
            if (got === null) row.ok++;
            else {
              row.wrong++;
              misses.push(`WRONG ${cond.name} ${c.id} q${q}: read "${got}" on a blank edge`);
            }
          } else if (got === want) row.ok++;
          else if (got !== null) {
            row.wrong++;
            misses.push(`WRONG ${cond.name} ${c.id} q${q} seed ${seed}: got "${got}" want "${want}"`);
          } else {
            row.none++;
            misses.push(`missed ${cond.name} ${c.id} q${q} seed ${seed}: ${res.status}`);
          }
        }
      expect(row.wrong).toBe(0);
    }, 180_000);
  }

  it('the 45 degree zone gives no reading at all', () => {
    for (const [si, c] of COPIES.entries())
      for (let q = 0; q < 4; q++) {
        const seed = 97_000 + 10 * si + q;
        const r = rng(seed);
        const res = frame(c.print, q, 40 + r() * 10, { blur: 0.8 }, seed);
        zone.n++;
        if (res.scan?.primary) zone.read++;
      }
    expect(zone.read).toBe(0);
  }, 180_000);

  afterAll(() => {
    const rows = [...table.entries()];
    const tot = rows.reduce((a, [, r]) => ({ n: a.n + r.n, ok: a.ok + r.ok, wrong: a.wrong + r.wrong, none: a.none + r.none }), { n: 0, ok: 0, wrong: 0, none: 0 });
    const lines = [
      '',
      `unique slips: accuracy on generated words (${COPIES.length} copies x 4 turns per condition, quad ticket 146 x 66)`,
      `words: ${sample.copies.map((c) => Object.values(c.edges).join(' ')).join(' | ')}`,
      'condition'.padEnd(30) + 'n'.padStart(5) + 'ok'.padStart(6) + 'wrong'.padStart(7) + 'none'.padStart(6) + '   %',
    ];
    for (const [name, r] of rows) lines.push(name.padEnd(30) + String(r.n).padStart(5) + String(r.ok).padStart(6) + String(r.wrong).padStart(7) + String(r.none).padStart(6) + `${((100 * r.ok) / r.n).toFixed(1)}`.padStart(7));
    lines.push('TOTAL'.padEnd(30) + String(tot.n).padStart(5) + String(tot.ok).padStart(6) + String(tot.wrong).padStart(7) + String(tot.none).padStart(6) + `${((100 * tot.ok) / Math.max(1, tot.n)).toFixed(1)}`.padStart(7));
    lines.push(`45 degree zone: ${zone.n} frames, ${zone.read} readings`);
    if (misses.length) lines.push(...misses.slice(0, 16));
    console.info(lines.join('\n'));
    mkdirSync('.playwright', { recursive: true });
    writeFileSync('.playwright/unique-accuracy.txt', `${lines.join('\n')}\n`);
    if (tot.n > 0) expect(tot.ok / tot.n).toBeGreaterThanOrEqual(0.95);
  });
});
