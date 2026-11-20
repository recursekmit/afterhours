// Item photos: JSON base64 in, a file next to the database out. No SVG (it can carry script).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { MAX_IMAGE_BYTES } from '@afterhours/shared/features/stalls';
import { type FeatureContext, HttpError, badRequest } from '../../core';

const dirs = new WeakMap<FeatureContext, string>();

/** <database folder>/stall-images. Tests get a throwaway folder so they never write into the repo. */
export function imagesDir(ctx: FeatureContext): string {
  let d = dirs.get(ctx);
  if (!d) {
    d = ctx.config.env === 'test' ? mkdtempSync(join(tmpdir(), 'ah-stall-img-')) : join(dirname(resolve(ctx.config.databasePath)), 'stall-images');
    mkdirSync(d, { recursive: true });
    dirs.set(ctx, d);
  }
  return d;
}

type Kind = { ext: 'png' | 'jpg' | 'webp' | 'gif'; mime: string };

function sniff(b: Buffer): Kind | null {
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return { ext: 'gif', mime: 'image/gif' };
  return null;
}

export const IMAGE_NAME_RE = /^[a-f0-9]{24}\.(png|jpg|webp|gif)$/;
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/** Decode, check size and type, store. Returns the stored file name. */
export function saveImage(ctx: FeatureContext, data: string): string {
  const b64 = data.replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) throw badRequest('That does not look like an image.');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new HttpError(413, 'too_large', `Image is ${Math.ceil(buf.length / 1024)} KB. The limit is ${Math.floor(MAX_IMAGE_BYTES / 1024)} KB: shrink it first.`);
  }
  const kind = sniff(buf);
  if (!kind) throw badRequest('Use a PNG, JPEG, WebP or GIF.');
  const name = `${randomBytes(12).toString('hex')}.${kind.ext}`;
  writeFileSync(join(imagesDir(ctx), name), buf);
  return name;
}

export function readImage(ctx: FeatureContext, name: string): { body: Buffer; mime: string } | null {
  if (!IMAGE_NAME_RE.test(name)) return null;
  const p = join(imagesDir(ctx), name);
  if (!existsSync(p)) return null;
  return { body: readFileSync(p), mime: MIME[name.split('.')[1] ?? ''] ?? 'application/octet-stream' };
}

export function deleteImage(ctx: FeatureContext, name: string | null): void {
  if (!name || !IMAGE_NAME_RE.test(name)) return;
  try {
    rmSync(join(imagesDir(ctx), name), { force: true });
  } catch {
    // an orphaned file is harmless
  }
}
