// Made-up people only: no row here is from the real roster.
import { describe, expect, it } from 'vitest';
import {
  IdSignInRequestSchema,
  ParticipantInputSchema,
  RollSignInRequestSchema,
  looksLikeTestEntry,
  normaliseRoll,
  parseIdQr,
  phoneLast4,
  resolveIdQr,
  rollKey,
  rollSuffix,
} from './idlogin';

describe('roll normalisation', () => {
  it('uppercases, trims and drops separators', () => {
    expect(normaliseRoll(' 26bd1a055w ')).toBe('26BD1A055W');
    expect(normaliseRoll('26-BD1A-055W')).toBe('26BD1A055W');
    expect(normaliseRoll('26 bd 1a 05 5w')).toBe('26BD1A055W');
  });
  it('turns a typed O into 0 in the digit positions only', () => {
    expect(normaliseRoll('26BD1AO55W')).toBe('26BD1A055W'); // branch code
    expect(normaliseRoll('2OBD1A0512')).toBe('20BD1A0512'); // batch
    expect(normaliseRoll('26BD1A0O12')).toBe('26BD1A0012');
    expect(normaliseRoll('26BDOA0512')).toBe('26BD0A0512'); // position 4 is always a digit
    expect(normaliseRoll('26BD1A0512')).toBe('26BD1A0512'); // the letters BD and A stay
  });
  it('keeps a letter O in the serial, but the match key treats O and 0 alike', () => {
    expect(normaliseRoll('26BD1A05O7')).toBe('26BD1A05O7');
    expect(rollKey('26BD1A05O7')).toBe(rollKey('26bd1a0507'));
    expect(rollSuffix('26BD1A055W')).toBe('055W');
  });
  it('phone last 4 ignores spaces and +91', () => {
    expect(phoneLast4('+91 98765 43210')).toBe('3210');
    expect(phoneLast4(null)).toBe('');
  });
  it('flags test entries', () => {
    expect(looksLikeTestEntry('Meera (trial)')).toBe(true);
    expect(looksLikeTestEntry('test user')).toBe(true);
    expect(looksLikeTestEntry('Testa Rossi')).toBe(false);
  });
});

describe('student ID QR parsing', () => {
  it('reads the canonical payload', () => {
    expect(parseIdQr('055W-12600-C-DATTA-CSE-250908')).toEqual({
      suffix: '055W',
      roll: null,
      number: '12600',
      section: 'C',
      surname: 'DATTA',
      branch: 'CSE',
      date: '250908',
      batch: '25',
    });
  });
  it('is liberal about separators, case and spaces', () => {
    for (const v of ['055w-12600-c-datta-cse-250908', '055W 12600 C DATTA CSE 250908', '055W_12600_C_DATTA_CSE_250908', ' 055W|12600|C|DATTA|CSE|250908\n', '055W/12600/C/DATTA/CSE/250908', '055W - 12600 - C - DATTA - CSE - 250908']) {
      const q = parseIdQr(v);
      expect(q?.suffix, v).toBe('055W');
      expect(q?.surname, v).toBe('DATTA');
      expect(q?.batch, v).toBe('25');
    }
  });
  it('fixes O for zero in the suffix digits', () => {
    expect(parseIdQr('O55W-12600-C-DATTA-CSE-250908')?.suffix).toBe('055W');
    expect(parseIdQr('OO27-1-A-RAO-CSE-260801')?.suffix).toBe('0027');
  });
  it('reads a payload with no separators at all', () => {
    const q = parseIdQr('055W12600CDATTACSE250908');
    expect(q).toMatchObject({ suffix: '055W', number: '12600', section: 'C', surname: 'DATTA', branch: 'CSE', batch: '25' });
  });
  it('takes a full roll if the card carries one', () => {
    expect(parseIdQr('26BD1A055W-C-DATTA')).toMatchObject({ suffix: '055W', roll: '26BD1A055W' });
    expect(parseIdQr('26BD1A055W')).toMatchObject({ roll: '26BD1A055W' });
  });
  it('copes with missing or odd segments', () => {
    expect(parseIdQr('055W-C-DATTA')).toMatchObject({ suffix: '055W', surname: 'DATTA', batch: null, number: null });
    expect(parseIdQr('055W-12600')).toMatchObject({ suffix: '055W', number: '12600', batch: null });
    expect(parseIdQr('055W-12600-C-DATTA-CSE-20250908')).toMatchObject({ batch: '25', date: '250908' });
    expect(parseIdQr('055W-12600-C-DATTA-CSE-259999')).toMatchObject({ batch: null, number: '12600' }); // not a date
  });
  it('rejects junk', () => {
    for (const v of ['', '   ', 'hello', '055W', 'https://afterhours.example/?kit=AH-042', 'AH-042', 'ZZZZZ-1-2', '!!!---', 'x'.repeat(500)]) {
      expect(parseIdQr(v), v).toBeNull();
    }
  });
});

const R = [
  { roll: '25BD1A0533', name: 'Asha Verma' },
  { roll: '26BD1A0533', name: 'Bhavya Datta' },
  { roll: '25BD1A0577', name: 'Chetan Rao' },
  { roll: '26BD1A0577', name: 'Chandana Rao' },
  { roll: '26BD1A055W', name: 'Divya Kapoor' },
  { roll: '26BD1A6612', name: 'S Eshwar' },
];

describe('resolving a scan against the roster', () => {
  const resolve = (payload: string) => {
    const q = parseIdQr(payload);
    if (!q) throw new Error('no parse');
    const r = resolveIdQr(q, R);
    return r.kind === 'one' ? r.who.roll : r.kind === 'many' ? `many:${r.candidates.map((c) => c.roll).join(',')}` : r.kind;
  };
  it('one person with that suffix: straight to them, whatever the name or date says', () => {
    expect(resolve('055W-12600-C-KAPOOR-CSE-260908')).toBe('26BD1A055W');
    expect(resolve('055w 12600 c kapoor cse 260908')).toBe('26BD1A055W');
    expect(resolve('O55W-12600-C-KAPOOR-CSE-260908')).toBe('26BD1A055W');
    expect(resolve('055W-12600-C-SOMEONEELSE-CSE-200101')).toBe('26BD1A055W'); // names and dates are not used
  });
  it('nobody with that suffix: not registered', () => {
    expect(resolve('0999-12600-C-KAPOOR-CSE-260908')).toBe('none');
  });
  it('two or more share it: the card format (issue-date batch) narrows it, else the picker; surnames never narrow', () => {
    expect(resolve('0533-12600-C-DATTA-CSE-250908')).toBe('25BD1A0533');
    expect(resolve('0533-12600-C-VERMA-CSE-260908')).toBe('26BD1A0533');
    expect(resolve('0533-12600-C-VERMA-CSE-240908')).toBe('many:25BD1A0533,26BD1A0533');
    expect(resolve('0577-12600-C')).toBe('many:25BD1A0577,26BD1A0577');
  });
  it('a full roll in the QR is exact', () => {
    expect(resolve('26BD1A0577-C-RAO')).toBe('26BD1A0577');
    expect(resolve('24BD1A0577-C-RAO')).toBe('none');
  });
});

describe('request schemas', () => {
  it('typed fallback normalises roll and digits', () => {
    expect(RollSignInRequestSchema.parse({ roll: '26bd1ao55w', phone4: '3 2 1 0' })).toEqual({ roll: '26BD1A055W', phone4: '3210' });
    expect(RollSignInRequestSchema.safeParse({ roll: '26BD1A055W', phone4: '321' }).success).toBe(false);
    expect(RollSignInRequestSchema.safeParse({ roll: '!!', phone4: '3210' }).success).toBe(false);
  });
  it('id sign-in carries an optional pick and phone', () => {
    expect(IdSignInRequestSchema.parse({ payload: 'x', pick: 3, phone4: '1 234' })).toEqual({ payload: 'x', pick: 3, phone4: '1234' });
    expect(IdSignInRequestSchema.parse({ payload: '055W-1-C-X-CSE-250908' })).toEqual({ payload: '055W-1-C-X-CSE-250908' });
  });
  it('participant input nulls empty optionals', () => {
    expect(ParticipantInputSchema.parse({ name: ' Walk In ', roll: '26bd1a0599', phone: '', email: '' })).toEqual({
      name: 'Walk In',
      roll: '26BD1A0599',
      year: null,
      section: null,
      phone: null,
      email: null,
      note: null,
    });
  });
});
