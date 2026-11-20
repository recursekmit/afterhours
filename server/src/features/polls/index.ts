// Polls and quiz (spec 5.4).
//
// Routes (all under /api/polls):
//   attendee   GET  /current            the live poll, else the latest finished one
//              GET  /history            finished polls with my vote
//              GET  /:id                one poll (never a draft)
//              POST /:id/vote           one vote per attendee per poll
//   projector  GET  /screen             live poll + results for the big screen
//   console    GET/POST /admin, PUT/DELETE /admin/:id, POST /admin/reorder,
//              POST /admin/:id/{launch,close,reveal,reset},
//              GET /admin/:id/results, POST /admin/:id/words/{hide,unhide}
import {
  type AdminPoll,
  type AdminPollList,
  type AdminResults,
  HideWordRequestSchema,
  LaunchPollRequestSchema,
  type CurrentPollResponse,
  PollDefinitionSchema,
  type PollHistoryResponse,
  type PollView,
  ReorderPollsRequestSchema,
  type ScreenPollState,
  VoteRequestSchema,
  type VoteResponse,
} from '@afterhours/shared/features/polls';
import type { Ok } from '@afterhours/shared';
import { z } from 'zod';
import {
  all,
  defineFeature,
  getAttendee,
  notFound,
  parse,
  requireAdmin,
  requireAttendee,
  requireScreen,
} from '../../core';
import {
  PARTICIPATION_POINTS,
  REGULAR_VOTES,
  adminWords,
  castVote,
  closePoll,
  createPoll,
  deletePoll,
  expire,
  flush,
  launchPoll,
  publicOf,
  reconcileQuizPayouts,
  reorderPolls,
  resetPoll,
  revealPoll,
  setWordHidden,
  state as pollState,
  tallyFor,
  updatePoll,
  viewOf,
} from './service';
import { seedPolls } from './seed';
import { POLL_COLUMNS, type PollRow, boardOf, currentRow, getRow, resultsOf, voterCount } from './store';

export { PARTICIPATION_POINTS, REGULAR_VOTES, flush, expire };

const IdParams = z.object({ id: z.coerce.number().int().positive() });

export const polls = defineFeature({
  name: 'polls',
  // purge test player: the live tally is rebuilt from the votes that are left
  onPurge(ctx) {
    const s = pollState(ctx);
    s.tally = null;
    s.dirty = true;
  },

  stickers: [
    { id: 'polls-first-vote', title: 'first vote', hint: 'cast your first vote in any poll', shape: 'ticket', color: 'lime', glyph: 'check', feature: 'polls', order: 20 },
    { id: 'polls-regular', title: 'opinionated', hint: `weigh in on ${REGULAR_VOTES} polls`, shape: 'burst', color: 'pink', glyph: 'spark', feature: 'polls', order: 21 },
    { id: 'polls-wordsmith', title: 'wordsmith', hint: 'drop a word in a word cloud', shape: 'blob', color: 'sky', glyph: 'note', feature: 'polls', order: 22 },
    { id: 'polls-quiz-whiz', title: 'quiz whiz', hint: 'get a quiz question right', shape: 'star', color: 'sun', glyph: 'star', feature: 'polls', order: 23 },
    { id: 'polls-lightning', title: 'lightning', hint: 'nail a quiz answer in the first quarter of the clock', shape: 'shield', color: 'tangerine', glyph: 'bolt', feature: 'polls', order: 24 },
  ],

  boot(ctx) {
    reconcileQuizPayouts(ctx);
  },

  routes(app, ctx) {
    const meId = (req: Parameters<typeof getAttendee>[0]) => getAttendee(req)?.attendeeId ?? null;
    const pollOr404 = (id: number): PollRow => {
      const row = getRow(ctx.db, id);
      if (!row) throw notFound('No such poll.');
      return row;
    };

    // ---- attendee ------------------------------------------------------------------

    app.get('/current', async (req): Promise<CurrentPollResponse> => {
      requireAttendee(req);
      const row = currentRow(ctx.db);
      return { serverNow: ctx.now(), view: row ? viewOf(ctx, row, meId(req)) : null };
    });

    app.get('/history', async (req): Promise<PollHistoryResponse> => {
      requireAttendee(req);
      const rows = all<PollRow>(
        ctx.db,
        `SELECT ${POLL_COLUMNS} FROM polls WHERE status IN ('closed', 'revealed')
         ORDER BY COALESCE(revealed_at, closed_at) DESC, id DESC LIMIT 50`,
      );
      return { serverNow: ctx.now(), items: rows.map((r) => viewOf(ctx, r, meId(req))) };
    });

    app.get('/screen', async (req): Promise<ScreenPollState> => {
      requireScreen(req);
      const row = currentRow(ctx.db);
      if (!row) return { serverNow: ctx.now(), poll: null, results: null, board: null };
      const t = tallyFor(ctx, row);
      return {
        serverNow: ctx.now(),
        poll: publicOf(row, false),
        results: resultsOf(ctx.db, row, t, ctx.now()),
        board: row.kind === 'quiz' && row.status === 'revealed' ? boardOf(ctx.db, row.series ?? 'quiz') : null,
      };
    });

    app.get('/:id', async (req): Promise<PollView> => {
      requireAttendee(req);
      const row = pollOr404(parse(IdParams, req.params).id);
      if (row.status === 'draft') throw notFound('No such poll.');
      return viewOf(ctx, row, meId(req));
    });

    app.post('/:id/vote', async (req): Promise<VoteResponse> => {
      const me = requireAttendee(req);
      const { id } = parse(IdParams, req.params);
      const body = parse(VoteRequestSchema, req.body);
      return castVote(ctx, me.attendeeId, id, body);
    });

    // ---- console -------------------------------------------------------------------

    const adminPoll = (row: PollRow): AdminPoll => ({ poll: publicOf(row, true), voters: voterCount(ctx.db, row.id) });

    app.get('/admin', async (req): Promise<AdminPollList> => {
      requireAdmin(req);
      const rows = all<PollRow>(ctx.db, `SELECT ${POLL_COLUMNS} FROM polls ORDER BY position, id`);
      return { serverNow: ctx.now(), polls: rows.map(adminPoll) };
    });

    app.post('/admin', async (req): Promise<AdminPoll> => {
      requireAdmin(req);
      return adminPoll(createPoll(ctx, parse(PollDefinitionSchema, req.body)));
    });

    app.post('/admin/reorder', async (req): Promise<Ok> => {
      requireAdmin(req);
      reorderPolls(ctx, parse(ReorderPollsRequestSchema, req.body).ids);
      return { ok: true };
    });

    app.put('/admin/:id', async (req): Promise<AdminPoll> => {
      requireAdmin(req);
      const { id } = parse(IdParams, req.params);
      return adminPoll(updatePoll(ctx, id, parse(PollDefinitionSchema, req.body)));
    });

    app.delete('/admin/:id', async (req): Promise<Ok> => {
      requireAdmin(req);
      deletePoll(ctx, parse(IdParams, req.params).id);
      return { ok: true };
    });

    app.post('/admin/:id/launch', async (req): Promise<AdminPoll> => {
      requireAdmin(req);
      const { id } = parse(IdParams, req.params);
      const { closeCurrent } = parse(LaunchPollRequestSchema, req.body ?? {});
      return adminPoll(launchPoll(ctx, id, closeCurrent));
    });

    app.post('/admin/:id/close', async (req): Promise<AdminPoll> => {
      requireAdmin(req);
      return adminPoll(closePoll(ctx, parse(IdParams, req.params).id, false));
    });

    app.post('/admin/:id/reveal', async (req): Promise<AdminPoll> => {
      requireAdmin(req);
      return adminPoll(revealPoll(ctx, parse(IdParams, req.params).id));
    });

    app.post('/admin/:id/reset', async (req): Promise<AdminPoll> => {
      requireAdmin(req);
      return adminPoll(resetPoll(ctx, parse(IdParams, req.params).id));
    });

    app.get('/admin/:id/results', async (req): Promise<AdminResults> => {
      requireAdmin(req);
      const row = pollOr404(parse(IdParams, req.params).id);
      const t = tallyFor(ctx, row);
      const choiceLike = row.kind === 'single' || row.kind === 'multi' || row.kind === 'this_or_that' || row.kind === 'quiz';
      return {
        poll: publicOf(row, true),
        voters: t.voters,
        counts: choiceLike ? [...t.counts] : null,
        words: row.kind === 'wordcloud' ? adminWords(t) : null,
        results: resultsOf(ctx.db, row, t, ctx.now()),
        board: row.kind === 'quiz' ? boardOf(ctx.db, row.series ?? 'quiz') : null,
      };
    });

    app.post('/admin/:id/words/hide', async (req): Promise<Ok> => {
      requireAdmin(req);
      setWordHidden(ctx, parse(IdParams, req.params).id, parse(HideWordRequestSchema, req.body).word, true);
      return { ok: true };
    });

    app.post('/admin/:id/words/unhide', async (req): Promise<Ok> => {
      requireAdmin(req);
      setWordHidden(ctx, parse(IdParams, req.params).id, parse(HideWordRequestSchema, req.body).word, false);
      return { ok: true };
    });

  },

  // Results go out at most twice a second however many votes land; a quiz whose
  // clock ran out is closed here (and also lazily on the next late answer).
  tick: {
    everyMs: 500,
    run(ctx) {
      flush(ctx);
      expire(ctx);
    },
  },

  seed(ctx) {
    seedPolls(ctx);
  },
});
