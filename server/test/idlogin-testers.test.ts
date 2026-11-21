// Mock testers (rolls 99BD1A90T<n>) can sign in again and again, on any phone. Real students keep one phone.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { all } from '../src/core/db';
import { isTestRoll } from '../src/core/auth/idRoutes';
import { type Jar, type TestApp, Jar as JarClass, adminJar, makeApp, req } from './helpers';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ROSTER = [
  'name,year,section,roll,phone,email',
  'Tester 9,2nd,CSE-A,99BD1A90T9,9000000009,t9@example.com',
  'Asha Verma,2nd,CSE-A,25BD1A0533,9000000011,asha@example.com',
].join('\n');
const TESTER_QR = '90T9-12600-A-TESTER-CSE-250908';

describe('mock testers sign in again and again', () => {
  let t: TestApp;
  let admin: Jar;
  beforeEach(async () => {
    t = await makeApp();
    admin = await adminJar(t.app);
    expect((await req(t.app, admin, 'POST', '/api/admin/participants/import', { csv: ROSTER })).statusCode).toBe(200);
  });
  afterEach(async () => t.close());

  const rollSignIn = (jar: Jar, roll: string, phone4: string) => req(t.app, jar, 'POST', '/api/auth/roll/signin', { roll, phone4 });

  it('only 99BD1A90T<n> rolls count as testers', () => {
    expect(isTestRoll('99BD1A90T1')).toBe(true);
    expect(isTestRoll(' 99bd1a90t12 ')).toBe(true);
    expect(isTestRoll('25BD1A0533')).toBe(false);
    expect(isTestRoll('99BD1A90T')).toBe(false);
    expect(isTestRoll(null)).toBe(false);
  });

  it('typed roll: three phones in a row all get in, as the same attendee', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const r = await rollSignIn(new JarClass(), '99BD1A90T9', '0009');
      expect(r.statusCode, r.body).toBe(200);
      ids.push((r.json() as J).attendee.id);
    }
    expect(new Set(ids).size).toBe(1);
    expect(all(t.ctx.db, 'SELECT id FROM attendees')).toHaveLength(1);
  });

  it('ID QR: resolve and sign-in work from a new phone after another phone is bound', async () => {
    expect((await req(t.app, new JarClass(), 'POST', '/api/auth/id/signin', { payload: TESTER_QR })).statusCode).toBe(200);
    const b = new JarClass();
    const r = await req(t.app, b, 'POST', '/api/auth/id/resolve', { payload: TESTER_QR });
    expect(r.statusCode, r.body).toBe(200);
    expect((await req(t.app, b, 'POST', '/api/auth/id/signin', { payload: TESTER_QR })).statusCode).toBe(200);
  });

  it('a real student is still held to one phone', async () => {
    expect((await rollSignIn(new JarClass(), '25BD1A0533', '0011')).statusCode).toBe(200);
    const r = await rollSignIn(new JarClass(), '25BD1A0533', '0011');
    expect(r.statusCode).toBe(409);
    expect((r.json() as J).error.code).toBe('id_bound');
  });
});
