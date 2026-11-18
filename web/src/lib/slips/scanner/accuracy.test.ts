/*
  Accuracy harness: slips rendered from layoutSlip, "photographed" by the
  synthetic camera under hall conditions, read by the exact pipeline the worker
  runs. Prints an accuracy table and per-frame timings (npm test shows them).

  Pass bar: >= 95 % correct primaries over the realistic conditions, at most
  1 % confidently wrong, and NO wrong primary in the 45 degree ambiguity zone.
*/
import { afterAll, describe, expect, it } from 'vitest';
import { type SlipDesign, type SlipEdge, edgeForQuarterTurns, layoutSlip } from '../../../../../shared/src/morse-slip';
import { processFrame } from './pipeline';
import { SlipStabiliser } from './stabilise';
import { type CameraOptions, type FloatImage, cameraScene, rasterSlip, rng } from './testing/synth';

const DESIGNS: SlipDesign[] = [
  { strips: { bottom: 'code', right: 'hi', top: 'lab', left: 'sun' }, number: 1 },
  { strips: { bottom: 'stage', right: 'go', top: 'quiz', left: 'map' }, number: 2 },
  { strips: { bottom: 'recurse', right: 'yes', top: 'decoy', left: 'no' }, number: 3 },
  { strips: { bottom: 'atrium', left: 'tea' }, number: 4 },
  { strips: { bottom: '42', right: '7', top: 'kmit', left: 'ok' }, number: 5 },
];
const SLIPS = DESIGNS.map((d) => {
  const L = layoutSlip(d);
  return { L, print: rasterSlip(L, 12, { seed: Number(d.number) }) as FloatImage };
});

type Cond = { name: string; make: (r: () => number) => Partial<CameraOptions>; tilt?: number };
const pm = (r: () => number, a: number) => (r() * 2 - 1) * a;

const CONDITIONS: Cond[] = [
  { name: 'clean, flat', make: () => ({ blur: 0.6 }) },
  { name: 'tilt up to 25 deg', make: () => ({ blur: 0.7 }), tilt: 25 },
  { name: 'perspective (25 / 20 deg)', make: (r) => ({ pitchDeg: pm(r, 25), yawDeg: pm(r, 20), blur: 0.7 }) },
  { name: 'tilt + perspective', make: (r) => ({ pitchDeg: pm(r, 18), yawDeg: pm(r, 15), blur: 0.8 }), tilt: 20 },
  { name: 'out of focus (sigma 1.6)', make: () => ({ blur: 1.6 }) },
  { name: 'motion blur (5 px)', make: () => ({ motionBlur: 5, blur: 0.6 }) },
  { name: 'sensor noise (5 %)', make: () => ({ noise: 0.05, blur: 0.7 }) },
  { name: 'dim hall', make: () => ({ exposure: 0.35, noise: 0.025, blur: 1.0 }) },
  { name: 'low contrast print', make: () => ({ contrast: 0.4, noise: 0.015, blur: 0.8 }) },
  { name: 'lighting gradient', make: () => ({ gradient: 0.65, blur: 0.7 }) },
  { name: 'hand shadow', make: () => ({ shadow: 0.55, blur: 0.7 }) },
  { name: 'far (3.4 px/mm)', make: () => ({ pxPerMm: 3.4, blur: 0.6 }) },
  { name: 'close (8 px/mm)', make: () => ({ pxPerMm: 8, blur: 0.9 }) },
  { name: 'dark table', make: () => ({ background: 'dark', blur: 0.7 }) },
  {
    name: 'everything at once',
    make: (r) => ({ pitchDeg: pm(r, 15), yawDeg: pm(r, 12), blur: 1.1, noise: 0.03, exposure: 0.6, gradient: 0.4, shadow: r() < 0.5 ? 0.4 : 0 }),
    tilt: 15,
  },
];

interface Row {
  n: number;
  ok: number;
  wrong: number;
  none: number;
  ms: number[];
}
const table = new Map<string, Row>();
const allMs: number[] = [];
const misses: string[] = [];
const zone = { n: 0, wrong: 0, none: 0, ok: 0 };
const stable = { n: 0, ok: 0, wrong: 0, none: 0 };

function expected(L: ReturnType<typeof layoutSlip>, edge: SlipEdge): string | null {
  return L.strips.find((s) => s.edge === edge)?.morse ?? null;
}

function frame(slipIdx: number, q: number, opts: Partial<CameraOptions>, tilt: number, seed: number) {
  const { L, print } = SLIPS[slipIdx]!;
  const r = rng(seed * 7919 + 13);
  const pxPerMm = opts.pxPerMm ?? 5 + r() * 2;
  const g = cameraScene(print, {
    slipMm: { w: L.widthMm, h: L.heightMm },
    rollDeg: q * 90 + tilt,
    pxPerMm,
    offset: { x: pm(r, 40), y: pm(r, 120) },
    seed,
    ...opts,
  });
  return processFrame(g, seed);
}

describe('accuracy over realistic conditions', () => {
  for (const [ci, cond] of CONDITIONS.entries()) {
    it(cond.name, () => {
      const row: Row = { n: 0, ok: 0, wrong: 0, none: 0, ms: [] };
      table.set(cond.name, row);
      for (let si = 0; si < SLIPS.length; si++)
        for (let q = 0; q < 4; q++)
          for (let k = 0; k < 2; k++) {
            const seed = 1000 * ci + 100 * si + 10 * q + k;
            const r = rng(seed);
            const tilt = cond.tilt ? pm(r, cond.tilt) : pm(r, 8);
            const opts = cond.make(r);
            const res = frame(si, q, opts, tilt, seed);
            const want = expected(SLIPS[si]!.L, edgeForQuarterTurns(q));
            const got = res.scan?.primary?.morse ?? null;
            row.n++;
            row.ms.push(res.ms);
            allMs.push(res.ms);
            if (want === null) {
              // a blank edge: right answer is "blank", never a reading
              if (got === null && res.status === 'blank') row.ok++;
              else if (got !== null) row.wrong++;
              else row.none++;
            } else if (got === want) row.ok++;
            else if (got !== null) {
              row.wrong++;
              misses.push(`WRONG ${cond.name} slip ${si} q ${q} seed ${seed} tilt ${tilt.toFixed(1)}: got "${got}" (${res.scan?.primary?.confidence}) want "${want}"`);
            } else {
              row.none++;
              misses.push(`missed ${cond.name} slip ${si} q ${q} seed ${seed}: ${res.status}`);
            }
          }
      expect(row.n).toBeGreaterThan(0);
    }, 90_000);
  }

  it('the 45 degree ambiguity zone never gives a wrong primary', () => {
    for (let si = 0; si < SLIPS.length; si++)
      for (let q = 0; q < 4; q++)
        for (let k = 0; k < 3; k++) {
          const seed = 90_000 + 100 * si + 10 * q + k;
          const r = rng(seed);
          const off = 35 + r() * 20; // 35..55 degrees past the quarter turn
          const res = frame(si, q, { blur: 0.8, pitchDeg: pm(r, 12), yawDeg: pm(r, 10) }, off, seed);
          zone.n++;
          const got = res.scan?.primary?.morse ?? null;
          if (got === null) zone.none++;
          else if (got === expected(SLIPS[si]!.L, edgeForQuarterTurns(q)) || got === expected(SLIPS[si]!.L, edgeForQuarterTurns(q + 1))) zone.wrong++;
          else zone.wrong++;
        }
    expect(zone.wrong).toBe(0);
  }, 90_000);

  it('three-frame stabiliser (fresh noise and a little hand shake each frame)', () => {
    for (let si = 0; si < SLIPS.length; si++)
      for (let q = 0; q < 4; q++)
        for (let k = 0; k < 1; k++) {
          const base = 50_000 + 100 * si + 10 * q + k;
          const r = rng(base);
          const tilt = pm(r, 15);
          const opts: Partial<CameraOptions> = { pitchDeg: pm(r, 15), yawDeg: pm(r, 12), blur: 1.1, noise: 0.03, exposure: 0.6, gradient: 0.4 };
          const st = new SlipStabiliser({ frames: 3 });
          let out = null;
          for (let f = 0; f < 6 && !out; f++) out = st.push(frame(si, q, { ...opts, motionBlur: f % 2 ? 3 : 0 }, tilt + pm(r, 1.5), base * 10 + f));
          const want = expected(SLIPS[si]!.L, edgeForQuarterTurns(q));
          if (want === null) continue;
          stable.n++;
          const got = out?.primary?.morse ?? null;
          if (got === want) stable.ok++;
          else if (got) stable.wrong++;
          else stable.none++;
        }
    expect(stable.wrong).toBe(0);
  }, 120_000);

  afterAll(() => {
    let n = 0;
    let ok = 0;
    let wrong = 0;
    const lines = ['', 'slip scanner accuracy (single frames, 720 x 1280 portrait camera frames)', ''];
    lines.push(`${'condition'.padEnd(28)} ${'cases'.padStart(5)} ${'correct'.padStart(8)} ${'wrong'.padStart(6)} ${'missed'.padStart(7)} ${'ms/frame'.padStart(9)}`);
    for (const [name, r] of table) {
      n += r.n;
      ok += r.ok;
      wrong += r.wrong;
      const ms = r.ms.reduce((a, b) => a + b, 0) / r.ms.length;
      lines.push(`${name.padEnd(28)} ${String(r.n).padStart(5)} ${pct(r.ok, r.n).padStart(8)} ${String(r.wrong).padStart(6)} ${String(r.none).padStart(7)} ${ms.toFixed(1).padStart(9)}`);
    }
    lines.push(`${'ALL realistic'.padEnd(28)} ${String(n).padStart(5)} ${pct(ok, n).padStart(8)} ${String(wrong).padStart(6)} ${String(n - ok - wrong).padStart(7)}`);
    lines.push(`${'45 deg zone (35..55)'.padEnd(28)} ${String(zone.n).padStart(5)} ${'-'.padStart(8)} ${String(zone.wrong).padStart(6)} ${String(zone.none).padStart(7)}   (no primary is the right answer)`);
    lines.push(`${'stabilised, 3 frames, hall'.padEnd(28)} ${String(stable.n).padStart(5)} ${pct(stable.ok, stable.n).padStart(8)} ${String(stable.wrong).padStart(6)} ${String(stable.none).padStart(7)}`);
    const s = [...allMs].sort((a, b) => a - b);
    lines.push('', `pipeline time per frame: median ${q(s, 0.5)} ms, p95 ${q(s, 0.95)} ms, max ${q(s, 1)} ms (Node, ${s.length} frames)`);
    console.info([...lines, '', ...misses].join('\n'));
    if (n > 0) {
      expect(ok / n).toBeGreaterThanOrEqual(0.95);
      expect(wrong / n).toBeLessThanOrEqual(0.01);
    }
  });
});

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');
const q = (s: number[], p: number) => (s.length ? (s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] as number).toFixed(1) : '-');
