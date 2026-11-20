import { PASSWORD_ALPHABET } from '@afterhours/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generatePassword, hashPassword, verifyPassword } from '../src/core/auth/crypto';
import { parseKitCsv } from '../src/core/auth/kits';
import { AVATAR, Jar, type TestApp, adminJar, makeApp, makeKits, req, signedInAttendee } from './helpers';

describe('password hashing', () => {
  it('scrypt round-trips and rejects wrong passwords', async () => {
    const h = await hashPassword('K7M4QP');
    expect(h).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(h).not.toContain('K7M4QP');
    expect(await verifyPassword('K7M4QP', h)).toBe(true);
    expect(await verifyPassword('K7M4QR', h)).toBe(false);
    expect(await verifyPassword('K7M4QP', 'garbage')).toBe(false);
  });
  it('same password hashes differently each time (salted)', async () => {
    expect(await hashPassword('ABCDEF')).not.toBe(await hashPassword('ABCDEF'));
  });
  it('generated passwords use only the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePassword();
      expect(p).toHaveLength(6);
      for (const c of p) expect(PASSWORD_ALPHABET).toContain(c);
    }
  });
});

describe('kit csv parsing', () => {
  it('handles header, quotes, tabs, blanks and bad rows', () => {
    const { rows, skipped } = parseKitCsv('name,roll\n"Reddy, Aarav",23bd1a0501\n\nDiya\t23BD1A0502\n,123\nBob,bad roll!');
    expect(rows).toEqual([
      { name: 'Reddy, Aarav', roll: '23BD1A0501' },
      { name: 'Diya', roll: '23BD1A0502' },
    ]);
    expect(skipped.map((s) => s.line)).toEqual([5, 6]);
  });
});

describe('auth flows', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => t.close());

  it('console needs the PIN; wrong PIN is refused', async () => {
    expect((await req(t.app, new Jar(), 'GET', '/api/admin/kits')).statusCode).toBe(401);
    const bad = await req(t.app, new Jar(), 'POST', '/api/admin/session', { pin: '0000' });
    expect(bad.statusCode).toBe(401);
    const jar = await adminJar(t.app);
    expect((await req(t.app, jar, 'GET', '/api/admin/kits')).statusCode).toBe(200);
    // an admin cookie is not a projector cookie... but admins may preview the projector
    expect((await req(t.app, jar, 'GET', '/api/screen/state')).statusCode).toBe(200);
    expect((await req(t.app, new Jar(), 'GET', '/api/screen/state')).statusCode).toBe(401);
  }, 60_000); // scrypt + PIN checks are slow when the whole suite runs in parallel

  it('generates kits blank and from CSV, sequential ids, passwords shown once', async () => {
    const admin = await adminJar(t.app);
    const a = (await req(t.app, admin, 'POST', '/api/admin/kits', { mode: 'blank', count: 3 })).json();
    expect(a.kits.map((k: { kitId: string }) => k.kitId)).toEqual(['AH-001', 'AH-002', 'AH-003']);
    const b = (await req(t.app, admin, 'POST', '/api/admin/kits', { mode: 'csv', csv: 'Aarav,23BD1A0501\nDiya,23BD1A0502' })).json();
    expect(b.kits).toMatchObject([
      { kitId: 'AH-004', name: 'Aarav', roll: '23BD1A0501' },
      { kitId: 'AH-005', name: 'Diya', roll: '23BD1A0502' },
    ]);
    const list = await req(t.app, admin, 'GET', '/api/admin/kits');
    expect(list.json().stats.total).toBe(5);
    for (const k of [...a.kits, ...b.kits]) expect(list.body).not.toContain(k.password);
  });

  it('signs in, records attendance, requires a profile, then lets features through', async () => {
    const [kit] = await makeKits(t.app, 1);
    const phone = new Jar();
    const wrong = await req(t.app, phone, 'POST', '/api/auth/signin', { kitId: kit!.kitId, password: 'ZZZZZZ' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('bad_credentials');

    // typed sloppily: lowercase, spaces, short kit id
    const ok = await req(t.app, phone, 'POST', '/api/auth/signin', {
      kitId: kit!.kitId.toLowerCase().replace('-00', ' '),
      password: ` ${kit!.password.toLowerCase().slice(0, 3)} ${kit!.password.toLowerCase().slice(3)} `,
    });
    expect(ok.statusCode).toBe(200);
    const me = ok.json();
    expect(me.attendee).toMatchObject({ kitId: kit!.kitId, profileComplete: false, firstSignInAt: t.clock.now() });
    expect(phone.cookies.ah_sid).toBeTruthy();
    expect(phone.cookies.ah_dev).toBeTruthy();
    const setCookie = String(ok.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);

    // first sign-in = points + sticker
    expect((await req(t.app, phone, 'GET', '/api/points/me')).json().total).toBe(10);
    expect(Object.keys((await req(t.app, phone, 'GET', '/api/stickers')).json().unlocked)).toEqual(['showed-up']);

    // a feature route behind requireAttendee() refuses until the profile is done
    const blocked = await req(t.app, phone, 'POST', '/api/reactions', { kind: 'fire' });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('profile_required');

    const badProfile = await req(t.app, phone, 'PUT', '/api/me/profile', { name: 'A', roll: 'x', nickname: '<script>', avatar: AVATAR });
    expect(badProfile.statusCode).toBe(400);
    const prof = await req(t.app, phone, 'PUT', '/api/me/profile', { name: 'Aarav', roll: '23bd1a0501', nickname: 'aaru', avatar: AVATAR });
    expect(prof.statusCode).toBe(200);
    expect(prof.json().attendee).toMatchObject({ profileComplete: true, roll: '23BD1A0501', nickname: 'aaru' });
    expect((await req(t.app, phone, 'POST', '/api/reactions', { kind: 'fire' })).statusCode).toBe(200);
    expect((await req(t.app, phone, 'GET', '/api/points/me')).json().total).toBe(20);

    // sign out kills the session but not the device binding
    await req(t.app, phone, 'POST', '/api/auth/signout');
    expect((await req(t.app, phone, 'GET', '/api/me')).statusCode).toBe(401);
    expect((await req(t.app, phone, 'POST', '/api/auth/signin', kit)).statusCode).toBe(200);
  });

  it('binds a kit to one device until an organiser resets it', async () => {
    const [kit] = await makeKits(t.app, 1);
    const phoneA = new Jar();
    const phoneB = new Jar();
    expect((await req(t.app, phoneA, 'POST', '/api/auth/signin', kit)).statusCode).toBe(200);

    const refused = await req(t.app, phoneB, 'POST', '/api/auth/signin', kit);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('kit_bound');
    // same phone again is fine (e.g. after the session cookie expired)
    expect((await req(t.app, phoneA, 'POST', '/api/auth/signin', kit)).statusCode).toBe(200);

    const admin = await adminJar(t.app);
    const list = (await req(t.app, admin, 'GET', '/api/admin/kits')).json();
    expect(list.kits[0]).toMatchObject({ kitId: kit!.kitId, bound: true, resets: 0 });

    const reset = await req(t.app, admin, 'POST', `/api/admin/kits/${kit!.kitId}/reset`, {});
    expect(reset.json()).toEqual({ kitId: kit!.kitId, password: null });
    // old phone is signed out
    expect((await req(t.app, phoneA, 'GET', '/api/me')).statusCode).toBe(401);
    // new phone can sign in, and is the same attendee (points kept)
    const b = await req(t.app, phoneB, 'POST', '/api/auth/signin', kit);
    expect(b.statusCode).toBe(200);
    expect((await req(t.app, phoneB, 'GET', '/api/points/me')).json().total).toBe(10);
    // ...and now the old phone is the one refused
    expect((await req(t.app, phoneA, 'POST', '/api/auth/signin', kit)).statusCode).toBe(409);
  });

  it('reset with a new password invalidates the old one', async () => {
    const [kit] = await makeKits(t.app, 1);
    const admin = await adminJar(t.app);
    const r = (await req(t.app, admin, 'POST', `/api/admin/kits/${kit!.kitId}/reset`, { newPassword: true })).json();
    expect(r.password).toMatch(/^[A-Z2-9]{6}$/);
    expect((await req(t.app, new Jar(), 'POST', '/api/auth/signin', kit)).statusCode).toBe(401);
    expect((await req(t.app, new Jar(), 'POST', '/api/auth/signin', { kitId: kit!.kitId, password: r.password })).statusCode).toBe(200);
  });

  it('rate limits wrong passwords per kit, even if the next try is right', async () => {
    const [kit, other] = await makeKits(t.app, 2);
    const phone = new Jar();
    for (let i = 0; i < 5; i++) {
      expect((await req(t.app, phone, 'POST', '/api/auth/signin', { kitId: kit!.kitId, password: 'WRONG2' })).statusCode).toBe(401);
    }
    const locked = await req(t.app, phone, 'POST', '/api/auth/signin', kit);
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.retryAfter).toBeGreaterThan(0);
    expect(locked.headers['retry-after']).toBeDefined();
    // other kits are unaffected
    expect((await req(t.app, new Jar(), 'POST', '/api/auth/signin', other)).statusCode).toBe(200);
    // after the window, it works again
    t.clock.advance(5 * 60_000);
    expect((await req(t.app, phone, 'POST', '/api/auth/signin', kit)).statusCode).toBe(200);
  });

  it('rate limits sign-in attempts per IP', async () => {
    const small = await makeApp({ env: { LOGIN_IP_PER_MIN: '3' } });
    try {
      const [kit] = await makeKits(small.app, 1);
      for (let i = 0; i < 3; i++) await req(small.app, new Jar(), 'POST', '/api/auth/signin', { kitId: kit!.kitId, password: 'WRONG2' });
      const r = await req(small.app, new Jar(), 'POST', '/api/auth/signin', kit);
      expect(r.statusCode).toBe(429);
    } finally {
      await small.close();
    }
  });

  it('rate limits wrong console PINs', async () => {
    for (let i = 0; i < 8; i++) await req(t.app, new Jar(), 'POST', '/api/admin/session', { pin: 'nope' });
    expect((await req(t.app, new Jar(), 'POST', '/api/admin/session', { pin: '9999' })).statusCode).toBe(429);
  });

  it('expires sessions after SESSION_HOURS', async () => {
    const [kit] = await makeKits(t.app, 1);
    const { jar } = await signedInAttendee(t.app, kit!);
    expect((await req(t.app, jar, 'GET', '/api/me')).statusCode).toBe(200);
    t.clock.advance(17 * 3600_000);
    expect((await req(t.app, jar, 'GET', '/api/me')).statusCode).toBe(401);
  });

  it('validates input with the shared error shape', async () => {
    const r = await req(t.app, new Jar(), 'POST', '/api/auth/signin', { kitId: 'lol', password: '' });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: { code: 'bad_request' } });
    expect(Array.isArray(r.json().error.issues)).toBe(true);
  });
});
