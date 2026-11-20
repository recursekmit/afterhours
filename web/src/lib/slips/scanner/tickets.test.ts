/*
  Ticket slips: the four engraved designs (armillary, wave, ginkgo, ruins), printed by the real renderer
  with the real art behind them (fixtures/ticket-*.png: /dev/slips?size=ticket&print=1 at ~7.6 px/mm,
  6 mm of cream page around the slip), "photographed" by the synthetic camera and read by the exact
  pipeline the phones run.

  Pass bar (same as the plain slips): >= 95 % correct primaries, 0 wrong, and no reading at all in the
  45 degree ambiguity zone. The table is printed so the numbers can be quoted.
*/
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { edgeForQuarterTurns, encodeWord } from '@afterhours/shared/morse-slip';
import './config';
import armillaryUrl from './fixtures/ticket-armillary.png?inline';
import ginkgoUrl from './fixtures/ticket-ginkgo.png?inline';
import ruinsUrl from './fixtures/ticket-ruins.png?inline';
import waveUrl from './fixtures/ticket-wave.png?inline';
import { processFrame } from './pipeline';
import { decodePng, inflateWithStreams } from './testing/png';
import { type CameraOptions, type FloatImage, cameraScene, rgbaToFloat, rng } from './testing/synth';

const TICKETS: { id: string; url: string; words: [string, string, string, string] }[] = [
  { id: 'armillary', url: armillaryUrl, words: ['code', 'hi', 'lab', 'sun'] },
  { id: 'wave', url: waveUrl, words: ['stage', 'go', 'quiz', 'map'] },
  { id: 'ginkgo', url: ginkgoUrl, words: ['kmit', 'ok', 'lamp', 'sky'] },
  { id: 'ruins', url: ruinsUrl, words: ['arch', 'moon', 'vine', 'star'] },
];
/** the print: 176 x 80 mm ticket plus 6 mm of page all round */
const MM = { w: 176 + 12, h: 80 + 12 };

async function load(url: string): Promise<FloatImage> {
  const b64 = url.slice(url.indexOf(',') + 1);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const r = await decodePng(bytes, inflateWithStreams);
  return rgbaToFloat(r.rgba, r.width, r.height);
}

const pm = (r: () => number, a: number) => (r() * 2 - 1) * a;
type Cond = { name: string; make: (r: () => number) => Partial<CameraOptions>; tilt?: number };
const CONDITIONS: Cond[] = [
  { name: 'clean, flat', make: () => ({ blur: 0.6 }) },
  { name: 'tilt up to 25 deg', make: () => ({ blur: 0.7 }), tilt: 25 },
  { name: 'perspective (25 / 20 deg)', make: (r) => ({ pitchDeg: pm(r, 25), yawDeg: pm(r, 20), blur: 0.7 }) },
  { name: 'tilt + perspective', make: (r) => ({ pitchDeg: pm(r, 18), yawDeg: pm(r, 15), blur: 0.8 }), tilt: 20 },
  { name: 'out of focus (sigma 1.4)', make: () => ({ blur: 1.4 }) },
  { name: 'motion blur (4 px)', make: () => ({ motionBlur: 4, blur: 0.6 }) },
  { name: 'sensor noise (5 %)', make: () => ({ noise: 0.05, blur: 0.7 }) },
  { name: 'dim hall', make: () => ({ exposure: 0.35, noise: 0.025, blur: 1.0 }) },
  { name: 'low contrast print', make: () => ({ contrast: 0.45, noise: 0.015, blur: 0.8 }) },
  { name: 'lighting gradient + hand shadow', make: (r) => ({ gradient: 0.6, shadow: r() < 0.5 ? 0.5 : 0, blur: 0.7 }) },
  { name: 'dark table', make: () => ({ background: 'dark', blur: 0.7 }) },
  {
    name: 'everything at once',
    make: (r) => ({ pitchDeg: pm(r, 15), yawDeg: pm(r, 12), blur: 1.0, noise: 0.03, exposure: 0.6, gradient: 0.4, shadow: r() < 0.5 ? 0.4 : 0 }),
    tilt: 15,
  },
];

interface Row {
  n: number;
  ok: number;
  wrong: number;
  none: number;
}
const table = new Map<string, Row>();
const zone = { n: 0, none: 0, read: 0 };
const misses: string[] = [];
const prints = new Map<string, FloatImage>();

function frame(print: FloatImage, q: number, tilt: number, opts: Partial<CameraOptions>, seed: number) {
  const r = rng(seed * 7919 + 13);
  // a 1080p portrait frame (the scanner asks for 1920 x 1080); the whole 176 mm ticket in view
  return processFrame(
    cameraScene(print, { slipMm: MM, width: 1080, height: 1920, rollDeg: q * 90 + tilt, pxPerMm: 4.3 + r() * 0.9, offset: { x: pm(r, 20), y: pm(r, 80) }, seed, ...opts }),
    seed,
  );
}

describe('ticket slips read like plain ones', () => {
  it('loads the four real ticket prints', async () => {
    for (const t of TICKETS) prints.set(t.id, await load(t.url));
    expect(prints.size).toBe(4);
  });

  for (const [ci, cond] of CONDITIONS.entries()) {
    it(cond.name, () => {
      const row: Row = { n: 0, ok: 0, wrong: 0, none: 0 };
      table.set(cond.name, row);
      for (const [ti, t] of TICKETS.entries())
        for (let q = 0; q < 4; q++)
          for (let k = 0; k < 2; k++) {
            const seed = 5000 + 1000 * ci + 100 * ti + 10 * q + k;
            const r = rng(seed);
            const tilt = cond.tilt ? pm(r, cond.tilt) : pm(r, 8);
            const res = frame(prints.get(t.id) as FloatImage, q, tilt, cond.make(r), seed);
            const want = encodeWord(t.words[['bottom', 'right', 'top', 'left'].indexOf(edgeForQuarterTurns(q))] as string).morse;
            const got = res.scan?.primary?.morse ?? null;
            row.n++;
            if (got === want) row.ok++;
            else if (got !== null) {
              row.wrong++;
              misses.push(`WRONG ${cond.name} ${t.id} q${q} seed ${seed}: got "${got}" want "${want}"`);
            } else {
              row.none++;
              misses.push(`missed ${cond.name} ${t.id} q${q} seed ${seed}: ${res.status}`);
            }
          }
      expect(row.wrong).toBe(0);
    }, 120_000);
  }

  it('the 45 degree zone gives no reading at all', () => {
    for (const [ti, t] of TICKETS.entries())
      for (let q = 0; q < 4; q++)
        for (let k = 0; k < 2; k++) {
          const seed = 95_000 + 100 * ti + 10 * q + k;
          const r = rng(seed);
          const res = frame(prints.get(t.id) as FloatImage, q, 40 + r() * 10, { blur: 0.8 }, seed);
          zone.n++;
          if (res.scan?.primary) zone.read++;
          else zone.none++;
        }
    expect(zone.read).toBe(0);
  }, 120_000);

  afterAll(() => {
    const rows = [...table.entries()];
    const tot = rows.reduce((a, [, r]) => ({ n: a.n + r.n, ok: a.ok + r.ok, wrong: a.wrong + r.wrong, none: a.none + r.none }), { n: 0, ok: 0, wrong: 0, none: 0 });
    const lines = ['', 'ticket slips: accuracy (4 designs x 4 turns x 2 frames per condition)', 'condition'.padEnd(34) + 'n'.padStart(5) + 'ok'.padStart(6) + 'wrong'.padStart(7) + 'none'.padStart(6) + '   %'];
    for (const [name, r] of rows) lines.push(name.padEnd(34) + String(r.n).padStart(5) + String(r.ok).padStart(6) + String(r.wrong).padStart(7) + String(r.none).padStart(6) + `${((100 * r.ok) / r.n).toFixed(1)}`.padStart(7));
    lines.push('TOTAL'.padEnd(34) + String(tot.n).padStart(5) + String(tot.ok).padStart(6) + String(tot.wrong).padStart(7) + String(tot.none).padStart(6) + `${((100 * tot.ok) / Math.max(1, tot.n)).toFixed(1)}`.padStart(7));
    lines.push(`45 degree zone: ${zone.n} frames, ${zone.read} readings, ${zone.none} nothing`);
    if (misses.length) lines.push(...misses.slice(0, 12));
    console.info(lines.join('\n'));
    // also kept on disk (git-ignored), so the numbers can be quoted after a quiet run
    mkdirSync('.playwright', { recursive: true });
    writeFileSync('.playwright/ticket-accuracy.txt', `${lines.join('\n')}\n`);
    if (tot.n > 0) expect(tot.ok / tot.n).toBeGreaterThanOrEqual(0.95);
  });
});
