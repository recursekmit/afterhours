// Quick session (console): launch a poll, quiz, drop, speed round, check-in, mini hunt or announcement
// in two minutes, with phones and the projector taking over by themselves.
//
// Routes (all console only, under /api/quick):
//   GET  /overview                    room size, what is on the air, live + queued + history, presets
//   POST /go                          { key, spec, common, closeLive } launch now (idempotent on key)
//   POST /queue                       same body, saved for later
//   GET  /sessions/:id                the live card: phase, results, controls
//   POST /sessions/:id/go             launch a queued session
//   POST /sessions/:id/rerun          { key } the same spec again, now
//   POST /sessions/:id/action         { action: close | reveal | next | end | extend | undo }
//   POST /presets                     save a filled form; DELETE /presets/:id; POST /presets/:id/go { key, label? }
import { OkSchema } from '@afterhours/shared';
import {
  GoRequestSchema,
  type LiveView,
  type Overview,
  type Preset,
  PresetInputSchema,
  type Session,
  SessionActionRequestSchema,
  ShortcutGoRequestSchema,
} from '@afterhours/shared/features/quick';
import { z } from 'zod';
import { defineFeature, parse, requireAdmin } from '../../core';
import { makeIo } from './internal';
import { seedPresets } from './presets';
import { act, addPreset, deletePreset, getPreset, getSession, goLive, launchQueued, listPresets, overview, rerun, sizedPreset, viewOf } from './service';

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const LaunchQueuedBody = z.object({ closeLive: z.boolean().default(false) });

export const quick = defineFeature({
  name: 'quick',

  routes(app, ctx) {
    const io = makeIo(app, ctx);

    app.get('/overview', async (req): Promise<Overview> => {
      requireAdmin(req);
      return overview(ctx, io);
    });

    app.post('/go', async (req): Promise<LiveView> => {
      requireAdmin(req);
      const body = parse(GoRequestSchema, req.body);
      const s = await goLive(ctx, io, body, false);
      return viewOf(ctx, io, s);
    });

    app.post('/queue', async (req): Promise<Session> => {
      requireAdmin(req);
      return goLive(ctx, io, parse(GoRequestSchema, req.body), true);
    });

    app.get('/sessions/:id', async (req): Promise<LiveView> => {
      requireAdmin(req);
      return viewOf(ctx, io, getSession(ctx, parse(IdParams, req.params).id));
    });

    app.post('/sessions/:id/go', async (req): Promise<LiveView> => {
      requireAdmin(req);
      const { id } = parse(IdParams, req.params);
      const { closeLive } = parse(LaunchQueuedBody, req.body ?? {});
      return viewOf(ctx, io, await launchQueued(ctx, io, id, closeLive));
    });

    app.post('/sessions/:id/rerun', async (req): Promise<LiveView> => {
      requireAdmin(req);
      const { id } = parse(IdParams, req.params);
      const b = parse(ShortcutGoRequestSchema, req.body);
      const src = getSession(ctx, id);
      return viewOf(ctx, io, await rerun(ctx, io, src, b.key, b.closeLive, b.label));
    });

    app.post('/sessions/:id/action', async (req): Promise<LiveView> => {
      requireAdmin(req);
      const { id } = parse(IdParams, req.params);
      return act(ctx, io, id, parse(SessionActionRequestSchema, req.body).action);
    });

    app.post('/presets', async (req): Promise<Preset> => {
      requireAdmin(req);
      const b = parse(PresetInputSchema, req.body);
      return addPreset(ctx, b.name, b.spec, b.common);
    });

    app.delete('/presets/:id', async (req) => {
      requireAdmin(req);
      deletePreset(ctx, parse(IdParams, req.params).id);
      return OkSchema.parse({ ok: true });
    });

    // One tap from the speaker view (or a preset card): the preset, sized to the room, live now.
    app.post('/presets/:id/go', async (req): Promise<LiveView> => {
      requireAdmin(req);
      const { id } = parse(IdParams, req.params);
      const b = parse(ShortcutGoRequestSchema, req.body);
      const p = getPreset(ctx, id);
      const s = await rerun(ctx, io, { spec: sizedPreset(ctx, p), common: p.common, presetId: p.id }, b.key, b.closeLive, b.label);
      return viewOf(ctx, io, s);
    });

    app.get('/presets', async (req): Promise<{ presets: Preset[] }> => {
      requireAdmin(req);
      return { presets: listPresets(ctx) };
    });
  },

  boot: seedPresets,
  seed: seedPresets,
});
