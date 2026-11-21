// The Cipher Ticket: the main Morse activity (contract and the seven trials: shared/src/features/cipher.ts).
//
// API (/api/cipher):
//   GET  /me                    attendee: everything the phone shows (CipherMe)
//   POST /scan                  attendee: { text?, morse? } claim, the four winds, the pact's scans
//   POST /oath                  attendee: swear the oath (seals trial 1)
//   POST /echo                  attendee: { presses } the echo (trial 3)
//   POST /whisper/hint          attendee: next whisper hint (first letter, then letter count)
//   POST /whisper               attendee: { guess } the whisper (trial 4)
//   POST /riddle/hint           attendee: which edge of slip III holds the answer (costs a little)
//   POST /riddle                attendee: { guess } the riddle (trial 5)
//   POST /pact/repair           attendee: a new partner after the wait (trial 6)
//   POST /pact/oracle           attendee: go to the Oracle after the wait (trial 6)
//   POST /signal                attendee: { guess } the last signal (trial 7)
//   GET  /screen                projector: guild race, trial heat, pacts, the last signal
//   GET  /admin                 console: progress, counts, pacts, signal, standings, settings
//   PUT  /admin/settings        console: every difficulty value
//   PUT  /admin/visible         console: { enabled } show to players (TODO-swap: hunt's switch)
//   POST /admin/pacts/:id/break console: re-pair both players
//   POST /admin/signal          console: { action: warn|fire|close|reveal|cancel, inSec?, word? }
//   GET  /admin/print           console: the Oracle's words (its printed ticket)
//   GET  /admin/answer-key.csv  console: private answer key
//   POST /admin/reset           console: { confirm: 'RESET CIPHER' }
import type { Ok } from '@afterhours/shared';
import {
  CipherReadSchema,
  CipherResetSchema,
  CipherSettingsSchema,
  EchoRequestSchema,
  GuessSchema,
  SignalFireSchema,
} from '@afterhours/shared/features/cipher';
import { z } from 'zod';
import { defineFeature, isAdmin, parse, requireAdmin, requireAttendee, requireScreen } from '../../core';
import { breakPact, goOracle, repair } from './pact';
import { STICKERS, adminView, answerKeyCsv, buildMe, echo, printSheet, reset, riddleGuess, riddleHint, saveSettings, scan, screenView, setVisible, state, swear, whisperGuess, whisperHint } from './service';
import { answerSignal, signalAction, signalTick } from './signal';

export const cipher = defineFeature({
  name: 'cipher',
  stickers: [
    { id: STICKERS.oath, title: 'sworn in', hint: 'claim your four slips and swear your oath', shape: 'ticket', color: 'tangerine', glyph: 'key', feature: 'cipher', order: 70 },
    { id: STICKERS.winds, title: 'four winds', hint: 'read all four edges of slip I', shape: 'circle', color: 'sky', glyph: 'arrow', feature: 'cipher', order: 71 },
    { id: STICKERS.echo, title: 'the echo', hint: 'decode slip II, then tap it on the key', shape: 'shield', color: 'sun', glyph: 'wave', feature: 'cipher', order: 72 },
    { id: STICKERS.whisper, title: 'the whisper', hint: 'decode the word your phone whispers', shape: 'blob', color: 'grape', glyph: 'eye', feature: 'cipher', order: 73 },
    { id: STICKERS.riddle, title: 'the riddle', hint: 'answer the riddle hidden on slip III', shape: 'square', color: 'paper', glyph: 'note', feature: 'cipher', order: 74 },
    { id: STICKERS.pact, title: 'the pact', hint: 'seal a pact with someone from another guild', shape: 'heart', color: 'pink', glyph: 'heart', feature: 'cipher', order: 75 },
    { id: STICKERS.signal, title: 'last signal', hint: 'catch the last signal from the projector', shape: 'burst', color: 'lime', glyph: 'bolt', feature: 'cipher', order: 76 },
    { id: STICKERS.master, title: 'cipher master', hint: 'seal all seven trials of the cipher', shape: 'star', color: 'sun', glyph: 'crown', feature: 'cipher', order: 77 },
    { id: STICKERS.champion, title: 'guild champion', hint: 'be in the guild that wins the cipher race', shape: 'shield', color: 'tangerine', glyph: 'flag', feature: 'cipher', order: 78 },
  ],

  routes(app, ctx) {
    app.get('/me', async (req) => buildMe(ctx, requireAttendee(req).attendeeId));
    app.post('/scan', async (req) => scan(ctx, requireAttendee(req).attendeeId, parse(CipherReadSchema, req.body)));
    app.post('/oath', async (req) => swear(ctx, requireAttendee(req).attendeeId));
    app.post('/echo', async (req) => echo(ctx, requireAttendee(req).attendeeId, parse(EchoRequestSchema, req.body).presses));
    app.post('/whisper/hint', async (req) => whisperHint(ctx, requireAttendee(req).attendeeId));
    app.post('/whisper', async (req) => whisperGuess(ctx, requireAttendee(req).attendeeId, parse(GuessSchema, req.body).guess));
    app.post('/riddle/hint', async (req) => riddleHint(ctx, requireAttendee(req).attendeeId));
    app.post('/riddle', async (req) => riddleGuess(ctx, requireAttendee(req).attendeeId, parse(GuessSchema, req.body).guess));
    app.post('/pact/repair', async (req) => repair(ctx, requireAttendee(req).attendeeId));
    app.post('/pact/oracle', async (req) => goOracle(ctx, requireAttendee(req).attendeeId));
    app.post('/signal', async (req) => answerSignal(ctx, requireAttendee(req).attendeeId, parse(GuessSchema, req.body).guess));

    app.get('/screen', async (req) => {
      requireScreen(req);
      return screenView(ctx, { admin: isAdmin(req) });
    });

    app.get('/admin', async (req) => {
      requireAdmin(req);
      return adminView(ctx);
    });
    app.put('/admin/settings', async (req) => {
      requireAdmin(req);
      saveSettings(ctx, parse(CipherSettingsSchema, req.body));
      return adminView(ctx);
    });
    app.put('/admin/visible', async (req) => {
      requireAdmin(req);
      setVisible(ctx, parse(z.object({ enabled: z.boolean() }), req.body).enabled);
      ctx.live.publish('cipher.changed', { at: ctx.now() }, 'all');
      return adminView(ctx);
    });
    app.post('/admin/pacts/:id/break', async (req) => {
      requireAdmin(req);
      breakPact(ctx, parse(z.coerce.number().int().positive(), (req.params as { id: string }).id));
      return adminView(ctx);
    });
    app.post('/admin/signal', async (req) => {
      requireAdmin(req);
      signalAction(ctx, parse(SignalFireSchema, req.body));
      return adminView(ctx);
    });
    app.get('/admin/print', async (req) => {
      requireAdmin(req);
      return printSheet(ctx);
    });
    app.get('/admin/answer-key.csv', async (req, reply) => {
      requireAdmin(req);
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="cipher-answer-key.csv"').header('cache-control', 'no-store');
      return answerKeyCsv(ctx);
    });
    app.post('/admin/reset', async (req): Promise<Ok> => {
      requireAdmin(req);
      parse(CipherResetSchema, req.body);
      reset(ctx);
      ctx.live.publish('cipher.changed', { at: ctx.now() }, 'all');
      return { ok: true };
    });
  },

  tick: {
    everyMs: 1000,
    run(ctx) {
      signalTick(ctx);
      const st = state(ctx);
      if (st.dirty) {
        st.dirty = false;
        ctx.live.publish('cipher.changed', { at: ctx.now() }, 'all');
      }
    },
  },
});
