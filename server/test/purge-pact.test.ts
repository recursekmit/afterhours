// "purge test player" when the tester is in a cipher pact (cipher_pacts points at attendees through a_id and
// b_id, not attendee_id). Made-up people only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { one, run } from '../src/core/db';
import { AVATAR, Jar, type TestApp, adminJar, makeApp, makeKits, req, signedInAttendee } from './helpers';

describe('purge test player: cipher pacts', () => {
  let t: TestApp;
  let admin: Jar;
  beforeEach(async () => {
    t = await makeApp();
    admin = await adminJar(t.app);
  });
  afterEach(async () => t.close());

  it('purges a tester who was paired in a pact (either side); the partner is left without that pact', async () => {
    const [kit] = await makeKits(t.app, 1);
    const real = await signedInAttendee(t.app, kit!, 'real');
    const p = (await req(t.app, admin, 'POST', '/api/admin/participants', { name: 'Mock Tester', roll: '99BD1A90T1', phone: '9000000001' })).json() as { id: number };
    const jar = new Jar();
    expect((await req(t.app, jar, 'POST', '/api/auth/roll/signin', { roll: '99BD1A90T1', phone4: '0001' })).statusCode).toBe(200);
    const me = (await req(t.app, jar, 'PUT', '/api/me/profile', { name: 'Mock Tester', roll: '99BD1A90T1', nickname: 'mock', avatar: AVATAR })).json() as { attendee: { id: number } };
    const id = me.attendee.id;
    run(t.ctx.db, "INSERT INTO cipher_pacts (a_id, b_id, oracle, a_edge, b_edge, status, created_at) VALUES (?, ?, 0, 'bottom', 'top', 'open', 1)", real.id, id);
    run(t.ctx.db, "INSERT INTO cipher_pacts (a_id, b_id, oracle, a_edge, b_edge, status, created_at) VALUES (?, ?, 0, 'left', 'right', 'broken', 1)", id, real.id);
    run(t.ctx.db, "INSERT INTO cipher_pacts (a_id, b_id, oracle, a_edge, b_edge, status, created_at) VALUES (?, NULL, 1, 'bottom', 'left', 'sealed', 1)", id);

    const r = await req(t.app, admin, 'POST', `/api/admin/participants/${p.id}/purge`, { confirm: '99BD1A90T1' });
    expect(r.statusCode, r.body).toBe(200);
    expect(one(t.ctx.db, 'SELECT 1 AS x FROM attendees WHERE id = ?', id)).toBeUndefined();
    expect(one<{ n: number }>(t.ctx.db, 'SELECT COUNT(*) AS n FROM cipher_pacts WHERE a_id = ? OR b_id = ?', id, id)!.n).toBe(0);
    expect(one(t.ctx.db, 'SELECT 1 AS x FROM attendees WHERE id = ?', real.id)).toBeTruthy();
  });
});
