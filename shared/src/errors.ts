import { z } from 'zod';

/**
 * Every non-2xx JSON response from /api has this shape.
 * `code` is machine-readable (switch on it), `message` is human copy that is
 * safe to show in a toast.
 */
export const ErrorCodeSchema = z.enum([
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'internal',
  // auth specific
  'bad_credentials',
  'kit_bound',
  'profile_required',
  // student-ID login
  'bad_qr',
  'not_registered',
  'need_roll',
  'id_bound',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Seconds until a rate-limited action may be retried. */
    retryAfter: z.number().optional(),
    /** Validation issues, for bad_request. */
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

export const OkSchema = z.object({ ok: z.literal(true) });
export type Ok = z.infer<typeof OkSchema>;
