// Quick sessions through the real app: every template makes the right objects in the right features,
// and go live, end, undo, queue, presets, idempotency and concurrency behave.
import type { AdminDrop, DropsAdminState } from '@afterhours/shared/features/drops';
import type { HuntAdmin } from '@afterhours/shared/features/hunt';
import type { AdminPollList } from '@afterhours/shared/features/polls';
import type { LiveView, Overview, QuickSpecInput } from '@afterhours/shared/features/quick';
import type { ScheduleState } from '@afterhours/shared/features/schedule';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Jar, type TestApp, adminJar, makeApp, makeKits, req, signedInAttendee } from '../../../test/helpers';
import { type Io, makeIo } from './internal';
import { goLive } from './service';

let t: TestApp;
let admin: Jar;
let n = 0;
const key = () => `test-key-${++n}-${Math.random().toString(36).slice(2)}`;

beforeEach(async () => {
  t = await makeApp();
  admin = await adminJar(t.app);
});
afterEach(async () => {
  await t.close();
});

const go = (spec: QuickSpecInput, extra: Record<string, unknown> = {}, k = key()) => req(t.app, admin, 'POST', '/api/quick/go', { key: k, spec, ...extra });
const ok = async (spec: QuickSpecInput, extra: Record<string, unknown> = {}) => {
  const r = await go(spec, extra);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as LiveView;
};
const get = async <T>(url: string) => (await req(t.app, admin, 'GET', url)).json() as T;
const act = async (id: number, action: string) => {
  const r = await req(t.app, admin, 'POST', `/api/quick/sessions/${id}/action`, { action });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as LiveView;
};
const polls = () => get<AdminPollList>('/api/polls/admin').then((r) => r.polls.map((p) => p.poll));
const drops = () => get<DropsAdminState>('/api/drops/admin').then((r) => r.drops);

const quiz3: QuickSpecInput = {
  template: 'quiz',
  secondsPerQuestion: 15,
  questions: [
    { question: 'first question?', options: ['yes', 'no'], correct: 0 },
    { question: 'second question?', options: ['a', 'b', 'c'], correct: 2 },
    { question: 'third question?', options: ['x', 'y'], correct: 1 },
  ],
};

describe('templates make the right things', () => {
  it('poll: a single-choice poll is created and launched', async () => {
    const v = await ok({ template: 'poll', style: 'choice', question: 'best editor?', options: ['vim', 'vscode', 'emacs'] });
    expect(v.session.status).toBe('live');
    const p = (await polls()).find((x) => x.question === 'best editor?');
    expect(p?.kind).toBe('single');
    expect(p?.status).toBe('live');
    expect(v.controls).toEqual(expect.arrayContaining(['close', 'end', 'undo']));
  });

  it('poll: this-or-that and rating', async () => {
    await ok({ template: 'poll', style: 'this_or_that', question: 'tabs or spaces?', options: ['tabs', 'spaces'] });
    expect((await polls())[0]?.kind).toBe('this_or_that');
    await act((await get<Overview>('/api/quick/overview')).live[0]!.id, 'end');
    await ok({ template: 'poll', style: 'rating', question: 'rate the talk', options: [], ratingMax: 7 });
    const p = (await polls()).find((x) => x.question === 'rate the talk');
    expect(p?.kind).toBe('rating');
  });

  it('word cloud', async () => {
    await ok({ template: 'wordcloud', question: 'one word for today', maxWords: 2 });
    const p = (await polls())[0];
    expect(p?.kind).toBe('wordcloud');
    expect(p?.status).toBe('live');
  });

  it('quiz: every question exists, the first is live, one series', async () => {
    const v = await ok(quiz3);
    const all = (await polls()).filter((p) => p.kind === 'quiz');
    expect(all).toHaveLength(3);
    expect(all.filter((p) => p.status === 'live')).toHaveLength(1);
    expect(new Set(all.map((p) => (p.kind === 'quiz' ? p.series : ''))).size).toBe(1);
    expect(v.headline).toContain('Q1');
    expect(v.session.refs.pollIds).toHaveLength(3);
  });

  it('code drop: live with the typed code; an empty code is made up', async () => {
    const v = await ok({ template: 'code', code: 'ship it', winners: 5, windowSec: 45 });
    expect(v.code).toBe('SHIPIT');
    const d = (await drops()).find((x) => x.status === 'live');
    expect(d?.kind).toBe('code');
    expect(d?.slots).toBe(5);
    await act(v.session.id, 'end');
    const v2 = await ok({ template: 'code', code: '', winners: 3 });
    expect(v2.code).toMatch(/^[A-Z0-9]{5}$/);
  });

  it('speed question and room goal', async () => {
    const a = await ok({ template: 'speed', question: 'what does CSS stand for?', choices: [], answers: ['cascading style sheets'] });
    expect((await drops()).find((d) => d.status === 'live')?.kind).toBe('speed');
    await act(a.session.id, 'end');
    const b = await ok({ template: 'room', title: 'everyone react', goal: 40, windowSec: 30, points: 4 });
    const d = (await drops()).find((x) => x.status === 'live') as AdminDrop;
    expect(d.kind).toBe('room');
    expect(d.goal).toBe(40);
    expect(b.stats[0]?.label).toBe('reactions');
  });

  it('morse speed round (switches morse on if it was off)', async () => {
    await req(t.app, admin, 'PUT', '/api/morse/admin/enabled', { enabled: false });
    const v = await ok({ template: 'morse', mode: 'decode', level: 2, durationSec: 90 });
    const m = await get<{ enabled: boolean; sprint: { sprint: { level: number; mode: string; id: number } } | null }>('/api/morse/admin');
    expect(m.enabled).toBe(true);
    expect(m.sprint?.sprint).toMatchObject({ level: 2, mode: 'decode', id: v.session.refs.sprintId });
    expect(v.session.refs.notes?.[0]).toMatch(/switched off/);
  });

  it('check-in: with no activity it makes one, starts it, and opens the window', async () => {
    const v = await ok({ template: 'checkin', activityId: null, closeAfterMin: 10 }, { common: { label: 'Dr Rao' } });
    const sched = await get<ScheduleState>('/api/schedule');
    const act1 = sched.activities.find((a) => a.id === v.session.refs.activityId);
    expect(act1?.title).toBe('Dr Rao: check-in');
    expect(act1?.status).toBe('live');
    const ov = await get<{ windows: { activityId: string; open: boolean; closesAt: number | null }[] }>('/api/attendance/admin/overview');
    expect(ov.windows.find((w) => w.activityId === String(act1?.id))).toMatchObject({ open: true });
    expect(v.code).toMatch(/^[A-Z0-9]{4}$/);
  });

  it('check-in on an existing activity does not invent another', async () => {
    const created = await req(t.app, admin, 'POST', '/api/schedule', { title: 'planned talk', startAt: t.clock.now() + 3_600_000, endAt: t.clock.now() + 7_200_000 });
    const id = (created.json() as ScheduleState).activities.find((a) => a.title === 'planned talk')!.id;
    const before = (await get<ScheduleState>('/api/schedule')).activities.length;
    await ok({ template: 'checkin', activityId: id, closeAfterMin: 0 });
    expect((await get<ScheduleState>('/api/schedule')).activities).toHaveLength(before);
  });

  it('mini hunt: a trail with typed stops is open, riddle and sticker stops', async () => {
    const v = await ok({
      template: 'hunt',
      title: 'lab scavenger',
      pointsPerStop: 12,
      stops: [
        { clue: 'what runs on npm start?', answer: 'node' },
        { clue: 'find the sticker by the door', answer: '' },
      ],
    });
    const h = await get<HuntAdmin>(`/api/hunt/admin?trail=${v.session.refs.trailId}`);
    expect(h.status).toBe('open');
    expect(h.title).toBe('lab scavenger');
    expect(h.stops.map((s) => s.challenge)).toEqual(['riddle', 'scan']);
    expect(h.stops[0]?.points).toBe(12);
    expect(v.trailId).toBe(h.trail.id);
  });

  it('announcement: a banner is logged', async () => {
    const v = await ok({ template: 'announce', title: 'tea time', body: 'chai at the atrium', push: false });
    expect(v.session.status).toBe('ended');
    const st = await get<{ log: { title: string; body: string }[] }>('/api/alerts/status');
    expect(st.log[0]).toMatchObject({ title: 'tea time', body: 'chai at the atrium' });
  });

  it('add to run of show titles the activity from the speaker and starts it; banner optional', async () => {
    const v = await ok(
      { template: 'poll', style: 'this_or_that', question: 'dark or light?', options: ['dark', 'light'] },
      { common: { label: 'Aditi (keynote)', addToRunOfShow: true, durationMin: 4, announce: true, push: false } },
    );
    const sched = await get<ScheduleState>('/api/schedule');
    const a = sched.activities.find((x) => x.id === v.session.refs.activityId);
    expect(a).toMatchObject({ title: 'Aditi (keynote): quick poll', kind: 'poll', status: 'live' });
    expect(sched.nowId).toBe(a?.id);
    const st = await get<{ log: { title: string }[] }>('/api/alerts/status');
    expect(st.log[0]?.title).toBe('quick poll live!');
  });

  it('a pinned projector scene is cleared so the takeover shows', async () => {
    await req(t.app, admin, 'POST', '/api/admin/screen/pin', { sceneId: 'leaderboard' });
    const v = await ok({ template: 'wordcloud', question: 'word of the day', maxWords: 1 });
    expect(v.session.refs.unpinned).toBe('leaderboard');
    expect((await get<{ pinned: string | null }>('/api/screen/state')).pinned).toBeNull();
  });
});

describe('safety', () => {
  it('rejects empty options and bad forms with a readable message', async () => {
    const r = await go({ template: 'poll', style: 'choice', question: 'pick one', options: ['a', ''] });
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.json())).toMatch(/empty/);
    const r2 = await go({ template: 'poll', style: 'choice', question: 'pick one', options: ['only one'] });
    expect(r2.statusCode).toBe(400);
    const r3 = await go({ template: 'quiz', secondsPerQuestion: 20, questions: [{ question: 'no right answer?', options: ['a', 'b'], correct: 5 }] });
    expect(r3.statusCode).toBe(400);
    expect(await polls()).toHaveLength(0);
  });

  it('one live poll at a time: explains, then closes it when asked', async () => {
    await ok({ template: 'poll', style: 'choice', question: 'first poll', options: ['a', 'b'] });
    const r = await go({ template: 'wordcloud', question: 'second poll', maxWords: 1 });
    expect(r.statusCode).toBe(409);
    expect((r.json() as { error: { code: string; message: string } }).error).toMatchObject({ code: 'poll_live' });
    expect((r.json() as { error: { message: string } }).error.message).toContain('first poll');
    // nothing half-made
    expect((await polls()).map((p) => p.question)).toEqual(['first poll']);
    const r2 = await go({ template: 'wordcloud', question: 'second poll', maxWords: 1 }, { closeLive: true });
    expect(r2.statusCode, r2.body).toBe(200);
    const list = await polls();
    expect(list.find((p) => p.question === 'first poll')?.status).toBe('closed');
    expect(list.find((p) => p.question === 'second poll')?.status).toBe('live');
    expect((r2.json() as LiveView).session.refs.displaced).toContain('first poll');
  });

  it('one drop at a time, one speed round at a time', async () => {
    await ok({ template: 'code', code: 'abcd', winners: 3 });
    const r = await go({ template: 'room', title: 'react', goal: 30, windowSec: 30, points: 3 });
    expect(r.statusCode).toBe(409);
    expect((r.json() as { error: { code: string } }).error.code).toBe('drop_live');
    await ok({ template: 'morse', mode: 'decode', level: 1, durationSec: 60 });
    const m = await go({ template: 'morse', mode: 'encode', level: 1, durationSec: 60 });
    expect((m.json() as { error: { code: string } }).error.code).toBe('morse_live');
  });

  it('the same key twice is one session (a double press)', async () => {
    const k = key();
    const spec: QuickSpecInput = { template: 'wordcloud', question: 'double press', maxWords: 1 };
    const a = await go(spec, {}, k);
    const b = await go(spec, {}, k);
    expect((a.json() as LiveView).session.id).toBe((b.json() as LiveView).session.id);
    expect((await polls()).filter((p) => p.question === 'double press')).toHaveLength(1);
  });

  it('two organisers at once: same key is one launch; different keys, only one poll goes live', async () => {
    const k = key();
    const spec: QuickSpecInput = { template: 'poll', style: 'this_or_that', question: 'race condition?', options: ['yes', 'no'] };
    const same = await Promise.all([go(spec, {}, k), go(spec, {}, k), go(spec, {}, k)]);
    expect(same.every((r) => r.statusCode === 200)).toBe(true);
    expect(new Set(same.map((r) => (r.json() as LiveView).session.id)).size).toBe(1);
    expect((await polls()).filter((p) => p.question === 'race condition?')).toHaveLength(1);

    const [a, b] = await Promise.all([
      go({ template: 'wordcloud', question: 'organiser a poll', maxWords: 1 }, { closeLive: false }),
      go({ template: 'wordcloud', question: 'organiser b poll', maxWords: 1 }, { closeLive: false }),
    ]);
    // the first poll from above is still live, so both are refused: nobody gets a half-made second poll
    expect([a.statusCode, b.statusCode]).toEqual([409, 409]);
    const live = (await polls()).filter((p) => p.status === 'live');
    expect(live).toHaveLength(1);
  });

  it('two organisers racing for a free slot: exactly one wins, the other is told why', async () => {
    const [a, b] = await Promise.all([
      go({ template: 'wordcloud', question: 'organiser a poll', maxWords: 1 }),
      go({ template: 'wordcloud', question: 'organiser b poll', maxWords: 1 }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect((await polls()).filter((p) => p.status === 'live')).toHaveLength(1);
    expect(await polls()).toHaveLength(1);
  });

  it('a failure part way rolls everything back (and the key can be retried)', async () => {
    const real = makeIo(t.app, t.ctx);
    const failing: Io = {
      async call<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
        if (method === 'POST' && /\/launch$/.test(url)) throw new Error('boom');
        return real.call<T>(method, url, body);
      },
    };
    const k = key();
    const input = {
      key: k,
      spec: { template: 'wordcloud' as const, question: 'will fail', maxWords: 1 },
      common: { label: 'someone', addToRunOfShow: true, durationMin: null, announce: false, announceText: '', push: true },
      closeLive: false,
      presetId: null,
    };
    await expect(goLive(t.ctx, failing, input, false)).rejects.toThrow('boom');
    expect(await polls()).toHaveLength(0);
    expect((await get<ScheduleState>('/api/schedule')).activities.some((a) => a.title.includes('someone'))).toBe(false);
    const retry = await go(input.spec, { common: input.common }, k);
    expect(retry.statusCode, retry.body).toBe(200);
  });
});

describe('controls', () => {
  it('poll: close, reveal, then it is done', async () => {
    const v = await ok({ template: 'poll', style: 'choice', question: 'close then reveal', options: ['a', 'b'] });
    const closed = await act(v.session.id, 'close');
    expect(closed.phase).toBe('closed');
    expect(closed.controls).toContain('reveal');
    const done = await act(v.session.id, 'reveal');
    expect(done.session.status).toBe('ended');
    expect((await polls())[0]?.status).toBe('revealed');
  });

  it('poll: end closes and reveals in one press and ends the run-of-show item it made', async () => {
    const v = await ok({ template: 'wordcloud', question: 'end it', maxWords: 1 }, { common: { addToRunOfShow: true } });
    const done = await act(v.session.id, 'end');
    expect(done.session.status).toBe('ended');
    expect((await polls())[0]?.status).toBe('revealed');
    const sched = await get<ScheduleState>('/api/schedule');
    expect(sched.activities.find((a) => a.id === v.session.refs.activityId)?.status).toBe('ended');
  });

  it('quiz: close, reveal, next, ... the last reveal finishes the session', async () => {
    const v = await ok(quiz3);
    const id = v.session.id;
    await act(id, 'close');
    const rev = await act(id, 'reveal');
    expect(rev.controls).toContain('next');
    const q2 = await act(id, 'next');
    expect(q2.headline).toContain('Q2');
    expect(q2.phase).toBe('live');
    await act(id, 'close');
    await act(id, 'reveal');
    const q3 = await act(id, 'next');
    expect(q3.headline).toContain('Q3');
    await act(id, 'close');
    const end = await act(id, 'reveal');
    expect(end.session.status).toBe('ended');
    expect((await polls()).every((p) => p.status === 'revealed')).toBe(true);
  });

  it('a control that does not apply is refused', async () => {
    const v = await ok({ template: 'wordcloud', question: 'not yet', maxWords: 1 });
    const r = await req(t.app, admin, 'POST', `/api/quick/sessions/${v.session.id}/action`, { action: 'reveal' });
    expect(r.statusCode).toBe(409);
  });

  it('drop: end cancels it; a drop that runs out by itself is filed as ended', async () => {
    const a = await ok({ template: 'room', title: 'react', goal: 30, windowSec: 30, points: 3 });
    const ended = await act(a.session.id, 'end');
    expect(ended.session.status).toBe('ended');
    const b = await ok({ template: 'code', code: 'ABCD', winners: 3, windowSec: 20 });
    t.clock.advance(60_000);
    const v = (await req(t.app, admin, 'GET', `/api/quick/sessions/${b.session.id}`)).json() as LiveView;
    expect(v.phase).toBe('done');
    expect(v.session.status).toBe('ended');
  });

  it('extend adds a minute to the run-of-show item', async () => {
    const v = await ok({ template: 'wordcloud', question: 'more time', maxWords: 1 }, { common: { addToRunOfShow: true, durationMin: 5 } });
    const before = (await get<ScheduleState>('/api/schedule')).activities.find((a) => a.id === v.session.refs.activityId)!;
    await act(v.session.id, 'extend');
    const after = (await get<ScheduleState>('/api/schedule')).activities.find((a) => a.id === v.session.refs.activityId)!;
    expect(after.endAt - before.endAt).toBe(60_000);
  });

  it('check-in: extend moves the auto-close, end closes the window', async () => {
    const v = await ok({ template: 'checkin', activityId: null, closeAfterMin: 5 });
    const w1 = (await get<{ windows: { closesAt: number }[] }>('/api/attendance/admin/overview')).windows[0]!;
    await act(v.session.id, 'extend');
    const w2 = (await get<{ windows: { closesAt: number }[] }>('/api/attendance/admin/overview')).windows[0]!;
    expect(w2.closesAt - w1.closesAt).toBe(60_000);
    const done = await act(v.session.id, 'end');
    expect(done.session.status).toBe('ended');
    expect((await get<{ windows: { open: boolean }[] }>('/api/attendance/admin/overview')).windows[0]?.open).toBe(false);
  });

  it('hunt: end closes the trail', async () => {
    const v = await ok({ template: 'hunt', title: 'quick trail', pointsPerStop: 10, stops: [{ clue: 'clue one here', answer: 'one' }, { clue: 'clue two here', answer: 'two' }] });
    await act(v.session.id, 'end');
    expect((await get<HuntAdmin>(`/api/hunt/admin?trail=${v.session.refs.trailId}`)).status).toBe('closed');
  });
});

describe('undo', () => {
  it('a live quiz is taken back completely: no polls, no activity, a poll can launch again', async () => {
    const v = await ok(quiz3, { common: { label: 'oops', addToRunOfShow: true } });
    expect((await get<ScheduleState>('/api/schedule')).activities.some((a) => a.id === v.session.refs.activityId)).toBe(true);
    const u = await act(v.session.id, 'undo');
    expect(u.session.status).toBe('undone');
    expect(await polls()).toHaveLength(0);
    expect((await get<ScheduleState>('/api/schedule')).activities.some((a) => a.id === v.session.refs.activityId)).toBe(false);
    await ok({ template: 'wordcloud', question: 'fresh start', maxWords: 1 });
  });

  it('a drop and a check-in are taken back', async () => {
    const d = await ok({ template: 'code', code: 'UNDO', winners: 3 });
    await act(d.session.id, 'undo');
    expect((await drops()).filter((x) => x.status === 'live')).toHaveLength(0);
    const c = await ok({ template: 'checkin', activityId: null, closeAfterMin: 0 });
    await act(c.session.id, 'undo');
    expect((await get<ScheduleState>('/api/schedule')).activities.some((a) => a.id === c.session.refs.activityId)).toBe(false);
  });

  it('an ended session cannot be undone twice', async () => {
    const v = await ok({ template: 'wordcloud', question: 'once only', maxWords: 1 });
    await act(v.session.id, 'undo');
    const r = await req(t.app, admin, 'POST', `/api/quick/sessions/${v.session.id}/action`, { action: 'undo' });
    expect(r.statusCode).toBe(409);
  });
});

describe('queue, history, re-run', () => {
  it('queue saves without launching; launch makes it live once even if pressed twice', async () => {
    const r = await req(t.app, admin, 'POST', '/api/quick/queue', { key: key(), spec: { template: 'wordcloud', question: 'for later', maxWords: 1 } });
    expect(r.statusCode).toBe(200);
    const s = r.json() as { id: number; status: string };
    expect(s.status).toBe('queued');
    expect(await polls()).toHaveLength(0);
    const [a, b] = await Promise.all([req(t.app, admin, 'POST', `/api/quick/sessions/${s.id}/go`, {}), req(t.app, admin, 'POST', `/api/quick/sessions/${s.id}/go`, {})]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(await polls()).toHaveLength(1);
    expect((await polls())[0]?.status).toBe('live');
  });

  it('history lists finished sessions and re-run launches the same spec as a new session', async () => {
    const v = await ok({ template: 'poll', style: 'this_or_that', question: 'again?', options: ['yes', 'no'] });
    await act(v.session.id, 'end');
    const ov = await get<Overview>('/api/quick/overview');
    expect(ov.history[0]?.id).toBe(v.session.id);
    expect(ov.live).toHaveLength(0);
    const r = await req(t.app, admin, 'POST', `/api/quick/sessions/${v.session.id}/rerun`, { key: key() });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as LiveView).session.id).not.toBe(v.session.id);
    expect((await polls()).filter((p) => p.question === 'again?')).toHaveLength(2);
  });

  it('a queued session can be removed', async () => {
    const q = (await req(t.app, admin, 'POST', '/api/quick/queue', { key: key(), spec: { template: 'wordcloud', question: 'never mind', maxWords: 1 } })).json() as { id: number };
    const u = await act(q.id, 'undo');
    expect(u.session.status).toBe('undone');
  });
});

describe('presets', () => {
  it('starters are seeded and each one launches', async () => {
    const { presets } = await get<{ presets: { id: number; name: string; builtin: boolean }[] }>('/api/quick/presets');
    const names = presets.map((p) => p.name);
    for (const want of ['favourite language', 'tabs vs spaces', 'rate this talk', '3-question recap quiz', 'first to type the code', 'decode this word', 'everyone react \u{1F525}']) expect(names).toContain(want);
    expect(presets.every((p) => p.builtin)).toBe(true);
    for (const p of presets) {
      const r = await req(t.app, admin, 'POST', `/api/quick/presets/${p.id}/go`, { key: key(), closeLive: true });
      expect(r.statusCode, `${p.name}: ${r.body}`).toBe(200);
    }
  });

  it('starter presets are sized to the room at launch', async () => {
    const kits = await makeKits(t.app, 12);
    for (const k of kits) await signedInAttendee(t.app, k, `p${k.kitId.slice(0, 5)}`);
    const { presets } = await get<{ presets: { id: number; name: string }[] }>('/api/quick/presets');
    const code = presets.find((p) => p.name === 'first to type the code')!;
    const r = await req(t.app, admin, 'POST', `/api/quick/presets/${code.id}/go`, { key: key() });
    const view = r.json() as LiveView;
    const ov = await get<Overview>('/api/quick/overview');
    const d = (await drops()).find((x) => x.id === view.session.refs.dropId)!;
    expect(ov.present).toBe(12);
    expect(d.slots).toBe(ov.sizing.codeWinners);
  });

  it('save, reuse and delete your own; starters cannot be deleted; the speaker label is passed on', async () => {
    const saved = await req(t.app, admin, 'POST', '/api/quick/presets', {
      name: 'my hot take',
      spec: { template: 'poll', style: 'this_or_that', question: 'hot take?', options: ['agree', 'disagree'] },
      common: { label: '' },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const p = saved.json() as { id: number; builtin: boolean };
    expect(p.builtin).toBe(false);
    const r = await req(t.app, admin, 'POST', `/api/quick/presets/${p.id}/go`, { key: key(), label: 'Prof Mehta' });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as LiveView).session.common.label).toBe('Prof Mehta');
    const del = await req(t.app, admin, 'DELETE', `/api/quick/presets/${p.id}`);
    expect(del.statusCode).toBe(200);
    const { presets } = await get<{ presets: { id: number }[] }>('/api/quick/presets');
    expect(presets.some((x) => x.id === p.id)).toBe(false);
    const builtin = presets[0]!;
    expect((await req(t.app, admin, 'DELETE', `/api/quick/presets/${builtin.id}`)).statusCode).toBe(409);
  });

  it('the console only: no admin session, no access', async () => {
    const r = await req(t.app, null, 'POST', '/api/quick/go', { key: key(), spec: { template: 'wordcloud', question: 'sneaky', maxWords: 1 } });
    expect(r.statusCode).toBe(401);
    expect((await req(t.app, null, 'GET', '/api/quick/overview')).statusCode).toBe(401);
  });
});
