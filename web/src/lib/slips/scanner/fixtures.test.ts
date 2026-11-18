/*
  The real print: fixtures/slip-code-hi-lab-sun.png is the SVG renderer (SlipSvg, real
  logo and fonts) screenshotted by e2e/slips.spec.ts at ~15 px/mm with 6 mm of page
  around it. Here it is "photographed" by the synthetic camera and read back, so the
  printed personality (logo, number, doodle, text) is proven not to confuse the reader.
  (A real phone photo of a paper print is not in the repo: see the slips test notes.)
*/
import { describe, expect, it } from 'vitest';
import './config';
import printUrl from './fixtures/slip-code-hi-lab-sun.png?inline';
import { processFrame } from './pipeline';
import { decodePng, inflateWithStreams } from './testing/png';
import { type CameraOptions, cameraScene, rgbaToFloat } from './testing/synth';

async function loadPrint() {
  const b64 = printUrl.slice(printUrl.indexOf(',') + 1);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const r = await decodePng(bytes, inflateWithStreams);
  return rgbaToFloat(r.rgba, r.width, r.height);
}

const MM = { w: 85 + 12, h: 55 + 12 };
const WANT = ['CODE', 'HI', 'LAB', 'SUN'];

describe('reading the real SVG print', () => {
  const cases: { name: string; opts: Partial<CameraOptions> }[] = [
    { name: 'flat', opts: { blur: 0.7 } },
    { name: 'tilted + perspective', opts: { pitchDeg: 18, yawDeg: -12, blur: 0.9 } },
    { name: 'dim hall', opts: { exposure: 0.4, noise: 0.025, blur: 1.1 } },
    { name: 'shadow + gradient', opts: { shadow: 0.5, gradient: 0.5, blur: 0.8 } },
  ];
  for (const c of cases)
    it(c.name, async () => {
      const print = await loadPrint();
      for (let q = 0; q < 4; q++) {
        const tilt = ((q * 7) % 11) - 5;
        const g = cameraScene(print, { slipMm: MM, rollDeg: q * 90 + tilt, pxPerMm: 5.6, seed: 300 + q, ...c.opts });
        const r = processFrame(g, 0);
        expect(r.scan?.primary?.text, `${c.name}, ${q} quarter turns`).toBe(WANT[q]);
      }
    }, 60_000);
});
