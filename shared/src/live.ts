import { z } from 'zod';
import type { Presence, ScreenState } from './misc';
import type { StickerDef } from './stickers';

/**
 * The map of every live event name to its payload type.
 *
 * Features ADD to this interface from their own shared file with module
 * augmentation, so nobody edits this file:
 *
 *   // shared/src/features/polls.ts
 *   declare module '../live' {
 *     interface LiveEvents {
 *       'polls.opened': PollOpened;
 *     }
 *   }
 *
 * Name events "<feature>.<what happened>" in past tense.
 */
export interface LiveEvents {
  /** To one attendee: you just earned points. */
  'points.awarded': { source: string; ref: string; points: number; total: number; label: string | null };
  /** To one attendee: a sticker landed in your book. Drives the celebration overlay. */
  'sticker.unlocked': { sticker: StickerDef; at: number };
  /** To everyone: scores moved; refetch the leaderboard (throttled server side). */
  'leaderboard.changed': { at: number };
  /** To everyone: people here / phones online (throttled server side). */
  'presence.changed': Presence;
  /** To one attendee: an organiser reset your kit, this session is gone. */
  'session.revoked': { reason: 'kit-reset' | 'id-reset' };
  /** To screens: the console pinned (or unpinned) a projector scene. */
  'screen.pinned': ScreenState;
  /** To door coordinators (and console): someone was marked entered or undone at /gate. */
  'gate.changed': { entered: number; total: number; participantId: number; enteredAt: number | null };
}

export type LiveEventType = keyof LiveEvents & string;

/** What travels over SSE `data:` and in poll responses. */
export interface LiveEnvelope<K extends LiveEventType = LiveEventType> {
  /** Monotonic per server process (seeded from boot time, so it keeps rising across restarts). */
  cursor: number;
  type: K;
  /** Server time, epoch ms. */
  at: number;
  data: LiveEvents[K];
}

export const LiveEnvelopeSchema = z.object({
  cursor: z.number(),
  type: z.string(),
  at: z.number(),
  data: z.unknown(),
});

export const LivePollResponseSchema = z.object({
  /** Highest cursor the server has issued; use as the next `since`. */
  cursor: z.number(),
  events: z.array(LiveEnvelopeSchema),
  /**
   * True when `since` is older than the replay buffer (or from before a
   * restart). The client missed events and must refetch its queries.
   */
  reset: z.boolean(),
});
export type LivePollResponse = z.infer<typeof LivePollResponseSchema>;

/**
 * Who receives an event. Server only cares, but shared so tests and features agree.
 * - 'all': every connected client (attendees, screens, console)
 * - 'attendees': every signed-in attendee
 * - 'admins' / 'screens' / 'gates': staff surfaces ('screens' and 'gates' also reach admins)
 * - { attendeeId }: one person, on whichever phone they are signed in on
 */
export type Audience = 'all' | 'attendees' | 'admins' | 'screens' | 'gates' | { attendeeId: number };

/** Transport-level SSE event names (not in LiveEvents): */
export const SSE_HEARTBEAT = 'hb';
export const SSE_HELLO = 'hello';
/** Heartbeat interval; clients treat 5 s of silence as a stall (spec 3). */
export const LIVE_HEARTBEAT_MS = 2000;
export const LIVE_STALL_MS = 5000;
export const LIVE_POLL_MS = 2000;
