import { describe, expect, it } from 'vitest';
import { parseIdQr } from './idlogin';

describe('student ID QR formats across batches', () => {
  it('2nd-year short format still reads the suffix', () => {
    const q = parseIdQr('055W-12600-C-DATTA-CSE-250908');
    expect(q?.suffix).toBe('055W');
    expect(q?.roll).toBeNull();
  });
  it('a longer payload naming the roll reads the full roll', () => {
    const q = parseIdQr('NAME: PENDYALA SESHANK\nROLL NO: 26BD1A053G\nBRANCH: CSE\nADMN NO: 13516\nVALID 2026 TO 2030');
    expect(q?.roll).toBe('26BD1A053G');
    expect(q?.suffix).toBe('053G');
  });
  it('a roll inside a link is read; links without a roll are not ID cards', () => {
    expect(parseIdQr('https://example.edu/student?roll=26bd1a053g&x=1')?.roll).toBe('26BD1A053G');
    expect(parseIdQr('https://afterhours.recursekmit.in/?kit=AH-042')).toBeNull();
  });
  it('a roll glued to labels or with O for zero is normalised', () => {
    expect(parseIdQr('26BD1AO53G|13516|PENDYALA SESHANK|CSE')?.roll).toBe('26BD1A053G');
    expect(parseIdQr('13516,26BD1A053G,CSE,2026-2030')?.roll).toBe('26BD1A053G');
  });
  it('long payloads up to a few KB are accepted', () => {
    const long = `${'X'.repeat(1500)} 26BD1A053G ${'Y'.repeat(1500)}`;
    expect(parseIdQr(long)?.roll).toBe('26BD1A053G');
  });
});

import { resolveIdQr } from './idlogin';
describe('the card format settles a shared last-four', () => {
  const roster = [
    { id: 1, roll: '25BD1A0527', name: 'Second Year' },
    { id: 2, roll: '26BD1A0527', name: 'First Year' },
  ];
  it('a 2nd-year short card (issue date 25...) goes straight to the 25 batch', () => {
    const r = resolveIdQr(parseIdQr('0527-12600-B-RAO-CSE-250908')!, roster);
    expect(r).toMatchObject({ kind: 'one', who: { id: 1 } });
  });
  it('a 1st-year card naming the full roll goes straight to that roll', () => {
    const r = resolveIdQr(parseIdQr('ROLL NO: 26BD1A0527 | CSE | 13516')!, roster);
    expect(r).toMatchObject({ kind: 'one', who: { id: 2 } });
  });
  it('a short card with no date still shows the picker', () => {
    const r = resolveIdQr(parseIdQr('0527-12600-B-RAO-CSE')!, roster);
    expect(r.kind).toBe('many');
  });
});
