/*
  Minimal PNG codec for test fixtures (8-bit gray / RGB / RGBA, non-interlaced).
  The zlib step is injected so this file needs no Node or DOM imports:
    Node:  (d) => zlib.inflateSync(d)      Vitest/browser: inflateWithStreams
*/

export type Zlib = (data: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/** zlib inflate via the standard DecompressionStream (Node 18+, browsers). */
export async function inflateWithStreams(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const buf = await new Response(new Blob([data as BlobPart]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}

/** zlib deflate via CompressionStream. */
export async function deflateWithStreams(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const buf = await new Response(new Blob([data as BlobPart]).stream().pipeThrough(cs)).arrayBuffer();
  return new Uint8Array(buf);
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = (CRC[(c ^ (p[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface Raster {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel */
  rgba: Uint8Array;
}

export async function decodePng(bytes: Uint8Array, inflate: Zlib): Promise<Raster> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8;
  let width = 0;
  let height = 0;
  let ctype = 0;
  const idat: Uint8Array[] = [];
  while (p < bytes.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    const body = bytes.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(p + 8);
      height = dv.getUint32(p + 12);
      if (body[8] !== 8 || body[12] !== 0) throw new Error('only 8-bit non-interlaced PNGs');
      ctype = body[9] as number;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const bpp = ctype === 6 ? 4 : ctype === 2 ? 3 : ctype === 0 ? 1 : ctype === 4 ? 2 : 0;
  if (!bpp) throw new Error(`PNG colour type ${ctype} not supported`);
  const total = idat.reduce((n, c) => n + c.length, 0);
  const z = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    z.set(c, o);
    o += c.length;
  }
  const raw = await inflate(z);
  const stride = width * bpp;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)] as number;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? (px[dst + x - bpp] as number) : 0;
      const b = y > 0 ? (px[dst - stride + x] as number) : 0;
      const c = x >= bpp && y > 0 ? (px[dst - stride + x - bpp] as number) : 0;
      const v = raw[src + x] as number;
      let r: number;
      if (f === 0) r = v;
      else if (f === 1) r = v + a;
      else if (f === 2) r = v + b;
      else if (f === 3) r = v + ((a + b) >> 1);
      else {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[dst + x] = r & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * bpp;
    if (bpp >= 3) {
      rgba[i * 4] = px[s] as number;
      rgba[i * 4 + 1] = px[s + 1] as number;
      rgba[i * 4 + 2] = px[s + 2] as number;
      rgba[i * 4 + 3] = bpp === 4 ? (px[s + 3] as number) : 255;
    } else {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = px[s] as number;
      rgba[i * 4 + 3] = bpp === 2 ? (px[s + 1] as number) : 255;
    }
  }
  return { width, height, rgba };
}

/** 8-bit grayscale PNG. */
export async function encodeGrayPng(width: number, height: number, gray: Uint8Array, deflate: Zlib): Promise<Uint8Array> {
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) raw.set(gray.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const z = await deflate(raw);
  const chunk = (type: string, body: Uint8Array) => {
    const t = new TextEncoder().encode(type);
    const out = new Uint8Array(12 + body.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    out.set(t, 4);
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc32([t, body]));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}
