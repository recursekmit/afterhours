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
  surnameMatches,
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
    expect(parseIdQr('26BD1A055W-C-DATTA')).toMatchObject({ suffix: '055W', roll: '26BD1A055W', surname: 'DATTA' });
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
  { roll: '25BD1A0527', name: 'Asha Verma' },
  { roll: '26BD1A0527', name: 'Bhavya Datta' },
  { roll: '25BD1A0563', name: 'Chetan Rao' },
  { roll: '26BD1A0563', name: 'Chandana Rao' },
  { roll: '26BD1A055W', name: 'Divya Kapoor' },
  { roll: '26BD1A6612', name: 'S Eshwar' },
];

describe('resolving a scan against the roster', () => {
  const resolve = (payload: string) => {
    const q = parseIdQr(payload);
    if (!q) throw new Error('no parse');
    const r = resolveIdQr(q, R);
    return r.kind === 'one' ? `${r.who.roll}/${r.by}` : r.kind;
  };
  it('one person with that suffix: signs in', () => {
    expect(resolve('055W-12600-C-KAPOOR-CSE-260908')).toBe('26BD1A055W/only');
    expect(resolve('055w 12600 c kapoor cse 260908')).toBe('26BD1A055W/only');
    expect(resolve('O55W-12600-C-KAPOOR-CSE-260908')).toBe('26BD1A055W/only');
  });
  it('nobody with that suffix: not registered', () => {
    expect(resolve('0999-12600-C-KAPOOR-CSE-260908')).toBe('none');
  });
  it('a collision is settled by the batch year first', () => {
    expect(resolve('0527-12600-C-WHOEVER-CSE-250908')).toBe('25BD1A0527/year');
    expect(resolve('0527-12600-C-WHOEVER-CSE-260908')).toBe('26BD1A0527/year');
  });
  it('then by surname when the year does not decide', () => {
    expect(resolve('0527-12600-C-DATTA-CSE')).toBe('26BD1A0527/surname');
    expect(resolve('0527-12600-C-verma-CSE-240908')).toBe('25BD1A0527/surname'); // year 24 matches nobody
  });
  it('otherwise asks for the full roll', () => {
    expect(resolve('0563-12600-C-RAO-CSE')).toBe('ambiguous'); // both are Rao, no year
    expect(resolve('0563-12600-C-RAO-CSE-240908')).toBe('ambiguous');
    expect(resolve('0527-12600-C')).toBe('ambiguous');
  });
  it('does not trust a year that the surname clearly contradicts', () => {
    // year says 25BD1A0527 (Verma), surname says Datta (26BD1A0527)
    expect(resolve('0527-12600-C-DATTA-CSE-250908')).toBe('ambiguous');
  });
  it('a lone candidate contradicted by both hints is probably someone else', () => {
    expect(resolve('055W-12600-C-SHARMA-CSE-250908')).toBe('ambiguous');
    expect(resolve('055W-12600-C-KAPOOR-CSE-250908')).toBe('26BD1A055W/only'); // surname vouches
    expect(resolve('055W-12600-C-SHARMA-CSE-260908')).toBe('26BD1A055W/only'); // year vouches
  });
  it('a full roll in the QR is exact', () => {
    expect(resolve('26BD1A0563-C-RAO')).toBe('26BD1A0563/roll');
    expect(resolve('24BD1A0563-C-RAO')).toBe('none');
  });
  it('surname match is word based and case-insensitive', () => {
    expect(surnameMatches('eshwar', 'S Eshwar')).toBe(true);
    expect(surnameMatches('RAO', 'Chetan Rao')).toBe(true);
    expect(surnameMatches('RA', 'Chetan Rao')).toBe(false);
    expect(surnameMatches('KAPOOR', 'Divyakapoor')).toBe(true);
  });
});

describe('request schemas', () => {
  it('typed fallback normalises roll and digits', () => {
    expect(RollSignInRequestSchema.parse({ roll: '26bd1ao55w', phone4: '3 2 1 0' })).toEqual({ roll: '26BD1A055W', phone4: '3210' });
    expect(RollSignInRequestSchema.safeParse({ roll: '26BD1A055W', phone4: '321' }).success).toBe(false);
    expect(RollSignInRequestSchema.safeParse({ roll: '!!', phone4: '3210' }).success).toBe(false);
  });
  it('id sign-in carries an optional roll and phone', () => {
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
