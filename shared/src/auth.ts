import { z } from 'zod';
import { AvatarConfigSchema } from './avatar';

/* ------------------------------------------------------------------ kits */

export const KIT_PREFIX = 'AH';
/** Password alphabet: no 0/O, 1/l/I. Passwords are case-insensitive. */
export const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PASSWORD_LENGTH = 6;

/** "ah 42", "AH-042", "ah042" -> "AH-042". Returns null if it cannot be a kit id. */
export function normaliseKitId(input: string): string | null {
  const m = /^\s*a\s*h\s*[-_ ]?\s*(\d{1,4})\s*$/i.exec(input);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1) return null;
  return `${KIT_PREFIX}-${String(n).padStart(3, '0')}`;
}

/** Strip spaces/dashes, uppercase. "k7m 4qp" -> "K7M4QP". */
export function normalisePassword(input: string): string {
  return input.replace(/[\s-]+/g, '').toUpperCase();
}

/** "K7M4QP" -> "K7M 4QP", easier to read off a card. */
export function formatPassword(pw: string): string {
  return pw.length === 6 ? `${pw.slice(0, 3)} ${pw.slice(3)}` : pw;
}

export const KitIdSchema = z
  .string()
  .max(16)
  .transform((v, ctx) => {
    const id = normaliseKitId(v);
    if (!id) {
      ctx.addIssue({ code: 'custom', message: 'That kit ID looks off. It is on your card, like AH-042.' });
      return z.NEVER;
    }
    return id;
  });

/* --------------------------------------------------------------- profile */

export const NICKNAME_RE = /^[\p{L}\p{N} _.'-]{2,16}$/u;

export const ProfileInputSchema = z.object({
  name: z.string().trim().min(1, 'we need a name').max(60),
  roll: z
    .string()
    .trim()
    .min(1, 'roll number please')
    .max(20)
    .regex(/^[A-Za-z0-9-]+$/, 'letters and numbers only')
    .transform((v) => v.toUpperCase()),
  nickname: z
    .string()
    .trim()
    .regex(NICKNAME_RE, '2 to 16 letters, numbers, spaces or _ . - \''),
  avatar: AvatarConfigSchema,
});
export type ProfileInput = z.infer<typeof ProfileInputSchema>;

export const AttendeeSchema = z.object({
  id: z.number().int(),
  kitId: z.string(),
  name: z.string().nullable(),
  roll: z.string().nullable(),
  nickname: z.string().nullable(),
  avatar: AvatarConfigSchema.nullable(),
  profileComplete: z.boolean(),
  /** First sign-in time = event attendance record (epoch ms). */
  firstSignInAt: z.number(),
});
export type Attendee = z.infer<typeof AttendeeSchema>;

/** What other people may see about an attendee (leaderboard, projector). */
export const PublicAttendeeSchema = z.object({
  id: z.number().int(),
  nickname: z.string(),
  avatar: AvatarConfigSchema,
});
export type PublicAttendee = z.infer<typeof PublicAttendeeSchema>;

/* -------------------------------------------------------------- sign-in */

export const SignInRequestSchema = z.object({
  kitId: KitIdSchema,
  password: z.string().min(1).max(40).transform(normalisePassword),
});
export type SignInRequest = z.input<typeof SignInRequestSchema>;

export const MeResponseSchema = z.object({
  attendee: AttendeeSchema,
  /** Name/roll an organiser pre-filled from the CSV, used to prefill the profile step. */
  preset: z.object({ name: z.string().nullable(), roll: z.string().nullable() }),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

/* ---------------------------------------------------------- staff (PIN) */

export const PinRequestSchema = z.object({ pin: z.string().min(1).max(64) });
export type PinRequest = z.infer<typeof PinRequestSchema>;

export const StaffRoleSchema = z.enum(['admin', 'screen', 'gate']);
export type StaffRole = z.infer<typeof StaffRoleSchema>;

export const StaffMeSchema = z.object({ role: StaffRoleSchema });
export type StaffMe = z.infer<typeof StaffMeSchema>;

/* ------------------------------------------------------- admin: kits */

export const GenerateKitsRequestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('blank'), count: z.number().int().min(1).max(500) }),
  z.object({ mode: z.literal('csv'), csv: z.string().min(1).max(200_000) }),
]);
export type GenerateKitsRequest = z.infer<typeof GenerateKitsRequestSchema>;

export const GeneratedKitSchema = z.object({
  kitId: z.string(),
  password: z.string(),
  name: z.string().nullable(),
  roll: z.string().nullable(),
});
export type GeneratedKit = z.infer<typeof GeneratedKitSchema>;

export const GenerateKitsResponseSchema = z.object({
  kits: z.array(GeneratedKitSchema),
  /** Rows of a CSV paste that were skipped, with why. */
  skipped: z.array(z.object({ line: z.number(), reason: z.string() })),
});
export type GenerateKitsResponse = z.infer<typeof GenerateKitsResponseSchema>;

export const KitRowSchema = z.object({
  kitId: z.string(),
  presetName: z.string().nullable(),
  presetRoll: z.string().nullable(),
  createdAt: z.number(),
  bound: z.boolean(),
  boundAt: z.number().nullable(),
  resets: z.number().int(),
  attendee: z
    .object({
      id: z.number().int(),
      name: z.string().nullable(),
      roll: z.string().nullable(),
      nickname: z.string().nullable(),
      firstSignInAt: z.number(),
      profileComplete: z.boolean(),
    })
    .nullable(),
});
export type KitRow = z.infer<typeof KitRowSchema>;

export const KitListResponseSchema = z.object({
  kits: z.array(KitRowSchema),
  stats: z.object({ total: z.number(), signedIn: z.number(), profiles: z.number() }),
});
export type KitListResponse = z.infer<typeof KitListResponseSchema>;

export const ResetKitRequestSchema = z.object({ newPassword: z.boolean().default(false) });
export type ResetKitRequest = z.input<typeof ResetKitRequestSchema>;

export const ResetKitResponseSchema = z.object({
  kitId: z.string(),
  /** Present only when a new password was requested. Shown once. */
  password: z.string().nullable(),
});
export type ResetKitResponse = z.infer<typeof ResetKitResponseSchema>;
