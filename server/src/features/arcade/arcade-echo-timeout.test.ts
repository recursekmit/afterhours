// Echo (memory) when the clock runs out: the levels cleared in time are banked, never lost.
import { ARCADE_GAMES, type RunResult, type RunStart } from '@afterhours/shared/features/arcade';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Jar, type TestApp, makeApp, makeKits, req, signedInAttendee } from '../../../test/helpers';
import { memoryMinLevelMs, memorySequence } from './games';
import { GRACE_MS, tick } from './index';

describe('echo: time runs out', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp({ env: { LOGIN_IP_PER_MIN: '100000' } });
  });
  afterEach(async () => t.close());

  async function player(): Promise<{ jar: Jar; id: number }> {
    const [kit] = await makeKits(t.app, 1);
    const p = await signedInAttendee(t.app, kit!, 'echoer');
    t.ctx.db.exec('DELETE FROM points_ledger');
    t.ctx.points.invalidate();
    return p;
  }
  const seedOf = (runId: string) => (t.ctx.db.prepare('SELECT seed FROM arcade_runs WHERE id = ?').get(runId) as { seed: number }).seed;

  /** Start a run and clear `levels` levels in good time. */
  async function clear(p: { jar: Jar }, levels: number): Promise<RunStart> {
    const run = (await req(t.app, p.jar, 'POST', '/api/arcade/runs', { game: 'memory' })).json() as RunStart;
    const seq = memorySequence(seedOf(run.runId));
    for (let l = 1; l <= levels; l++) {
      t.clock.advance(memoryMinLevelMs(l) + 700);
      expect((await req(t.app, p.jar, 'POST', `/api/arcade/runs/${run.runId}/step`, { taps: seq.slice(0, l) })).statusCode).toBe(200);
    }
    return run;
  }

  it('finish after the grace window still banks the cleared levels', async () => {
    const p = await player();
    const run = await clear(p, 5);
    t.clock.set(run.startedAt + ARCADE_GAMES.memory.durationMs + GRACE_MS + 2000);
    const r = await req(t.app, p.jar, 'POST', `/api/arcade/runs/${run.runId}/finish`, {});
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json() as RunResult).toMatchObject({ score: 500, label: 'level 5', points: 4 });
    expect(t.ctx.points.total(p.id)).toBe(4);
  });

  it('a late step after the grace window ends the run with the cleared levels', async () => {
    const p = await player();
    const run = await clear(p, 4);
    t.clock.set(run.startedAt + ARCADE_GAMES.memory.durationMs + GRACE_MS + 2000);
    const r = await req(t.app, p.jar, 'POST', `/api/arcade/runs/${run.runId}/step`, { taps: [0, 0, 0, 0, 0] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: 'over', result: { score: 400, points: 2 } });
  });

  it('a phone that never comes back: the tick banks the cleared levels once', async () => {
    const p = await player();
    const run = await clear(p, 3);
    t.clock.set(run.startedAt + ARCADE_GAMES.memory.durationMs + GRACE_MS + 61_000);
    tick(t.ctx);
    tick(t.ctx);
    expect(t.ctx.points.total(p.id)).toBe(2);
    expect((t.ctx.db.prepare('SELECT status, score FROM arcade_runs WHERE id = ?').get(run.runId) as { status: string; score: number })).toEqual({ status: 'done', score: 300 });
    // and a later finish is refused as already scored, without paying twice
    expect((await req(t.app, p.jar, 'POST', `/api/arcade/runs/${run.runId}/finish`, {})).statusCode).toBe(409);
    expect(t.ctx.points.total(p.id)).toBe(2);
  });
});
