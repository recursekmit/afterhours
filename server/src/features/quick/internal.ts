// How quick sessions drive the other features: through their own admin HTTP routes, in process, with a
// private admin session. Every call therefore goes through the same Zod schemas, guards and service
// functions as the console (nothing here writes another feature's tables), and a rule another feature
// adds later applies to us too.
import type { FastifyInstance } from 'fastify';
import { type AppContext, HttpError } from '../../core';
import { COOKIES, createSession, findSession } from '../../core/auth/sessions';

export interface Io {
  call<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T>;
}

export function makeIo(app: FastifyInstance, ctx: AppContext): Io {
  let token: string | null = null;
  return {
    async call<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
      if (!token || !findSession(ctx, 'admin', token)) token = createSession(ctx, 'admin', null).token;
      const res = await app.inject({
        method,
        url,
        headers: { cookie: `${COOKIES.admin}=${token}` },
        ...(method === 'GET' || method === 'DELETE' ? {} : { payload: (body ?? {}) as object }),
      });
      const text = res.body;
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      if (res.statusCode >= 400) {
        const e = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
        throw new HttpError(res.statusCode, e?.code ?? 'internal', e?.message ?? `${method} ${url} failed (${res.statusCode}).`);
      }
      return json as T;
    },
  };
}
