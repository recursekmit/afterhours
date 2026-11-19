import { describe, expect, it } from 'vitest';
import { layoutSlip, reverseReading } from '@afterhours/shared/morse-slip';
import './config';
import { processFrame } from './pipeline';
import { cameraScene, rasterSlip } from './testing/synth';

const WORDS = { bottom: 'code', right: 'hi', top: 'lab', left: 'sun' };
const L = layoutSlip({ strips: WORDS, number: 3 });
const PRINT = rasterSlip(L, 12);
const mm = { w: L.widthMm, h: L.heightMm };
const morseOf = (e: keyof typeof WORDS) => L.strips.find((s) => s.edge === e)!.morse;

describe('slip pipeline basics', () => {
  it('reads a flat, upright slip', () => {
    const g = cameraScene(PRINT, { slipMm: mm, pxPerMm: 7, seed: 1 });
    const r = processFrame(g, 1);
    expect(r.status).toBe('ok');
    expect(r.scan?.primary?.text).toBe('CODE');
    expect(r.scan?.primary?.morse).toBe(morseOf('bottom'));
    const top = r.scan?.others.find((o) => o.position === 'top');
    expect(top?.morse).toBe(reverseReading(morseOf('top')));
    const texts = r.scan?.others.map((o) => o.text).sort();
    expect(texts).toContain('HI');
    expect(texts).toContain('SUN');
  });

  it('turning the slip changes the primary', () => {
    const want = ['CODE', 'HI', 'LAB', 'SUN'];
    for (let q = 0; q < 4; q++) {
      const g = cameraScene(PRINT, { slipMm: mm, pxPerMm: 6.5, rollDeg: q * 90, seed: 10 + q });
      const r = processFrame(g, 1);
      expect(r.scan?.primary?.text, `quarter turns ${q}`).toBe(want[q]);
    }
  });

  it('finds nothing in an empty scene', () => {
    const g = cameraScene(PRINT, { slipMm: mm, pxPerMm: 7, offset: { x: 5000, y: 0 }, seed: 3 });
    expect(processFrame(g, 1).status).toBe('none');
  });
});
