/*
  Synthetic camera for the scanner tests (Node, no canvas dependency).
  Test-only: never imported by app code.

  rasterSlip(layout, pxPerMm)     the slip as printed, from layoutSlip geometry, anti-aliased
  cameraScene(slip, opts)         that print "photographed": a 3D pose (quarter turns, tilt,
                                  perspective, distance) over a cluttered desk, then hall
                                  conditions (blur, motion blur, noise, dim light, low contrast,
                                  lighting gradient, a hand shadow), quantised to 8 bits
*/
import { type Homography, type Pt, homography, invert } from '../geometry';
import type { Gray } from '../image';

type R = { x: number; y: number; w: number; h: number };
/**
 * The parts of a SlipLayout (shared/src/morse-slip.ts) the rasteriser draws. Structural on purpose:
 * the e2e program imports this file and must not pull the shared package into its type check.
 */
export interface SlipLayout {
  widthMm: number;
  heightMm: number;
  frame: { outer: R; inner: R };
  finders: { cx: number; cy: number; r: number; ring: number; dotR: number }[];
  strips: { symbols: ({ kind: 'dot'; cx: number; cy: number; r: number } | { kind: 'dash'; x: number; y: number; w: number; h: number })[] }[];
  decor: { area: R; logo: R; number: R; doodle: R };
}

export interface FloatImage {
  width: number;
  height: number;
  /** 0 = black, 1 = white */
  data: Float32Array;
}

/** mulberry32: small seeded PRNG so every case is repeatable. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PAPER = 0.95;
const INK = 0.08;

type Inside = (x: number, y: number) => boolean;

/** Anti-aliased fill (3x3 supersampling) of a shape within its mm bounding box. */
function fill(img: FloatImage, ppm: number, bx: number, by: number, bw: number, bh: number, inside: Inside, ink = INK) {
  const x0 = Math.max(0, Math.floor(bx * ppm) - 1);
  const y0 = Math.max(0, Math.floor(by * ppm) - 1);
  const x1 = Math.min(img.width - 1, Math.ceil((bx + bw) * ppm) + 1);
  const y1 = Math.min(img.height - 1, Math.ceil((by + bh) * ppm) + 1);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      let n = 0;
      for (let sy = 0; sy < 3; sy++)
        for (let sx = 0; sx < 3; sx++) if (inside((x + (sx + 0.5) / 3) / ppm, (y + (sy + 0.5) / 3) / ppm)) n++;
      if (!n) continue;
      const cov = n / 9;
      const i = y * img.width + x;
      img.data[i] = (img.data[i] as number) * (1 - cov) + ink * cov;
    }
}

function capsule(x: number, y: number, w: number, h: number): Inside {
  const r = Math.min(w, h) / 2;
  const horiz = w >= h;
  const ax = horiz ? x + r : x + w / 2;
  const ay = horiz ? y + h / 2 : y + r;
  const bx = horiz ? x + w - r : x + w / 2;
  const by = horiz ? y + h / 2 : y + h - r;
  return (px, py) => {
    const dx = bx - ax;
    const dy = by - ay;
    const L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) <= r;
  };
}

/** The slip as printed. `clutter` adds logo / number / doodle look-alikes in the decor area. */
export function rasterSlip(L: SlipLayout, ppm: number, opts: { clutter?: boolean; seed?: number } = {}): FloatImage {
  const width = Math.round(L.widthMm * ppm);
  const height = Math.round(L.heightMm * ppm);
  const img: FloatImage = { width, height, data: new Float32Array(width * height).fill(PAPER) };
  const { outer: o, inner: n } = L.frame;
  fill(img, ppm, o.x, o.y, o.w, o.h, (x, y) => !(x > n.x && x < n.x + n.w && y > n.y && y < n.y + n.h));
  for (const f of L.finders) {
    fill(img, ppm, f.cx - f.r, f.cy - f.r, 2 * f.r, 2 * f.r, (x, y) => {
      const d = Math.hypot(x - f.cx, y - f.cy);
      return (d <= f.r && d >= f.r - f.ring) || d <= f.dotR;
    });
  }
  for (const s of L.strips)
    for (const sym of s.symbols) {
      if (sym.kind === 'dot') fill(img, ppm, sym.cx - sym.r, sym.cy - sym.r, 2 * sym.r, 2 * sym.r, (x, y) => Math.hypot(x - sym.cx, y - sym.cy) <= sym.r);
      else fill(img, ppm, sym.x, sym.y, sym.w, sym.h, capsule(sym.x, sym.y, sym.w, sym.h));
    }
  if (opts.clutter !== false) {
    const r = rng(opts.seed ?? 7);
    const { logo, number, doodle, area } = L.decor;
    // logo: a round robot head and two lines of "lettering"
    const hr = logo.h / 2;
    fill(img, ppm, logo.x, logo.y, logo.h, logo.h, (x, y) => Math.hypot(x - logo.x - hr, y - logo.y - hr) <= hr);
    for (let k = 0; k < 7; k++) {
      const lx = logo.x + logo.h * 1.2 + k * ((logo.w - logo.h * 1.2) / 7);
      fill(img, ppm, lx, logo.y + logo.h * 0.15, (logo.w - logo.h * 1.2) / 8.5, logo.h * 0.45, () => true);
    }
    fill(img, ppm, logo.x + logo.h * 1.2, logo.y + logo.h * 0.75, logo.w - logo.h * 1.3, logo.h * 0.12, () => true);
    // number: chunky glyph blocks
    for (let k = 0; k < 3; k++) fill(img, ppm, number.x + number.w * (0.1 + k * 0.3), number.y, number.w * 0.22, number.h * (0.7 + 0.3 * r()), () => true);
    // "after hours" scribble line across the middle
    for (let k = 0; k < 9; k++) {
      const wx = area.x + k * (area.w * 0.06);
      fill(img, ppm, wx, area.y + area.h * 0.45, area.w * 0.045, area.h * (0.12 + 0.06 * r()), () => true);
    }
    // turn-me doodle: three quarters of a ring with an arrow head
    const cx = doodle.x + doodle.w / 2;
    const cy = doodle.y + doodle.h / 2;
    const R = doodle.w * 0.36;
    fill(img, ppm, doodle.x, doodle.y, doodle.w, doodle.h, (x, y) => {
      const d = Math.hypot(x - cx, y - cy);
      const a = Math.atan2(y - cy, x - cx);
      return d <= R && d >= R - 0.7 && a > -Math.PI / 2;
    });
    fill(img, ppm, cx - 1.6, cy - R - 1.2, 2.4, 2.4, (x, y) => y - (cy - R - 1.2) >= Math.abs(x - cx) * 0.8 && y <= cy - R + 1.2);
  }
  return img;
}

export interface CameraOptions {
  /** scene size; phones deliver portrait 720 x 1280 when held upright */
  width?: number;
  height?: number;
  /** slip size in mm (to place it physically) */
  slipMm: { w: number; h: number };
  /** in-plane rotation, degrees clockwise on screen: 90 puts the slip's right edge at the bottom */
  rollDeg?: number;
  /** perspective: rotation about the horizontal / vertical axis, degrees */
  pitchDeg?: number;
  yawDeg?: number;
  /** scale at the slip centre, pixels per mm (the phone's distance) */
  pxPerMm?: number;
  /** camera distance in mm (stronger perspective when close) */
  distanceMm?: number;
  /** slip centre offset from the scene centre, pixels */
  offset?: Pt;
  background?: 'desk' | 'dark' | 'light';
  seed?: number;
  blur?: number;
  motionBlur?: number;
  noise?: number;
  /** multiply everything (dim hall) */
  exposure?: number;
  /** squeeze towards mid grey */
  contrast?: number;
  /** linear light falloff across the scene, 0..1 */
  gradient?: number;
  /** a soft hand shadow across part of the slip, 0..1 darkness */
  shadow?: number;
}

/** Where the slip's corners land in the scene (pixels), for a given pose. */
export function poseCorners(o: CameraOptions): Pt[] {
  const W = o.width ?? 720;
  const H = o.height ?? 1280;
  const ppm = o.pxPerMm ?? 6;
  const Z0 = o.distanceMm ?? 160;
  const fpx = ppm * Z0;
  const r = ((o.rollDeg ?? 0) * Math.PI) / 180;
  const p = ((o.pitchDeg ?? 0) * Math.PI) / 180;
  const q = ((o.yawDeg ?? 0) * Math.PI) / 180;
  const cx = W / 2 + (o.offset?.x ?? 0);
  const cy = H / 2 + (o.offset?.y ?? 0);
  const hw = o.slipMm.w / 2;
  const hh = o.slipMm.h / 2;
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([X, Y]) => {
    // roll in the image plane (y down: positive = clockwise on screen)
    let x = (X as number) * Math.cos(r) - (Y as number) * Math.sin(r);
    let y = (X as number) * Math.sin(r) + (Y as number) * Math.cos(r);
    let z = 0;
    // pitch about x
    const y2 = y * Math.cos(p) - z * Math.sin(p);
    z = y * Math.sin(p) + z * Math.cos(p);
    y = y2;
    // yaw about y
    const x2 = x * Math.cos(q) + z * Math.sin(q);
    z = -x * Math.sin(q) + z * Math.cos(q);
    x = x2;
    const zz = Z0 + z;
    return { x: cx + (fpx * x) / zz, y: cy + (fpx * y) / zz };
  });
}

function valueNoise(w: number, h: number, cell: number, r: () => number): Float32Array {
  const gw = Math.ceil(w / cell) + 2;
  const gh = Math.ceil(h / cell) + 2;
  const g = new Float32Array(gw * gh).map(() => r());
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const fx = x / cell;
      const fy = y / cell;
      const ix = fx | 0;
      const iy = fy | 0;
      const tx = fx - ix;
      const ty = fy - iy;
      const a = g[iy * gw + ix] as number;
      const b = g[iy * gw + ix + 1] as number;
      const c = g[(iy + 1) * gw + ix] as number;
      const d = g[(iy + 1) * gw + ix + 1] as number;
      out[y * w + x] = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    }
  return out;
}

/** 64k standard-normal samples, indexed by the seeded PRNG (much cheaper than Box-Muller per pixel). */
const GAUSS = (() => {
  const r = rng(424242);
  const out = new Float32Array(65536);
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
  return out;
})();

const BACKGROUNDS = new Map<string, Float32Array>();
function background(W: number, H: number, bg: 'desk' | 'dark' | 'light', variant: number): Float32Array {
  const key = `${W}x${H}/${bg}/${variant}`;
  const hit = BACKGROUNDS.get(key);
  if (hit) return hit;
  const r = rng(variant * 31 + 5);
  const base = bg === 'dark' ? 0.18 : bg === 'light' ? 0.85 : 0.5;
  const lo = valueNoise(W, H, 160, r);
  const hi = valueNoise(W, H, 9, r);
  const d = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = base + ((lo[i] as number) - 0.5) * 0.25 + ((hi[i] as number) - 0.5) * 0.06;
  // desk clutter: dark and light blocks (a pen, a phone, printed text)
  for (let k = 0; k < 14; k++) {
    const bw = 20 + r() * 160;
    const bh = 10 + r() * 90;
    const bx = r() * W;
    const by = r() * H;
    const v = r() < 0.6 ? 0.05 + r() * 0.2 : 0.8 + r() * 0.15;
    for (let y = Math.max(0, by | 0); y < Math.min(H, by + bh); y++) for (let x = Math.max(0, bx | 0); x < Math.min(W, bx + bw); x++) d[y * W + x] = v;
  }
  BACKGROUNDS.set(key, d);
  return d;
}

function boxBlurH(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const out = new Float32Array(src.length);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))] as number;
    for (let x = 0; x < w; x++) {
      out[row + x] = acc / n;
      acc += (src[row + Math.min(w - 1, x + r + 1)] as number) - (src[row + Math.max(0, x - r)] as number);
    }
  }
  return out;
}

function transpose(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x * h + y] = src[y * w + x] as number;
  return out;
}

/** Gaussian-ish blur: three box passes each way. */
export function blur(img: FloatImage, sigma: number): FloatImage {
  if (sigma <= 0.2) return img;
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2 - 0.5));
  let d = img.data;
  for (let k = 0; k < 3; k++) d = boxBlurH(d, img.width, img.height, r);
  d = transpose(d, img.width, img.height);
  for (let k = 0; k < 3; k++) d = boxBlurH(d, img.height, img.width, r);
  d = transpose(d, img.height, img.width);
  return { width: img.width, height: img.height, data: d };
}

function bilinear(img: FloatImage, x: number, y: number): number {
  const w = img.width;
  const h = img.height;
  if (x < 0) x = 0;
  else if (x > w - 1.001) x = w - 1.001;
  if (y < 0) y = 0;
  else if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * w + x0;
  const d = img.data;
  const a = d[i] as number;
  const b = d[i + 1] as number;
  const c = d[i + w] as number;
  const e = d[i + w + 1] as number;
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + e) * fx * fy;
}

/** Photograph a printed slip. Returns the 8-bit grayscale frame the pipeline sees. */
export function cameraScene(slip: FloatImage, o: CameraOptions): Gray {
  const W = o.width ?? 720;
  const H = o.height ?? 1280;
  const r = rng(o.seed ?? 1);
  const corners = poseCorners(o);
  const Hs = homography(
    [
      { x: 0, y: 0 },
      { x: slip.width, y: 0 },
      { x: slip.width, y: slip.height },
      { x: 0, y: slip.height },
    ],
    corners,
  ) as Homography;
  const inv = invert(Hs) as Homography;
  // background (cached: building value noise is the slow part)
  const bg = o.background ?? 'desk';
  const img: FloatImage = { width: W, height: H, data: background(W, H, bg, (o.seed ?? 1) % 6).slice() };
  // the slip on top, supersampled 2x2 for clean edges, only inside its bounding box
  const bx0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.x))) - 1);
  const bx1 = Math.min(W - 1, Math.ceil(Math.max(...corners.map((c) => c.x))) + 1);
  const by0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.y))) - 1);
  const by1 = Math.min(H - 1, Math.ceil(Math.max(...corners.map((c) => c.y))) + 1);
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = inv as unknown as number[] as [number, number, number, number, number, number, number, number, number];
  const sw = slip.width;
  const sh = slip.height;
  for (let y = by0; y <= by1; y++)
    for (let x = bx0; x <= bx1; x++) {
      let acc = 0;
      let n = 0;
      for (let sy = 0; sy < 2; sy++)
        for (let sx = 0; sx < 2; sx++) {
          const X = x + 0.25 + sx * 0.5;
          const Y = y + 0.25 + sy * 0.5;
          const w = h6 * X + h7 * Y + h8;
          const px = (h0 * X + h1 * Y + h2) / w;
          const py = (h3 * X + h4 * Y + h5) / w;
          if (px >= 0 && py >= 0 && px < sw && py < sh) {
            acc += bilinear(slip, px - 0.5, py - 0.5);
            n++;
          }
        }
      if (n) {
        const i = y * W + x;
        img.data[i] = (acc + (img.data[i] as number) * (4 - n)) / 4;
      }
    }
  // light
  const ga = r() * Math.PI * 2;
  const gx = Math.cos(ga);
  const gy = Math.sin(ga);
  const sa = r() * Math.PI * 2;
  const sx = Math.cos(sa);
  const sy = Math.sin(sa);
  const c0 = corners.reduce((s, p) => ({ x: s.x + p.x / 4, y: s.y + p.y / 4 }), { x: 0, y: 0 });
  const span = Math.hypot(W, H);
  if (o.gradient || o.shadow)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let v = img.data[i] as number;
      if (o.gradient) v *= 1 - o.gradient * (0.5 + ((x - W / 2) * gx + (y - H / 2) * gy) / span);
      if (o.shadow) {
        const d = (x - c0.x) * sx + (y - c0.y) * sy;
        const t = Math.max(0, Math.min(1, 0.5 + d / 40));
        v *= 1 - o.shadow * t;
      }
      img.data[i] = v;
    }
  let out = img;
  if (o.motionBlur && o.motionBlur > 1) out = { ...out, data: boxBlurH(out.data, W, H, Math.round(o.motionBlur / 2)) };
  if (o.blur) out = blur(out, o.blur);
  const exp = o.exposure ?? 1;
  const con = o.contrast ?? 1;
  const noise = o.noise ?? 0.01;
  const data = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    let v = (out.data[i] as number) * exp;
    v = 0.5 * exp + (v - 0.5 * exp) * con;
    v += noise * (GAUSS[(r() * GAUSS.length) | 0] as number);
    data[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
  }
  return { width: W, height: H, data };
}

/** Gray -> RGBA, as a canvas would hand it over. */
export function grayToRgba(g: Gray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(g.width * g.height * 4);
  for (let i = 0; i < g.width * g.height; i++) {
    const v = g.data[i] as number;
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** An RGBA print (e.g. the SVG renderer screenshot) as a float slip image. */
export function rgbaToFloat(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): FloatImage {
  const data = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) data[i] = (0.299 * (rgba[i * 4] as number) + 0.587 * (rgba[i * 4 + 1] as number) + 0.114 * (rgba[i * 4 + 2] as number)) / 255;
  return { width, height, data };
}
