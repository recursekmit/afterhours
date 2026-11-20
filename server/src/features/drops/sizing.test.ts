// Drops sized to the room: library winners, room goals, the hype meter and "the room is loud" scale to the
// people signed in (60-70 on the day), with floors, and the console can still override.
import { roomSizing, scaleGoal, scaleWinners } from '@afterhours/shared/features/drops';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Jar, type TestApp, adminJar, makeApp, makeKits, req, signedInAttendee } from '../../../test/helpers';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('drops: sizing for the room', () => {
  it('pure: 65 people get about 7 code winners, room goals around 40, floors for tiny rooms, caps at 300', () => {
    expect(scaleWinners(20, 65)).toBe(7);
    expect(scaleWinners(15, 65)).toBe(5);
    expect(scaleWinners(10, 65)).toBe(3);
    expect(scaleWinners(20, 0)).toBe(3);
    expect(scaleWinners(20, 300)).toBe(20);
    expect(scaleWinners(2, 65)).toBe(2);
    expect(scaleGoal(200, 65)).toBe(43);
    expect(scaleGoal(500, 65)).toBe(108);
    expect(scaleGoal(200, 5)).toBe(30);
    expect(scaleGoal(200, 300)).toBe(200);
    expect(roomSizing(65)).toEqual({ present: 65, codeWinners: 7, roomGoal: 43, hypeTarget: 33, loudAt: 15 });
    expect(roomSizing(300)).toMatchObject({ codeWinners: 20, roomGoal: 200, hypeTarget: 150, loudAt: 60 });
  });

  describe('with a server', () => {
    let t: TestApp;
    let admin: Jar;
    beforeEach(async () => {
      t = await makeApp();
      admin = await adminJar(t.app);
    });
    afterEach(async () => t.close());

    async function people(n: number) {
      const kits = await makeKits(t.app, n);
      for (const [i, k] of kits.entries()) await signedInAttendee(t.app, k, `p${i}`);
    }

    it('library drops fire sized to whoever is signed in, with the numbers in the blurb', async () => {
      await people(12);
      const st = (await req(t.app, admin, 'GET', '/api/drops/admin')).json() as J;
      expect(st.room).toMatchObject({ present: 12, codeWinners: 3, roomGoal: 30 });
      const sudo = st.library.find((l: J) => l.id === 'code-sudo');
      expect(sudo.input.config.winners).toBe(3);
      expect(sudo.input.blurb).toBe('the word is on the big screen. first 3 type it, quick.');
      const room = st.library.find((l: J) => l.id === 'room-200');
      expect(room.input.config.goal).toBe(30);
      expect(room.input.blurb).toMatch(/^30 reactions in 60 seconds/);
      const fired = (await req(t.app, admin, 'POST', '/api/drops/admin/library/code-sudo', {})).json() as J;
      expect(fired.config.winners).toBe(3);
      expect(fired.blurb).not.toContain('{');
      // a custom drop keeps exactly what the organiser typed
      await req(t.app, admin, 'POST', `/api/drops/admin/${fired.id}/cancel`, {});
      const own = (await req(t.app, admin, 'POST', '/api/drops/admin', { title: 'mine', durationSec: 30, config: { kind: 'code', code: 'ABC', winners: 20 }, when: 'draft' })).json() as J;
      expect(own.config.winners).toBe(20);
    });

    it('the hype meter sizes itself until an organiser types a number, and can go back to auto', async () => {
      await people(4);
      expect(((await req(t.app, admin, 'GET', '/api/drops/admin')).json() as J).hype.target).toBe(30);
      const set = (await req(t.app, admin, 'PATCH', '/api/drops/admin/settings', { hypeTarget: 90 })).json() as J;
      expect(set).toMatchObject({ hypeTarget: 90, hypeTargetAuto: false });
      expect(((await req(t.app, admin, 'GET', '/api/drops/admin')).json() as J).hype.target).toBe(90);
      await req(t.app, admin, 'PATCH', '/api/drops/admin/settings', { hypeTargetAuto: true });
      expect(((await req(t.app, admin, 'GET', '/api/drops/admin')).json() as J).hype.target).toBe(30);
    });
  });
});
