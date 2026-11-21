/*
  The morse tickets as printed: standard visiting cards, 88.9 x 50.8 mm, full bleed. Each card is the
  146 x 66 quad ticket cropped at its outer dark border (141 x 61) and scaled to 88.9 x 38.47 mm, centred,
  with a dark band above and below (the ticket's own frame colour, ~6.2 mm) carrying gold text and thin gold
  rules. So the dark frame runs on into the bands, the card edge is not the ticket edge, and dots are
  ~0.82 mm. The corner finder rings are intact.

  This harness builds that card from layoutSlip with generator words (fixtures/unique-sample.json, not the
  printed ones), pseudo gold lettering and rules in the bands, and "photographs" it at 88.9 x 50.8 mm in a
  1080 x 1920 portrait frame. Distances use a typical phone main camera: about 49 degrees across the
  portrait frame, so 1080 px cover 0.91 x distance (12 cm = 9.9 px/mm, 10 cm = 11.9, 8 cm = 14.8).
  Read by the exact pipeline the phones run.

  Pass bar: >= 95 % over the hall conditions at 10-12 cm, 0 wrong in every row, nothing read in the 45
  degree zone. Rows marked "reported" set the guidance: at 8-9 cm an 88.9 mm card held across the phone is
  wider than the camera sees, so it cannot be found; turned upright it reads.
*/
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { type SlipEdge, SLIP_SIZES, SLIP_SPEC, edgeForQuarterTurns, layoutSlip } from '@afterhours/shared/morse-slip';
import './config';
import sample from './fixtures/unique-sample.json';
import { processFrame } from './pipeline';
import { type CameraOptions, type FloatImage, cameraScene, rasterSlip, rng } from './testing/synth';

const Q = SLIP_SIZES.quad;
const PPM = 10;
const CARD = { w: 88.9, h: 50.8 };
/** the quad ticket's frame, mm, and its size on the card */
const FRAME = { w: Q.widthMm - 2 * SLIP_SPEC.marginMm, h: Q.heightMm - 2 * SLIP_SPEC.marginMm };
const TICKET = { w: CARD.w, h: (CARD.w * FRAME.h) / FRAME.w };
const SCALE = CARD.w / FRAME.w;
const DARK = 0.1; // the ticket ground
const GOLD = 0.72; // gold ink, as a phone sees it in grey

/** The printed card: the ticket cut at its dark border, scaled to fill the width, dark bands with gold lettering above and below. */
function visitingCard(ticket: FloatImage, seed: number): FloatImage {
  const m = Math.round(SLIP_SPEC.marginMm * PPM);
  const tw = ticket.width - 2 * m;
  const th = ticket.height - 2 * m;
  const pxPerMm = tw / CARD.w;
  const width = tw;
  const height = Math.round(CARD.h * pxPerMm);
  const band = Math.round((height - th) / 2);
  const data = new Float32Array(width * height).fill(DARK);
  for (let y = 0; y < th; y++) data.set(ticket.data.subarray((y + m) * ticket.width + m, (y + m) * ticket.width + m + tw), (y + band) * width);
  const r = rng(seed);
  const fill = (x0: number, y0: number, w: number, h: number, v: number) => {
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(height, Math.round(y0 + h)); y++)
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(width, Math.round(x0 + w)); x++) data[y * width + x] = v;
  };
  // letter-spaced gold capitals (strokes of letters) and a thin gold rule in each band
  for (const top of [true, false]) {
    const y0 = top ? 0 : band + th;
    const capH = 0.3 * band;
    const textY = top ? y0 + 0.3 * band : y0 + 0.42 * band;
    const ruleY = top ? y0 + 0.82 * band : y0 + 0.16 * band;
    let x = width * 0.22;
    while (x < width * 0.78) {
      if (r() < 0.12) {
        x += capH * 0.9; // a word space or a middle dot
        continue;
      }
      const lw = capH * (0.55 + r() * 0.35);
      fill(x, textY, lw * 0.2, capH, GOLD); // stems
      fill(x + lw * 0.8, textY, lw * 0.2, capH, GOLD);
      if (r() < 0.6) fill(x, textY + capH * (r() < 0.5 ? 0 : 0.45), lw, capH * 0.16, GOLD); // bars
      x += lw + capH * 0.55;
    }
    fill(width * 0.07, ruleY, width * 0.86, Math.max(1, 0.012 * band * 2), GOLD * 0.9);
  }
  return { width, height, data };
}

const COPIES = sample.copies.map((c) => {
  const L = layoutSlip({ strips: c.edges as Partial<Record<SlipEdge, string>>, widthMm: Q.widthMm, heightMm: Q.heightMm, number: c.slip, serial: c.serial });
  return { id: `no. ${String(c.serial).padStart(3, '0')} slip ${c.slip}`, L, print: visitingCard(rasterSlip(L, PPM, { seed: c.serial }) as FloatImage, c.serial) };
});

const ppmAt = (cm: number) => 1080 / (0.911 * cm * 10);
const pm = (r: () => number, a: number) => (r() * 2 - 1) * a;
type Cond = { name: string; make: (r: () => number) => Partial<CameraOptions>; tilt?: number; gate: boolean; turns?: number[] };
const at = (r: () => number) => ({ pxPerMm: ppmAt(10 + r() * 2) }); // 10-12 cm
const CONDITIONS: Cond[] = [
  { name: '12 cm', make: () => ({ pxPerMm: ppmAt(12), blur: 0.8 }), gate: true },
  { name: '11 cm', make: () => ({ pxPerMm: ppmAt(11), blur: 0.8 }), gate: true },
  { name: '10 cm', make: () => ({ pxPerMm: ppmAt(10), blur: 0.8 }), gate: true },
  { name: 'tilt up to 25 deg', make: (r) => ({ ...at(r), blur: 0.7 }), tilt: 25, gate: true },
  { name: 'perspective (20 / 15 deg)', make: (r) => ({ ...at(r), pitchDeg: pm(r, 20), yawDeg: pm(r, 15), blur: 0.7 }), gate: true },
  { name: 'out of focus (sigma 1.4)', make: (r) => ({ ...at(r), blur: 1.4 }), gate: true },
  { name: 'motion blur (4 px)', make: (r) => ({ ...at(r), motionBlur: 4, blur: 0.6 }), gate: true },
  { name: 'dim hall', make: (r) => ({ ...at(r), exposure: 0.35, noise: 0.025, blur: 1.0 }), gate: true },
  { name: 'low contrast + gradient', make: (r) => ({ ...at(r), contrast: 0.45, gradient: 0.5, noise: 0.015, blur: 0.8 }), gate: true },
  { name: 'hand shadow', make: (r) => ({ ...at(r), shadow: 0.5, blur: 0.8 }), gate: true },
  { name: 'dark table', make: (r) => ({ ...at(r), background: 'dark', blur: 0.7 }), gate: true },
  { name: 'light table', make: (r) => ({ ...at(r), background: 'light', blur: 0.7 }), gate: true },
  {
    name: 'everything at once',
    make: (r) => ({ ...at(r), pitchDeg: pm(r, 12), yawDeg: pm(r, 10), blur: 1.0, noise: 0.03, exposure: 0.6, gradient: 0.4, shadow: r() < 0.5 ? 0.4 : 0 }),
    tilt: 12,
    gate: true,
  },
  // reported: they set the guidance
  { name: '8 cm, card upright (turned)', make: () => ({ pxPerMm: ppmAt(8), blur: 0.8 }), gate: false, turns: [1, 3] },
  { name: '9 cm, card upright (turned)', make: () => ({ pxPerMm: ppmAt(9), blur: 0.8 }), gate: false, turns: [1, 3] },
  { name: '8 cm, card across', make: () => ({ pxPerMm: ppmAt(8), blur: 0.8 }), gate: false, turns: [0, 2] },
  { name: '9 cm, card across', make: () => ({ pxPerMm: ppmAt(9), blur: 0.8 }), gate: false, turns: [0, 2] },
  { name: '15 cm', make: () => ({ pxPerMm: ppmAt(15), blur: 0.8 }), gate: false },
];

interface Row {
  n: number;
  ok: number;
  wrong: number;
  none: number;
  gate: boolean;
}
const table = new Map<string, Row>();
const zone = { n: 0, read: 0 };
const misses: string[] = [];
const times: number[] = [];

function frame(print: FloatImage, q: number, tilt: number, opts: Partial<CameraOptions>, seed: number) {
  const r = rng(seed * 7919 + 13);
  const res = processFrame(cameraScene(print, { slipMm: CARD, width: 1080, height: 1920, rollDeg: q * 90 + tilt, pxPerMm: ppmAt(11), offset: { x: pm(r, 15), y: pm(r, 120) }, seed, ...opts }), seed);
  times.push(res.ms);
  return res;
}

describe('morse tickets on 88.9 x 50.8 visiting cards (dark bands, gold text): the scanner reads 0.82 mm dots', () => {
  it('the ticket fills the card width at 88.9 x 38.5 mm, dots about 0.82 mm', () => {
    expect(TICKET.h).toBeCloseTo(38.47, 1);
    const unit = Math.min(...COPIES.flatMap((c) => c.L.strips.map((s) => s.unitMm))) * SCALE;
    expect(unit).toBeGreaterThan(0.8);
    for (const c of COPIES) expect(c.L.errors).toEqual([]);
  });

  for (const [ci, cond] of CONDITIONS.entries()) {
    it(cond.name, () => {
      const row: Row = { n: 0, ok: 0, wrong: 0, none: 0, gate: cond.gate };
      table.set(cond.name, row);
      for (const [si, c] of COPIES.entries())
        for (const q of cond.turns ?? [0, 1, 2, 3]) {
          const seed = 61_000 + 1000 * ci + 10 * si + q;
          const r = rng(seed);
          const tilt = cond.tilt ? pm(r, cond.tilt) : pm(r, 8);
          const res = frame(c.print, q, tilt, cond.make(r), seed);
          const want = c.L.strips.find((s) => s.edge === edgeForQuarterTurns(q))?.morse ?? null;
          const got = res.scan?.primary?.morse ?? null;
          row.n++;
          if (want === null) {
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
            if (cond.gate) misses.push(`missed ${cond.name} ${c.id} q${q} seed ${seed}: ${res.status}`);
          }
        }
      // never a wrong reading, gated or not: a wrong word could claim someone else's ticket
      expect(row.wrong).toBe(0);
    }, 240_000);
  }

  it('the 45 degree zone gives no reading at all', () => {
    for (const [si, c] of COPIES.entries())
      for (let q = 0; q < 4; q++) {
        const seed = 99_500 + 10 * si + q;
        const r = rng(seed);
        const res = frame(c.print, q, 40 + r() * 10, { blur: 0.8 }, seed);
        zone.n++;
        if (res.scan?.primary) zone.read++;
      }
    expect(zone.read).toBe(0);
  }, 240_000);

  afterAll(() => {
    const rows = [...table.entries()];
    const sum = (list: [string, Row][]) => list.reduce((a, [, r]) => ({ n: a.n + r.n, ok: a.ok + r.ok, wrong: a.wrong + r.wrong, none: a.none + r.none }), { n: 0, ok: 0, wrong: 0, none: 0 });
    const gated = sum(rows.filter(([, r]) => r.gate));
    const sorted = [...times].sort((a, b) => a - b);
    const fmt = (name: string, r: { n: number; ok: number; wrong: number; none: number }) =>
      name.padEnd(40) + String(r.n).padStart(5) + String(r.ok).padStart(6) + String(r.wrong).padStart(7) + String(r.none).padStart(6) + `${((100 * r.ok) / Math.max(1, r.n)).toFixed(1)}`.padStart(7);
    const lines = [
      '',
      `morse tickets on visiting cards, 88.9 x 50.8 (ticket 88.9 x 38.5, dark bands, gold text, dots ~0.82 mm): ${COPIES.length} copies per row, 1080 x 1920 frames`,
      'condition'.padEnd(40) + 'n'.padStart(5) + 'ok'.padStart(6) + 'wrong'.padStart(7) + 'none'.padStart(6) + '   %',
      ...rows.map(([name, r]) => fmt(`${name}${r.gate ? '' : ' (reported)'}`, r)),
      fmt('TOTAL, hall conditions at 10-12 cm', gated),
      `45 degree zone: ${zone.n} frames, ${zone.read} readings`,
      `frame time (node, 1080 x 1920): median ${sorted[Math.floor(sorted.length / 2)]?.toFixed(0)} ms, p90 ${sorted[Math.floor(sorted.length * 0.9)]?.toFixed(0)} ms`,
      ...misses.filter((m) => m.startsWith('WRONG')),
      ...misses.filter((m) => !m.startsWith('WRONG')).slice(0, 12),
    ];
    console.info(lines.join('\n'));
    mkdirSync('.playwright', { recursive: true });
    writeFileSync('.playwright/visiting-accuracy.txt', `${lines.join('\n')}\n`);
    if (gated.n > 0) expect(gated.ok / gated.n).toBeGreaterThanOrEqual(0.95);
  });
});
