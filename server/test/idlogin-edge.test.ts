// Student-ID login edge cases found in the event-day bug hunt. Made-up people only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Jar, type TestApp, Jar as JarClass, adminJar, makeApp, req } from './helpers';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ROSTER = [
  'name,year,section,roll,phone,email',
  'Asha Verma,2nd,CSE-A,25BD1A0533,9000000011,asha@example.com',
  'Bhavya Datta,1st,CSE-B,26BD1A0533,9000000022,bhavya@example.com',
  'Farah Khan,1st,CSE-C,26BD1A053G,9000000077,farah@example.com',
].join('\n');

// The 1st-year labelled card, with long names (as some real cards have).
const longCard = (roll: string) =>
  `S. No: 113 | Student Name: VENKATA SAI LAKSHMI NARASIMHA KRISHNA PRASAD REDDY GARI | Father Name: VENKATA SUBRAMANYA SATYANARAYANA MURTHY REDDY GARI CHOWDARY | Branch: CSE | Admin. No: 13516 | Roll No: ${roll} | Valid From: 2026 TO 2030 | Address: 1-2-345/6, SOME LONG STREET NAME, NARAYANGUDA, HYDERABAD, TELANGANA 500029`;

describe('student-ID login edge cases', () => {
  let t: TestApp;
  let admin: Jar;
  beforeEach(async () => {
    t = await makeApp();
    admin = await adminJar(t.app);
    const r = await req(t.app, admin, 'POST', '/api/admin/participants/import', { csv: ROSTER });
    expect(r.statusCode, r.body).toBe(200);
  });
  afterEach(async () => t.close());

  it('a long 1st-year card payload (over 300 chars) resolves, signs in, and reads at the desk and gate', async () => {
    const payload = longCard('KMBD1A053G');
    expect(payload.length).toBeGreaterThan(300);
    const jar = new JarClass();
    const r = await req(t.app, jar, 'POST', '/api/auth/id/resolve', { payload });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ kind: 'one', firstName: 'Farah' });
    const s = await req(t.app, jar, 'POST', '/api/auth/id/signin', { payload });
    expect(s.statusCode, s.body).toBe(200);
    const d = await req(t.app, admin, 'POST', '/api/admin/desk/lookup', { q: payload });
    expect(d.statusCode, d.body).toBe(200);
    expect((d.json() as J).matches.map((m: J) => m.roll)).toEqual(['26BD1A053G']);
  });

  it('typed fallback: the KM-prefixed roll printed on a 1st-year card finds the registered 26BD1A roll', async () => {
    const r = await req(t.app, new JarClass(), 'POST', '/api/auth/roll/signin', { roll: 'KMBD1A053G', phone4: '0077' });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as J).attendee.roll).toBe('26BD1A053G');
  });

  it('typed fallback: a KM roll shared by two batches picks the one whose phone matches, and wrong digits still fail', async () => {
    const asha = await req(t.app, new JarClass(), 'POST', '/api/auth/roll/signin', { roll: 'KMBD1A0533', phone4: '0011' });
    expect(asha.statusCode, asha.body).toBe(200);
    expect((asha.json() as J).attendee.roll).toBe('25BD1A0533');
    const bhavya = await req(t.app, new JarClass(), 'POST', '/api/auth/roll/signin', { roll: 'KMBD1A0533', phone4: '0022' });
    expect(bhavya.statusCode, bhavya.body).toBe(200);
    expect((bhavya.json() as J).attendee.roll).toBe('26BD1A0533');
    const wrong = await req(t.app, new JarClass(), 'POST', '/api/auth/roll/signin', { roll: 'KMBD1A0533', phone4: '9999' });
    expect(wrong.statusCode).toBe(401);
  });

  it('desk lookup: a typed KM roll finds the 26BD1A person', async () => {
    const d = await req(t.app, admin, 'POST', '/api/admin/desk/lookup', { q: 'KMBD1A053G' });
    expect(d.statusCode, d.body).toBe(200);
    expect((d.json() as J).matches.map((m: J) => m.roll)).toEqual(['26BD1A053G']);
  });
});
