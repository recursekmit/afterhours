// Quick sessions: launch, watch, end and undo. See shared/src/features/quick.ts for the contract.
//
// Every step that touches another feature goes through `Io` (its admin routes). Anything that fails after
// something was created rolls the earlier steps back, so a failed "go live" leaves nothing half-made.
import type { ScreenState } from '@afterhours/shared';
import type { AdminOverview } from '@afterhours/shared/features/attendance';
import type { AnnounceResponse } from '@afterhours/shared/features/alerts';
import type { AdminDrop, DropsAdminState } from '@afterhours/shared/features/drops';
import { roomSizing } from '@afterhours/shared/features/drops';
import type { HuntAdmin } from '@afterhours/shared/features/hunt';
import type { MorseOverview, SprintPublic } from '@afterhours/shared/features/morse';
import type { AdminPoll, AdminPollList, AdminResults } from '@afterhours/shared/features/polls';
import {
  type Common,
  CommonSchema,
  type Control,
  type GoRequest,
  GoRequestSchema,
  type LiveView,
  type Overview,
  type Preset,
  PresetSchema,
  type QuickSpec,
  QuickSpecSchema,
  type Session,
  type SessionAction,
  type SessionRefs,
  SessionRefsSchema,
  type SessionStatus,
  TEMPLATE_TITLES,
  type TemplateId,
  defaultDurationMin,
  randomCode,
  sessionTitle,
} from '@afterhours/shared/features/quick';
import type { ScheduleState } from '@afterhours/shared/features/schedule';
import { type FeatureContext, HttpError, all, badRequest, conflict, notFound, one, run } from '../../core';
import { presentCount } from '../drops/settings';
import type { Io } from './internal';

const MIN = 60_000;

// ---- rows -------------------------------------------------------------------------

interface SessionRow {
  id: number;
  key: string;
  template: string;
  title: string;
  status: string;
  spec: string;
  common: string;
  refs: string;
  preset_id: number | null;
  created_at: number;
  live_at: number | null;
  ended_at: number | null;
}

function toSession(r: SessionRow): Session {
  return {
    id: r.id,
    template: r.template as TemplateId,
    title: r.title,
    status: r.status as SessionStatus,
    spec: QuickSpecSchema.parse(JSON.parse(r.spec)),
    common: CommonSchema.parse(JSON.parse(r.common)),
    refs: SessionRefsSchema.parse(JSON.parse(r.refs)),
    presetId: r.preset_id,
    createdAt: r.created_at,
    liveAt: r.live_at,
    endedAt: r.ended_at,
  };
}

export function getSession(ctx: FeatureContext, id: number): Session {
  const r = one<SessionRow>(ctx.db, 'SELECT * FROM quick_sessions WHERE id = ?', id);
  if (!r) throw notFound('No such quick session.');
  return toSession(r);
}

function sessionByKey(ctx: FeatureContext, key: string): Session | null {
  const r = one<SessionRow>(ctx.db, 'SELECT * FROM quick_sessions WHERE key = ?', key);
  return r ? toSession(r) : null;
}

function saveRefs(ctx: FeatureContext, id: number, refs: SessionRefs): void {
  run(ctx.db, 'UPDATE quick_sessions SET refs = ? WHERE id = ?', JSON.stringify(refs), id);
}

function setStatus(ctx: FeatureContext, id: number, status: SessionStatus): void {
  const now = ctx.now();
  if (status === 'live') run(ctx.db, 'UPDATE quick_sessions SET status = ?, live_at = ? WHERE id = ?', status, now, id);
  else if (status === 'queued') run(ctx.db, 'UPDATE quick_sessions SET status = ? WHERE id = ?', status, id);
  else run(ctx.db, 'UPDATE quick_sessions SET status = ?, ended_at = ? WHERE id = ?', status, now, id);
}

function insertSession(ctx: FeatureContext, key: string, spec: QuickSpec, common: Common, status: SessionStatus, presetId: number | null): Session {
  const title = sessionTitle(spec, common.label);
  const now = ctx.now();
  const r = run(
    ctx.db,
    'INSERT INTO quick_sessions (key, template, title, status, spec, common, refs, preset_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    key,
    spec.template,
    title,
    status,
    JSON.stringify(spec),
    JSON.stringify(common),
    '{}',
    presetId,
    now,
  );
  return getSession(ctx, r.lastId);
}

// ---- one thing at a time ----------------------------------------------------------------

const chains = new WeakMap<FeatureContext, Promise<unknown>>();
/** Everything that launches or changes a session runs one after the other, so two organisers cannot interleave. */
export function serial<T>(ctx: FeatureContext, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(ctx) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(ctx, next.catch(() => undefined));
  return next;
}

// ---- what is on the air ------------------------------------------------------------------

interface Busy {
  pollId: number | null;
  poll: string | null;
  dropId: number | null;
  drop: string | null;
  sprintId: number | null;
  morse: string | null;
}

async function readBusy(io: Io): Promise<Busy> {
  const [polls, drops, morse] = await Promise.all([
    io.call<AdminPollList>('GET', '/api/polls/admin'),
    io.call<DropsAdminState>('GET', '/api/drops/admin'),
    io.call<MorseOverview>('GET', '/api/morse/admin'),
  ]);
  const p = polls.polls.find((x) => x.poll.status === 'live')?.poll;
  const d = drops.drops.find((x) => x.status === 'live');
  const sp = morse.sprint?.sprint;
  return {
    pollId: p?.id ?? null,
    poll: p?.question ?? null,
    dropId: d?.id ?? null,
    drop: d ? d.title : null,
    sprintId: sp?.id ?? null,
    morse: sp ? `a ${sp.mode} speed round` : null,
  };
}

/** Which "one at a time" slot a template needs. */
function slotOf(t: TemplateId): 'poll' | 'drop' | 'morse' | null {
  if (t === 'poll' || t === 'wordcloud' || t === 'quiz') return 'poll';
  if (t === 'code' || t === 'speed' || t === 'room') return 'drop';
  if (t === 'morse') return 'morse';
  return null;
}

/** Refuse (409 with a code the form understands) or, with closeLive, take down what is in the way. */
async function clearSlot(io: Io, t: TemplateId, closeLive: boolean, refs: SessionRefs): Promise<void> {
  const slot = slotOf(t);
  if (!slot) return;
  const busy = await readBusy(io);
  if (slot === 'poll' && busy.pollId !== null) {
    if (!closeLive) throw new HttpError(409, 'poll_live', `A poll is already live: "${busy.poll}". Close it and launch this one?`);
    await io.call('POST', `/api/polls/admin/${busy.pollId}/close`);
    refs.displaced = `poll "${busy.poll}" was closed`;
  } else if (slot === 'drop' && busy.dropId !== null) {
    if (!closeLive) throw new HttpError(409, 'drop_live', `A drop is already live: "${busy.drop}". Cancel it and launch this one?`);
    await io.call('POST', `/api/drops/admin/${busy.dropId}/cancel`);
    refs.displaced = `drop "${busy.drop}" was cancelled`;
  } else if (slot === 'morse' && busy.sprintId !== null) {
    if (!closeLive) throw new HttpError(409, 'morse_live', `${busy.morse} is already running. End it and start this one?`);
    await io.call('POST', '/api/morse/admin/sprint/end');
    refs.displaced = `${busy.morse} was ended`;
  }
}

// ---- launching -----------------------------------------------------------------------------

const KIND: Record<TemplateId, 'poll' | 'game' | 'morse' | 'hunt' | 'other'> = {
  poll: 'poll',
  wordcloud: 'poll',
  quiz: 'poll',
  code: 'game',
  speed: 'game',
  room: 'game',
  morse: 'morse',
  checkin: 'other',
  hunt: 'hunt',
  announce: 'other',
};
const LINK: Partial<Record<TemplateId, string>> = { poll: '/polls', wordcloud: '/polls', quiz: '/polls', morse: '/morse', hunt: '/hunt' };

async function readSchedule(io: Io): Promise<ScheduleState> {
  return io.call<ScheduleState>('GET', '/api/schedule');
}

async function makeActivity(ctx: FeatureContext, io: Io, s: Session, refs: SessionRefs): Promise<number> {
  const now = ctx.now();
  const dur = (s.common.durationMin ?? defaultDurationMin(s.spec)) * MIN;
  const startAt = now + 1000; // upcoming at creation, so "start" can take over from whatever is running
  const state = await io.call<ScheduleState>('POST', '/api/schedule', {
    title: s.title,
    blurb: 'quick session',
    kind: KIND[s.template],
    link: LINK[s.template] ?? null,
    startAt,
    endAt: startAt + dur,
  });
  const made = [...state.activities].filter((a) => a.title === s.title).sort((a, b) => b.id - a.id)[0];
  if (!made) throw conflict('The run of show did not take the new activity.');
  refs.activityId = made.id;
  refs.activityMade = true;
  try {
    await io.call('POST', `/api/schedule/${made.id}/start`);
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 409) throw e;
  }
  return made.id;
}

function pollDefs(s: Session): Record<string, unknown>[] {
  const spec = s.spec;
  if (spec.template === 'wordcloud') return [{ kind: 'wordcloud', question: spec.question, maxWords: spec.maxWords }];
  if (spec.template === 'quiz') {
    return spec.questions.map((q) => ({
      kind: 'quiz',
      question: q.question,
      options: q.options.map((label) => ({ label })),
      correct: q.correct,
      durationMs: spec.secondsPerQuestion * 1000,
      basePoints: spec.basePoints,
      speedBonusMax: spec.speedBonus,
      series: `quick-${s.id}`,
    }));
  }
  if (spec.template !== 'poll') return [];
  const opts = spec.options.map((l) => l.trim()).filter(Boolean).map((label) => ({ label }));
  if (spec.style === 'rating') return [{ kind: 'rating', question: spec.question, scale: { min: 1, max: spec.ratingMax, style: 'slider', lowLabel: '', highLabel: '' } }];
  if (spec.style === 'this_or_that') return [{ kind: 'this_or_that', question: spec.question, options: opts }];
  return [{ kind: 'single', question: spec.question, options: opts }];
}

async function launchPolls(io: Io, s: Session, refs: SessionRefs, undo: (() => Promise<void>)[]): Promise<void> {
  const ids: number[] = [];
  for (const def of pollDefs(s)) {
    const made = await io.call<AdminPoll>('POST', '/api/polls/admin', def);
    ids.push(made.poll.id);
    undo.push(async () => {
      await io.call('POST', `/api/polls/admin/${made.poll.id}/close`).catch(() => undefined);
      await io.call('DELETE', `/api/polls/admin/${made.poll.id}`);
    });
  }
  refs.pollIds = ids;
  refs.cursor = 0;
  await io.call('POST', `/api/polls/admin/${ids[0]}/launch`, { closeCurrent: false });
}

async function launchDrop(io: Io, s: Session, refs: SessionRefs, undo: (() => Promise<void>)[]): Promise<void> {
  const spec = s.spec;
  let body: Record<string, unknown>;
  const label = s.common.label.trim();
  if (spec.template === 'code') {
    body = {
      title: (label ? `${label}: code drop` : 'code drop').slice(0, 60),
      durationSec: spec.windowSec,
      config: { kind: 'code', code: spec.code || randomCode(5), display: spec.display, winners: spec.winners, winPoints: spec.winPoints, restPoints: spec.restPoints },
    };
  } else if (spec.template === 'speed') {
    const choices = spec.choices.filter((c) => c.length > 0);
    body = {
      title: (label ? `${label}: speed question` : 'speed question').slice(0, 60),
      durationSec: spec.windowSec,
      config: {
        kind: 'speed',
        question: spec.question,
        choices,
        correct: choices.length ? spec.correct : null,
        answers: choices.length ? [] : spec.answers.filter(Boolean),
        topPoints: spec.topPoints,
        floorPoints: Math.min(5, spec.topPoints),
      },
    };
  } else if (spec.template === 'room') {
    body = { title: spec.title || 'everyone react', durationSec: spec.windowSec, config: { kind: 'room', goal: spec.goal, points: spec.points } };
  } else throw badRequest('Not a drop.');
  const made = await io.call<AdminDrop>('POST', '/api/drops/admin', { ...body, when: 'now' });
  refs.dropId = made.id;
  undo.push(async () => void (await io.call('POST', `/api/drops/admin/${made.id}/cancel`)));
}

async function launchMorse(io: Io, s: Session, refs: SessionRefs, undo: (() => Promise<void>)[]): Promise<void> {
  if (s.spec.template !== 'morse') throw badRequest('Not a morse round.');
  const ov = await io.call<MorseOverview>('GET', '/api/morse/admin');
  const notes = (refs.notes ??= []);
  if (!ov.enabled) {
    await io.call('PUT', '/api/morse/admin/enabled', { enabled: true });
    notes.push('morse was switched off; it is on now');
  }
  const sp = await io.call<SprintPublic>('POST', '/api/morse/admin/sprint', { mode: s.spec.mode, level: s.spec.level, durationSec: s.spec.durationSec });
  refs.sprintId = sp.id;
  undo.push(async () => void (await io.call('POST', '/api/morse/admin/sprint/end')));
}

async function launchCheckin(ctx: FeatureContext, io: Io, s: Session, refs: SessionRefs, undo: (() => Promise<void>)[]): Promise<void> {
  if (s.spec.template !== 'checkin') throw badRequest('Not a check-in.');
  let activityId = s.spec.activityId;
  if (activityId === null) {
    activityId = await makeActivity(ctx, io, s, refs);
    const made = activityId;
    undo.push(async () => void (await io.call('DELETE', `/api/schedule/${made}`)));
  } else {
    const st = await readSchedule(io);
    if (!st.activities.some((a) => a.id === activityId)) throw notFound('That run of show item is gone. Pick another or make a new session.');
    refs.activityId = activityId;
  }
  const closesAt = s.spec.closeAfterMin > 0 ? ctx.now() + s.spec.closeAfterMin * MIN : null;
  const act = (await readSchedule(io)).activities.find((a) => a.id === activityId);
  await io.call('POST', '/api/attendance/admin/open', { activityId: String(activityId), title: (act?.title ?? s.title).slice(0, 120), closesAt });
  refs.checkinActivityId = String(activityId);
  const id = String(activityId);
  undo.push(async () => void (await io.call('POST', '/api/attendance/admin/close', { activityId: id })));
}

async function launchHunt(io: Io, s: Session, refs: SessionRefs): Promise<void> {
  const spec = s.spec;
  if (spec.template !== 'hunt') throw badRequest('Not a hunt.');
  const made = await io.call<HuntAdmin>('POST', '/api/hunt/admin/trails', { title: spec.title, kind: 'hunt', orderMode: 'shuffled', hintsOn: false, cooldownOn: true });
  const trail = made.trail.id;
  refs.trailId = trail;
  let i = 0;
  for (const stop of spec.stops) {
    i += 1;
    const answers = stop.answer ? [stop.answer] : [];
    await io.call('POST', `/api/hunt/admin/stops?trail=${trail}`, {
      title: `stop ${i}`,
      clue: stop.clue,
      challenge: answers.length ? 'riddle' : 'scan',
      answers,
      points: spec.pointsPerStop,
      location: answers.length ? '' : 'print the sticker and stick it where the clue points',
    });
  }
  await io.call('PUT', `/api/hunt/admin/state?trail=${trail}`, { status: 'open' });
}

/** The banner: after a launch (common.announce) or on its own (the announcement template). */
async function announce(io: Io, s: Session, refs: SessionRefs): Promise<void> {
  const notes = (refs.notes ??= []);
  let body: Record<string, unknown>;
  if (s.spec.template === 'announce') body = { title: s.spec.title, body: s.spec.body, push: s.spec.push };
  else
    body = {
      title: `${TEMPLATE_TITLES[s.template]} live!`.slice(0, 60),
      body: (s.common.announceText || `${s.title} is on now. open the app.`).slice(0, 200),
      push: s.common.push,
      ...(LINK[s.template] ? { link: LINK[s.template] } : {}),
    };
  const res = await io.call<AnnounceResponse>('POST', '/api/alerts/announce', body);
  refs.bannerId = res.banner.id;
  if (body.push === true && res.push === null) notes.push('banner sent; push is not set up on this server');
  else if (res.push && res.push.sent === 0) notes.push('banner sent; no phone has push turned on yet');
}

/** The projector shows takeovers by itself, but a pinned scene beats them: clear it. */
async function freeProjector(io: Io, refs: SessionRefs): Promise<void> {
  const st = await io.call<ScreenState>('GET', '/api/screen/state');
  if (st.pinned) {
    await io.call('POST', '/api/admin/screen/pin', { sceneId: null });
    refs.unpinned = st.pinned;
    (refs.notes ??= []).push(`the projector was pinned to "${st.pinned}"; unpinned so this shows`);
  }
}

/** Make everything the session needs. Anything made before a failure is taken back. */
async function launch(ctx: FeatureContext, io: Io, s: Session, closeLive: boolean): Promise<SessionRefs> {
  const refs: SessionRefs = { notes: [] };
  const undo: (() => Promise<void>)[] = [];
  try {
    await clearSlot(io, s.template, closeLive, refs);
    if (s.common.addToRunOfShow && s.template !== 'checkin' && s.template !== 'announce') {
      const id = await makeActivity(ctx, io, s, refs);
      undo.push(async () => void (await io.call('DELETE', `/api/schedule/${id}`)));
    }
    switch (s.template) {
      case 'poll':
      case 'wordcloud':
      case 'quiz':
        await launchPolls(io, s, refs, undo);
        break;
      case 'code':
      case 'speed':
      case 'room':
        await launchDrop(io, s, refs, undo);
        break;
      case 'morse':
        await launchMorse(io, s, refs, undo);
        break;
      case 'checkin':
        await launchCheckin(ctx, io, s, refs, undo);
        break;
      case 'hunt':
        await launchHunt(io, s, refs);
        break;
      case 'announce':
        break;
    }
    if (s.template !== 'announce' && s.template !== 'hunt') await freeProjector(io, refs);
    if (s.template === 'announce') await announce(io, s, refs);
    else if (s.common.announce) {
      // the activity is already live; a banner that failed (rate limit) is a note, not a reason to undo it
      await announce(io, s, refs).catch((e: unknown) => void (refs.notes ??= []).push(`the banner failed: ${e instanceof Error ? e.message : 'unknown'}`));
    }
  } catch (e) {
    for (const u of undo.reverse()) await u().catch(() => undefined);
    throw e;
  }
  if (refs.notes?.length === 0) delete refs.notes;
  return refs;
}

/** Put a queued or new session on the air. */
async function activate(ctx: FeatureContext, io: Io, s: Session, closeLive: boolean, fresh: boolean): Promise<Session> {
  let refs: SessionRefs;
  try {
    refs = await launch(ctx, io, s, closeLive);
  } catch (e) {
    // A brand new session that failed leaves no row behind (so the same key may be retried); a queued one stays queued.
    if (fresh) run(ctx.db, 'DELETE FROM quick_sessions WHERE id = ?', s.id);
    throw e;
  }
  saveRefs(ctx, s.id, refs);
  setStatus(ctx, s.id, s.template === 'announce' ? 'ended' : 'live');
  if (s.template === 'announce') run(ctx.db, 'UPDATE quick_sessions SET live_at = ? WHERE id = ?', ctx.now(), s.id);
  ctx.live.publish('quick.changed', { at: ctx.now() }, 'admins');
  return getSession(ctx, s.id);
}

/** POST /go: idempotent on `key`. Returns the existing session when the key was used. */
export function goLive(ctx: FeatureContext, io: Io, req: GoRequest, queueOnly: boolean): Promise<Session> {
  const body = GoRequestSchema.parse(req);
  return serial(ctx, async () => {
    const again = sessionByKey(ctx, body.key);
    if (again) return again;
    const s = insertSession(ctx, body.key, body.spec, body.common, 'queued', body.presetId);
    if (queueOnly) {
      ctx.live.publish('quick.changed', { at: ctx.now() }, 'admins');
      return s;
    }
    return activate(ctx, io, s, body.closeLive, true);
  });
}

/** Launch a queued session. Already live: returns it as it is (a second press does nothing). */
export function launchQueued(ctx: FeatureContext, io: Io, id: number, closeLive: boolean): Promise<Session> {
  return serial(ctx, async () => {
    const s = getSession(ctx, id);
    if (s.status === 'live') return s;
    if (s.status !== 'queued') throw conflict(`That session is ${s.status}; re-run it instead.`);
    return activate(ctx, io, s, closeLive, false);
  });
}

/** Same spec, a new session. `label` lets the speaker view say who it is for. */
export function rerun(ctx: FeatureContext, io: Io, source: { spec: QuickSpec; common: Common; presetId: number | null }, key: string, closeLive: boolean, label?: string): Promise<Session> {
  const common = label === undefined ? source.common : { ...source.common, label };
  return goLive(ctx, io, { key, spec: source.spec, common, closeLive, presetId: source.presetId }, false);
}

// ---- presets ----------------------------------------------------------------------------------

interface PresetRow {
  id: number;
  name: string;
  template: string;
  spec: string;
  common: string;
  builtin: number;
  created_at: number;
}

function toPreset(r: PresetRow): Preset {
  return PresetSchema.parse({ id: r.id, name: r.name, template: r.template, spec: JSON.parse(r.spec), common: JSON.parse(r.common), builtin: r.builtin === 1, createdAt: r.created_at });
}

export const listPresets = (ctx: FeatureContext): Preset[] => all<PresetRow>(ctx.db, 'SELECT * FROM quick_presets ORDER BY builtin DESC, position, id').map(toPreset);

export function getPreset(ctx: FeatureContext, id: number): Preset {
  const r = one<PresetRow>(ctx.db, 'SELECT * FROM quick_presets WHERE id = ?', id);
  if (!r) throw notFound('No such preset.');
  return toPreset(r);
}

export function addPreset(ctx: FeatureContext, name: string, spec: QuickSpec, common: Common, builtin = false, position = 0): Preset {
  const r = run(
    ctx.db,
    'INSERT INTO quick_presets (name, template, spec, common, builtin, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    name,
    spec.template,
    JSON.stringify(spec),
    JSON.stringify(common),
    builtin ? 1 : 0,
    position,
    ctx.now(),
  );
  return getPreset(ctx, r.lastId);
}

export function deletePreset(ctx: FeatureContext, id: number): void {
  const p = getPreset(ctx, id);
  if (p.builtin) throw conflict('The starter presets stay. Save a copy under your own name instead.');
  run(ctx.db, 'DELETE FROM quick_presets WHERE id = ?', id);
}

/** A starter preset is sized to whoever is signed in when it fires; a saved one is exactly what was saved. */
export function sizedPreset(ctx: FeatureContext, p: Preset): QuickSpec {
  if (!p.builtin) return p.spec;
  const sizing = roomSizing(presentCount(ctx));
  if (p.spec.template === 'code') return { ...p.spec, winners: sizing.codeWinners };
  if (p.spec.template === 'room') return { ...p.spec, goal: Math.max(10, Math.round((sizing.roomGoal * p.spec.windowSec) / 60)) };
  return p.spec;
}

// ---- watching ----------------------------------------------------------------------------------

const pct = (n: number, total: number): string => (total > 0 ? `${Math.round((100 * n) / total)}%` : '0%');

function baseView(ctx: FeatureContext, s: Session, over: Partial<LiveView>): LiveView {
  return {
    session: s,
    phase: s.status,
    headline: s.title,
    detail: '',
    stats: [],
    bars: [],
    words: [],
    code: null,
    endsAt: null,
    controls: [],
    trailId: s.refs.trailId ?? null,
    serverNow: ctx.now(),
    ...over,
  };
}

async function pollView(ctx: FeatureContext, io: Io, s: Session): Promise<LiveView> {
  const ids = s.refs.pollIds ?? [];
  const idx = s.refs.cursor ?? 0;
  const id = ids[idx];
  if (id === undefined) return baseView(ctx, s, { phase: 'done' });
  const r = await io.call<AdminResults>('GET', `/api/polls/admin/${id}/results`);
  const p = r.poll;
  const quiz = s.template === 'quiz';
  const label = (i: number): string => (p.kind === 'single' || p.kind === 'multi' || p.kind === 'this_or_that' || p.kind === 'quiz' ? (p.options[i]?.label ?? `#${i + 1}`) : String(i + 1));
  const bars: LiveView['bars'] = [];
  const stats: LiveView['stats'] = [{ label: 'voted', value: r.voters }];
  let words: LiveView['words'] = [];
  if (r.counts) r.counts.forEach((c, i) => bars.push({ label: label(i), value: c, mark: quiz && p.kind === 'quiz' && p.correct === i }));
  const rr = r.results;
  if (rr.kind === 'rating') {
    rr.histogram.forEach((c, i) => bars.push({ label: String(rr.min + i), value: c }));
    stats.push({ label: 'average', value: rr.average === null ? '-' : rr.average.toFixed(1) });
  }
  if (r.words) words = r.words.filter((w) => !w.hidden).slice(0, 24).map((w) => ({ word: w.word, count: w.count }));
  const last = idx >= ids.length - 1;
  const controls: Control[] = [];
  let phase: string = p.status;
  if (p.status === 'live') controls.push('close', 'end');
  else if (p.status === 'closed') controls.push('reveal');
  else if (p.status === 'revealed') {
    if (quiz && !last) controls.push('next');
    else phase = 'done';
  }
  if (quiz) {
    stats.push({ label: 'question', value: `${idx + 1} of ${ids.length}` });
    const top = r.board?.[0];
    if (top) stats.push({ label: 'leading', value: `${top.nickname} (${top.points})` });
  }
  if (s.status === 'live' && s.refs.activityId) controls.push('extend');
  return baseView(ctx, s, {
    phase,
    headline: quiz ? `Q${idx + 1}. ${p.question}` : p.question,
    detail: p.status === 'live' ? (quiz ? 'answers are open, the clock is running' : 'votes are coming in') : p.status === 'closed' ? 'closed: reveal when you are ready' : 'revealed on the projector and every phone',
    stats,
    bars,
    words,
    endsAt: p.status === 'live' ? (p.deadlineAt ?? null) : null,
    controls,
  });
}

async function dropView(ctx: FeatureContext, io: Io, s: Session): Promise<LiveView> {
  const st = await io.call<DropsAdminState>('GET', '/api/drops/admin');
  const d = st.drops.find((x) => x.id === s.refs.dropId);
  if (!d) return baseView(ctx, s, { phase: 'done', detail: 'it is gone from the drops list' });
  const live = d.status === 'live';
  const stats: LiveView['stats'] = [];
  const tally = live && st.tally?.dropId === d.id ? st.tally : null;
  if (d.kind === 'room') stats.push({ label: 'reactions', value: `${tally?.count ?? d.count} of ${d.goal ?? '?'}` });
  else stats.push({ label: 'got it', value: `${tally?.claimed ?? d.claimed}${d.slots ? ` of ${d.slots} top spots` : ''}` });
  stats.push({ label: 'players', value: tally?.players ?? d.players });
  let detail = live ? 'on every phone and the projector right now' : d.status === 'cancelled' ? 'cancelled' : 'finished';
  if (!live && d.kind === 'room') detail = d.achieved ? 'the room did it. everyone got points' : 'the room fell short';
  const code = d.config.kind === 'code' ? d.config.code : null;
  return baseView(ctx, s, {
    phase: live ? 'live' : 'done',
    headline: d.title,
    detail,
    stats,
    bars: (tally?.winners ?? []).slice(0, 5).map((w) => ({ label: `#${w.rank} ${w.nickname}`, value: w.points })),
    code: live ? code : null,
    endsAt: live ? d.closesAt : null,
    controls: live ? [...(s.refs.activityId ? (['extend'] as Control[]) : []), 'end'] : [],
  });
}

async function morseView(ctx: FeatureContext, io: Io, s: Session): Promise<LiveView> {
  const ov = await io.call<MorseOverview>('GET', '/api/morse/admin');
  const running = ov.sprint && ov.sprint.sprint.id === s.refs.sprintId ? ov.sprint : null;
  const last = ov.lastSprint && ov.lastSprint.sprint.id === s.refs.sprintId ? ov.lastSprint : null;
  const sp = running ?? last;
  const top = running ? running.top : (last?.top ?? []);
  return baseView(ctx, s, {
    phase: running ? 'live' : 'done',
    headline: sp ? `morse ${sp.sprint.mode} speed round, level ${sp.sprint.level}` : s.title,
    detail: running ? 'phones are racing; the podium pays out when it ends' : 'finished: the podium was paid',
    stats: [{ label: 'players', value: running?.players ?? ov.players }],
    bars: top.slice(0, 5).map((r) => ({ label: `#${r.rank} ${r.nickname}`, value: r.score })),
    endsAt: running ? running.sprint.endsAt : null,
    controls: running ? [...(s.refs.activityId ? (['extend'] as Control[]) : []), 'end'] : [],
  });
}

async function checkinView(ctx: FeatureContext, io: Io, s: Session): Promise<LiveView> {
  const ov = await io.call<AdminOverview>('GET', '/api/attendance/admin/overview');
  const w = ov.windows.find((x) => x.activityId === s.refs.checkinActivityId);
  let code: string | null = null;
  if (w?.open) {
    const scr = await io.call<{ open: { activityId: string; code: string }[] }>('GET', '/api/attendance/screen');
    code = scr.open.find((o) => o.activityId === w.activityId)?.code ?? null;
  }
  return baseView(ctx, s, {
    phase: w?.open ? 'live' : 'done',
    headline: w?.title ?? s.title,
    detail: w?.open ? 'the projector shows the code; people type it in the app' : 'check-in is closed',
    stats: [
      { label: 'checked in', value: `${w?.count ?? 0} of ${ov.eventCount}` },
      { label: 'of the room', value: pct(w?.count ?? 0, ov.eventCount) },
    ],
    code,
    endsAt: w?.open ? (w.closesAt ?? null) : null,
    controls: w?.open ? ['extend', 'end'] : [],
  });
}

async function huntView(ctx: FeatureContext, io: Io, s: Session): Promise<LiveView> {
  const h = await io.call<HuntAdmin>('GET', `/api/hunt/admin?trail=${s.refs.trailId}`);
  return baseView(ctx, s, {
    phase: h.status === 'open' ? 'live' : 'done',
    headline: h.title,
    detail: h.status === 'open' ? 'open on every phone. print the stickers for the QR stops' : 'closed',
    stats: [
      { label: 'hunting', value: h.players - h.finished },
      { label: 'finished', value: h.finished },
      { label: 'stops', value: h.stops.length },
    ],
    bars: h.stops.map((st) => ({ label: `${st.position}. ${st.challenge === 'scan' ? 'sticker' : 'riddle'}`, value: st.solvedBy })),
    controls: h.status === 'open' ? ['end'] : [],
  });
}

/** What the live card shows. Also notices a session that finished by itself and files it as ended. */
export async function viewOf(ctx: FeatureContext, io: Io, s: Session): Promise<LiveView> {
  if (s.status === 'queued') return baseView(ctx, s, { phase: 'queued', detail: 'saved for later. launch it when the speaker asks', controls: [] });
  if (s.status === 'undone') return baseView(ctx, s, { phase: 'undone', detail: 'taken back', controls: [] });
  let v: LiveView;
  if (s.template === 'announce') v = baseView(ctx, s, { phase: 'done', headline: s.spec.template === 'announce' ? s.spec.title : s.title, detail: s.spec.template === 'announce' ? s.spec.body : '' });
  else if (slotOf(s.template) === 'poll') v = await pollView(ctx, io, s);
  else if (slotOf(s.template) === 'drop') v = await dropView(ctx, io, s);
  else if (s.template === 'morse') v = await morseView(ctx, io, s);
  else if (s.template === 'checkin') v = await checkinView(ctx, io, s);
  else v = await huntView(ctx, io, s);
  if (s.status === 'live' && v.phase === 'done') {
    setStatus(ctx, s.id, 'ended');
    v = { ...v, session: getSession(ctx, s.id), controls: [] };
  } else if (s.status === 'live') {
    v.controls = [...v.controls, 'undo'];
  }
  if (s.status === 'ended') v.controls = [];
  v.session = getSession(ctx, s.id);
  return v;
}

// ---- acting ---------------------------------------------------------------------------------------

async function endActivity(io: Io, s: Session): Promise<void> {
  if (!s.refs.activityId) return;
  await io.call('POST', `/api/schedule/${s.refs.activityId}/end`).catch(() => undefined);
}

async function finishPolls(io: Io, s: Session): Promise<void> {
  const ids = s.refs.pollIds ?? [];
  const idx = s.refs.cursor ?? 0;
  const cur = ids[idx];
  if (cur !== undefined) {
    const r = await io.call<AdminResults>('GET', `/api/polls/admin/${cur}/results`);
    if (r.poll.status === 'live') await io.call('POST', `/api/polls/admin/${cur}/close`);
    if (r.poll.status === 'live' || r.poll.status === 'closed') await io.call('POST', `/api/polls/admin/${cur}/reveal`);
  }
  // questions never asked would clutter the polls panel
  for (const id of ids.slice(idx + 1)) await io.call('DELETE', `/api/polls/admin/${id}`).catch(() => undefined);
}

async function takeBack(ctx: FeatureContext, io: Io, s: Session): Promise<void> {
  const r = s.refs;
  const tolerate = (p: Promise<unknown>): Promise<unknown> => p.catch(() => undefined);
  for (const id of r.pollIds ?? []) {
    await tolerate(io.call('POST', `/api/polls/admin/${id}/close`));
    await tolerate(io.call('DELETE', `/api/polls/admin/${id}`));
  }
  if (r.dropId !== undefined) {
    await tolerate(io.call('POST', `/api/drops/admin/${r.dropId}/cancel`));
    await tolerate(io.call('DELETE', `/api/drops/admin/${r.dropId}`));
  }
  if (r.sprintId !== undefined) await tolerate(io.call('POST', '/api/morse/admin/sprint/end'));
  if (r.checkinActivityId !== undefined) await tolerate(io.call('POST', '/api/attendance/admin/close', { activityId: r.checkinActivityId }));
  if (r.trailId !== undefined) await tolerate(io.call('PUT', `/api/hunt/admin/state?trail=${r.trailId}`, { status: 'closed' }));
  if (r.activityId !== undefined && r.activityMade) await tolerate(io.call('DELETE', `/api/schedule/${r.activityId}`));
  setStatus(ctx, s.id, 'undone');
}

/** One button on the live card. Serialised with launches. */
export function act(ctx: FeatureContext, io: Io, id: number, action: SessionAction): Promise<LiveView> {
  return serial(ctx, async () => {
    const s = getSession(ctx, id);
    if (s.status === 'queued') {
      if (action !== 'undo') throw conflict('Launch it first.');
      setStatus(ctx, id, 'undone');
      ctx.live.publish('quick.changed', { at: ctx.now() }, 'admins');
      return viewOf(ctx, io, getSession(ctx, id));
    }
    if (s.status !== 'live') throw conflict(`That session is already ${s.status}.`);
    const view = await viewOf(ctx, io, s);
    if (view.session.status !== 'live') throw conflict('That session just finished by itself.');
    if (!view.controls.includes(action)) throw conflict(`Not now: "${action}" does not apply while it is ${view.phase}.`);
    const ids = s.refs.pollIds ?? [];
    const idx = s.refs.cursor ?? 0;
    switch (action) {
      case 'close':
        await io.call('POST', `/api/polls/admin/${ids[idx]}/close`);
        break;
      case 'reveal':
        await io.call('POST', `/api/polls/admin/${ids[idx]}/reveal`);
        if (s.template !== 'quiz' || idx >= ids.length - 1) {
          setStatus(ctx, id, 'ended');
          await endActivity(io, s);
        }
        break;
      case 'next': {
        const next = idx + 1;
        saveRefs(ctx, id, { ...s.refs, cursor: next });
        await io.call('POST', `/api/polls/admin/${ids[next]}/launch`, { closeCurrent: false }).catch((e: unknown) => {
          saveRefs(ctx, id, s.refs);
          throw e;
        });
        break;
      }
      case 'end':
        if (slotOf(s.template) === 'poll') await finishPolls(io, s);
        else if (s.template === 'room' || s.template === 'code' || s.template === 'speed') await io.call('POST', `/api/drops/admin/${s.refs.dropId}/cancel`);
        else if (s.template === 'morse') await io.call('POST', '/api/morse/admin/sprint/end');
        else if (s.template === 'checkin') await io.call('POST', '/api/attendance/admin/close', { activityId: s.refs.checkinActivityId });
        else if (s.template === 'hunt') await io.call('PUT', `/api/hunt/admin/state?trail=${s.refs.trailId}`, { status: 'closed' });
        await endActivity(io, s);
        setStatus(ctx, id, 'ended');
        break;
      case 'extend': {
        if (s.template === 'checkin' && s.refs.checkinActivityId) {
          const ov = await io.call<AdminOverview>('GET', '/api/attendance/admin/overview');
          const w = ov.windows.find((x) => x.activityId === s.refs.checkinActivityId);
          if (w?.closesAt) await io.call('POST', '/api/attendance/admin/open', { activityId: w.activityId, title: w.title, closesAt: w.closesAt + MIN });
        }
        if (s.refs.activityId) {
          const act2 = (await readSchedule(io)).activities.find((a) => a.id === s.refs.activityId);
          if (act2) await io.call('PATCH', `/api/schedule/${act2.id}`, { endAt: act2.endAt + MIN });
        }
        break;
      }
      case 'undo':
        await takeBack(ctx, io, s);
        break;
    }
    ctx.live.publish('quick.changed', { at: ctx.now() }, 'admins');
    return viewOf(ctx, io, getSession(ctx, id));
  });
}

// ---- overview -----------------------------------------------------------------------------------------

export async function overview(ctx: FeatureContext, io: Io): Promise<Overview> {
  const live = all<SessionRow>(ctx.db, "SELECT * FROM quick_sessions WHERE status IN ('live', 'queued') ORDER BY id DESC").map(toSession);
  // settle sessions that ended by themselves (a drop's window ran out) before listing
  for (const s of live) if (s.status === 'live') await viewOf(ctx, io, s).catch(() => undefined);
  const settled = all<SessionRow>(ctx.db, "SELECT * FROM quick_sessions WHERE status IN ('live', 'queued') ORDER BY id DESC").map(toSession);
  const history = all<SessionRow>(ctx.db, "SELECT * FROM quick_sessions WHERE status IN ('ended', 'undone') ORDER BY id DESC LIMIT 30").map(toSession);
  const [busy, sched, pin] = await Promise.all([readBusy(io), readSchedule(io), io.call<ScreenState>('GET', '/api/screen/state')]);
  const present = presentCount(ctx);
  const sizing = roomSizing(present);
  const nowAct = sched.activities.find((a) => a.id === sched.nowId);
  return {
    serverNow: ctx.now(),
    present,
    sizing: { codeWinners: sizing.codeWinners, roomGoal: sizing.roomGoal },
    busy: { poll: busy.poll, drop: busy.drop, morse: busy.morse, activity: nowAct?.title ?? null, pinned: pin.pinned },
    activities: sched.activities.filter((a) => a.status !== 'ended').slice(0, 30).map((a) => ({ id: a.id, title: a.title, status: a.status })),
    live: settled,
    history,
    presets: listPresets(ctx),
  };
}
