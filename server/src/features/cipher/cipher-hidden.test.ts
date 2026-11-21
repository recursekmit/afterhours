// The projector while the morse challenge is hidden: nothing of the cipher (players, guild race, pacts) reaches it.
import type { CipherScreen, ScanResult } from '@afterhours/shared/features/cipher';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Jar, SCREEN_PIN, type TestApp, adminJar, makeApp, makeKits, req, signedInAttendee } from '../../../test/helpers';
import { run } from '../../core';
import { copyWords, makeTicketSet } from './testkit';

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => t.close());

describe('cipher projector while hidden', () => {
  it('a projector (not an admin) gets an empty race while hidden; the console still sees it', async () => {
    const { slips } = makeTicketSet(t.ctx, 12);
    const words = copyWords(t.ctx, slips);
    const kits = await makeKits(t.app, 2);
    const a = await signedInAttendee(t.app, kits[0]!, 'tester-a');
    const b = await signedInAttendee(t.app, kits[1]!, 'tester-b');
    expect(((await req(t.app, a.jar, 'POST', '/api/cipher/scan', { text: words.get(1)![0]!.bottom })).json() as ScanResult).outcome).toBe('claimed');
    expect(((await req(t.app, b.jar, 'POST', '/api/cipher/scan', { text: words.get(2)![0]!.bottom })).json() as ScanResult).outcome).toBe('claimed');
    run(t.ctx.db, "INSERT INTO cipher_pacts (a_id, b_id, oracle, a_edge, b_edge, status, created_at, sealed_at) VALUES (?, ?, 0, 'bottom', 'top', 'sealed', 1, 2)", a.id, b.id);

    const admin = await adminJar(t.app);
    await req(t.app, admin, 'PUT', '/api/cipher/admin/visible', { enabled: false });
    const screen = new Jar();
    expect((await req(t.app, screen, 'POST', '/api/screen/session', { pin: SCREEN_PIN })).statusCode).toBe(200);
    const r = await req(t.app, screen, 'GET', '/api/cipher/screen');
    expect(r.statusCode, r.body).toBe(200);
    const view = r.json() as CipherScreen;
    expect(view.visible).toBe(false);
    expect(view.players).toBe(0);
    expect(view.pactsSealed).toBe(0);
    expect(view.recentPacts).toEqual([]);
    expect(view.guilds.every((g) => g.members === 0 && g.points === 0)).toBe(true);
    expect(view.onTrial.every((n) => n === 0)).toBe(true);
    expect(r.body).not.toContain('tester-');

    // the console previewing the projector still sees everything
    const adm = (await req(t.app, admin, 'GET', '/api/cipher/screen')).json() as CipherScreen;
    expect(adm.players).toBe(2);
    expect(adm.pactsSealed).toBe(1);

    // and once shown, the projector sees it too
    await req(t.app, admin, 'PUT', '/api/cipher/admin/visible', { enabled: true });
    expect(((await req(t.app, screen, 'GET', '/api/cipher/screen')).json() as CipherScreen).players).toBe(2);
  });
});
