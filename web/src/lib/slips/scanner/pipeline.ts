/*
  The slip reader. One grayscale camera frame in, one FrameResult out.
  The worker, the main-thread fallback and the Node accuracy harness all call
  processFrame(), so what the tests measure is exactly what phones run.

   1. downscale to <= ~640 px and adaptive-threshold (uneven hall light)
   2. connected components; the slip frame is a big thin ring
   3. its outer boundary -> convex hull -> quad -> robust line refit (fingers, blur)
   4. view rule: the quad edge facing the bottom of the VIEW is "bottom"; its tilt
      decides the ambiguity zone around 45 degrees
   5. rectify the slip upright in the current view orientation and find the four
      finder marks (bullseyes) near the corners, checked against SLIP_SPEC ratios
   6. a second homography from the finder centres gives "band space" (1 unit =
      finder diameter = band height), where every band position comes from SLIP_SPEC
   7. sample each band from the full-resolution frame into a straight strip image,
      threshold it, keep the blobs on the band centreline
   8. fit the Morse unit (dot vs dash by length, gaps 1/3/7 by centre spacing,
      which is immune to blur growing or shrinking the ink)
   9. decode, score confidence, pick the bottom strip as primary
*/
import { SLIP_SPEC, type SlipScan, type StripReading, decodeMorse } from '../../../../../shared/src/morse-slip';
import { type Homography, type Pt, apply, convexHull, dist, homography, isConvex, polygonArea, quadFromHull, refineQuad } from './geometry';
import { type Gray, adaptiveThreshold, components, downscale2, sample } from './image';

export type FrameStatus =
  /** no slip in view */
  | 'none'
  /** a slip, but too small to read: come closer */
  | 'far'
  /** held near 45 degrees: no edge is clearly at the bottom, so nothing is reported */
  | 'ambiguous'
  /** the bottom edge has no strip */
  | 'blank'
  /** the bottom strip is there but did not read cleanly */
  | 'unreadable'
  | 'ok';

export type ViewSide = 'bottom' | 'right' | 'top' | 'left';

export interface BandResult {
  /** where this band is in the current view */
  side: ViewSide;
  /** band outline in frame pixels (for the live overlay) */
  poly: Pt[];
  reading: StripReading | null;
  symbols: number;
}

export interface FrameResult {
  status: FrameStatus;
  /** this frame's reading (not yet stable). null unless status is ok or blank */
  scan: SlipScan | null;
  /** in-plane rotation of the slip vs. the view, degrees, clockwise positive, in (-45, 45] */
  tiltDeg: number | null;
  /** slip frame corners in frame pixels, view order: top-left, top-right, bottom-right, bottom-left */
  quad: Pt[] | null;
  finders: Pt[];
  bands: BandResult[];
  width: number;
  height: number;
  /** processing time of this frame */
  ms: number;
}

export interface ScanOptions {
  /** longest side of the detection image (frames are halved until they fit). default 640 */
  detectMaxSide?: number;
  /** beyond this tilt (degrees) the slip is in the ambiguity zone. default 30 */
  ambiguityDeg?: number;
  /** below this many pixels across, the slip is "too far". default 150 */
  minSlipPx?: number;
  /** bottom strips under this confidence are "unreadable" rather than reported. default 0.35 */
  minConfidence?: number;
}

export const DEFAULT_AMBIGUITY_DEG = 30;

const S = SLIP_SPEC;
/** finder centre distance from the frame's outer edge, in finder diameters */
const FINDER_OFFSET = (S.frameMm + S.innerGapMm + S.bandMm / 2) / S.bandMm;
/** finder-to-band gap, in band units */
const FINDER_GAP = S.finderGapMm / S.bandMm;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function processFrame(gray: Gray, at = 0, opts: ScanOptions = {}): FrameResult {
  const t0 = now();
  const res = run(gray, at, opts);
  res.ms = now() - t0;
  return res;
}

function empty(gray: Gray, status: FrameStatus = 'none'): FrameResult {
  return { status, scan: null, tiltDeg: null, quad: null, finders: [], bands: [], width: gray.width, height: gray.height, ms: 0 };
}

function run(gray: Gray, at: number, opts: ScanOptions): FrameResult {
  const detectMax = opts.detectMaxSide ?? 640;
  const ambiguity = opts.ambiguityDeg ?? DEFAULT_AMBIGUITY_DEG;
  const minSlip = opts.minSlipPx ?? 150;
  const minConf = opts.minConfidence ?? 0.35;

  // pyramid: level 0 = the frame, each next level half size
  const levels: Gray[] = [gray];
  while (Math.max((levels[levels.length - 1] as Gray).width, (levels[levels.length - 1] as Gray).height) > detectMax * 1.25) {
    levels.push(downscale2(levels[levels.length - 1] as Gray));
  }
  const detLevel = levels.length - 1;
  const det = levels[detLevel] as Gray;
  const f = 2 ** detLevel;
  // quads are in continuous pixel coordinates (pixel i spans [i, i+1]), so levels scale exactly
  const toFull = (p: Pt): Pt => ({ x: p.x * f, y: p.y * f });

  const minDim = Math.min(det.width, det.height);
  const bin = adaptiveThreshold(det, Math.max(15, Math.round(minDim / 7)) | 1, 0.15, 10);
  const cc = components(bin, det.width, det.height);

  // frame candidates: big, thin rings
  const cands: number[] = [];
  for (let id = 1; id <= cc.count; id++) {
    const bw = (cc.maxX[id] as number) - (cc.minX[id] as number) + 1;
    const bh = (cc.maxY[id] as number) - (cc.minY[id] as number) + 1;
    if (Math.max(bw, bh) < minDim * 0.16 || Math.min(bw, bh) < minDim * 0.08) continue;
    const fill = (cc.area[id] as number) / (bw * bh);
    if (fill < 0.02 || fill > 0.5) continue;
    cands.push(id);
  }
  cands.sort((a, b) => (cc.area[b] as number) - (cc.area[a] as number));

  let best: FrameResult | null = null;
  for (const id of cands.slice(0, 5)) {
    const quadDet = frameQuad(cc, id, det.width, bin);
    if (!quadDet) continue;
    const r = readSlip(levels, quadDet.map(toFull), at, ambiguity, minSlip, minConf);
    if (!r) continue;
    if (!best || rank(r) > rank(best)) best = r;
    if (best.status === 'ok') break;
  }
  return best ?? empty(gray);
}

const rank = (r: FrameResult) => ({ none: 0, far: 1, ambiguous: 2, unreadable: 3, blank: 4, ok: 5 })[r.status];

/** The outer quad of a frame-ring component, in detection pixels. Null if it is not a clean rectangle ring. */
function frameQuad(cc: ReturnType<typeof components>, id: number, w: number, bin: Uint8Array): Pt[] | null {
  const x0 = cc.minX[id] as number;
  const x1 = cc.maxX[id] as number;
  const y0 = cc.minY[id] as number;
  const y1 = cc.maxY[id] as number;
  const L = cc.labels;
  const boundary: Pt[] = [];
  for (let y = y0; y <= y1; y++) {
    const row = y * w;
    let a = -1;
    let b = -1;
    for (let x = x0; x <= x1; x++)
      if (L[row + x] === id) {
        a = x;
        break;
      }
    if (a < 0) continue;
    for (let x = x1; x >= a; x--)
      if (L[row + x] === id) {
        b = x;
        break;
      }
    boundary.push({ x: a, y: y + 0.5 }, { x: b + 1, y: y + 0.5 });
  }
  for (let x = x0; x <= x1; x++) {
    let a = -1;
    let b = -1;
    for (let y = y0; y <= y1; y++)
      if (L[y * w + x] === id) {
        a = y;
        break;
      }
    if (a < 0) continue;
    for (let y = y1; y >= a; y--)
      if (L[y * w + x] === id) {
        b = y;
        break;
      }
    boundary.push({ x: x + 0.5, y: a }, { x: x + 0.5, y: b + 1 });
  }
  const hull = convexHull(boundary);
  const rough = quadFromHull(hull);
  if (!rough || !isConvex(rough)) return null;
  const quad = refineQuad(rough, boundary);
  if (!isConvex(quad)) return null;
  const qa = polygonArea(quad);
  const ha = polygonArea(hull);
  if (qa < 0.82 * ha || qa > 1.15 * ha) return null;
  // a ring, not a solid block: ink area ~ perimeter x stroke
  let per = 0;
  let minSide = Infinity;
  for (let i = 0; i < 4; i++) {
    const s = dist(quad[i] as Pt, quad[(i + 1) % 4] as Pt);
    per += s;
    minSide = Math.min(minSide, s);
  }
  const stroke = (cc.area[id] as number) / per;
  if (stroke > 0.14 * minSide || minSide < 12) return null;
  // the frame is inked along every edge (just inside the outer boundary)
  const c = { x: quad.reduce((s, p) => s + p.x, 0) / 4, y: quad.reduce((s, p) => s + p.y, 0) / 4 };
  const inset = Math.max(0.5, stroke / 2);
  for (let i = 0; i < 4; i++) {
    const a = quad[i] as Pt;
    const b = quad[(i + 1) % 4] as Pt;
    let hit = 0;
    const N = 24;
    for (let k = 1; k < N; k++) {
      const t = k / N;
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      const dx = c.x - px;
      const dy = c.y - py;
      const dl = Math.hypot(dx, dy) || 1;
      const sx = Math.round(px + (dx / dl) * inset - 0.5);
      const sy = Math.round(py + (dy / dl) * inset - 0.5);
      if (bin[sy * w + sx]) hit++;
    }
    if (hit < (N - 1) * 0.55) return null;
  }
  return quad;
}

/** Sample from the pyramid level that best matches the wanted density (fewer aliasing artefacts). */
function pickLevel(levels: Gray[], srcPerOut: number): number {
  let l = 0;
  while (l + 1 < levels.length && srcPerOut / 2 ** (l + 1) >= 1) l++;
  return l;
}

function sampleAt(levels: Gray[], level: number, p: Pt): number {
  const f = 2 ** level;
  return sample(levels[level] as Gray, p.x / f - 0.5, p.y / f - 0.5);
}

function readSlip(levels: Gray[], quadIn: Pt[], at: number, ambiguity: number, minSlip: number, minConf: number): FrameResult | null {
  const full = levels[0] as Gray;
  const q = quadIn; // clockwise on screen
  // 4. which quad edge faces the bottom of the view (direction from the opposite edge's midpoint)
  let bi = 0;
  let bestAng = Infinity;
  for (let i = 0; i < 4; i++) {
    const m = mid(q[i] as Pt, q[(i + 1) % 4] as Pt);
    const o = mid(q[(i + 2) % 4] as Pt, q[(i + 3) % 4] as Pt);
    const ang = Math.atan2(m.x - o.x, m.y - o.y); // 0 = straight down
    if (Math.abs(ang) < Math.abs(bestAng)) {
      bestAng = ang;
      bi = i;
    }
  }
  const tiltDeg = round1((-bestAng * 180) / Math.PI);
  // clockwise order: bottom edge runs bottom-right -> bottom-left
  const BR = q[bi] as Pt;
  const BL = q[(bi + 1) % 4] as Pt;
  const TL = q[(bi + 2) % 4] as Pt;
  const TR = q[(bi + 3) % 4] as Pt;
  const quad = [TL, TR, BR, BL];
  const Wq = (dist(TL, TR) + dist(BL, BR)) / 2;
  const Hq = (dist(TL, BL) + dist(TR, BR)) / 2;
  const base: FrameResult = { status: 'far', scan: null, tiltDeg, quad, finders: [], bands: [], width: full.width, height: full.height, ms: 0 };
  if (Math.max(Wq, Hq) < minSlip) return base;

  // 5. rectify upright (view orientation) at a modest size and find the finders
  const R = Math.min(440, Math.max(Wq, Hq));
  const rw = Math.max(8, Math.round((Wq * R) / Math.max(Wq, Hq)));
  const rh = Math.max(8, Math.round((Hq * R) / Math.max(Wq, Hq)));
  const Hr = homography(
    [
      { x: 0, y: 0 },
      { x: rw, y: 0 },
      { x: rw, y: rh },
      { x: 0, y: rh },
    ],
    quad,
  );
  if (!Hr) return null;
  const lvl = pickLevel(levels, Math.max(Wq, Hq) / R);
  const rect: Gray = { width: rw, height: rh, data: new Uint8Array(rw * rh) };
  for (let y = 0; y < rh; y++)
    for (let x = 0; x < rw; x++) rect.data[y * rw + x] = sampleAt(levels, lvl, apply(Hr, x + 0.5, y + 0.5));
  const rbin = adaptiveThreshold(rect, Math.max(9, Math.round(Math.min(rw, rh) / 4)) | 1, 0.15, 8);
  const rcc = components(rbin, rw, rh);
  const corners: Pt[] = [
    { x: 0, y: 0 },
    { x: rw, y: 0 },
    { x: rw, y: rh },
    { x: 0, y: rh },
  ];
  const found: ({ c: Pt; w: number; h: number; ring: boolean } | null)[] = corners.map((corner) => findFinder(rcc, rw, rh, corner));
  const nFound = found.filter(Boolean).length;
  if (nFound < 3) return null; // not a slip (or a finder is covered)
  const miss = found.findIndex((x) => !x);
  if (miss >= 0) {
    const a = found[(miss + 1) % 4]!;
    const o = found[(miss + 2) % 4]!;
    const b = found[(miss + 3) % 4]!;
    found[miss] = { c: { x: a.c.x + b.c.x - o.c.x, y: a.c.y + b.c.y - o.c.y }, w: (a.w + b.w) / 2, h: (a.h + b.h) / 2, ring: false };
  }
  const F = found as { c: Pt; w: number; h: number; ring: boolean }[];
  const fw = F.reduce((s, x) => s + x.w, 0) / 4;
  const fh = F.reduce((s, x) => s + x.h, 0) / 4;
  const Sx = (dist(F[0]!.c, F[1]!.c) + dist(F[3]!.c, F[2]!.c)) / 2 / fw;
  const Sy = (dist(F[0]!.c, F[3]!.c) + dist(F[1]!.c, F[2]!.c)) / 2 / fh;
  if (Sx < 3 || Sy < 3) return null;
  const fSrc = F.map((x) => apply(Hr, x.c.x, x.c.y));

  // 6. band space: finder centres at (0,0) (Sx,0) (Sx,Sy) (0,Sy), 1 unit = band height
  const G = homography(
    [
      { x: 0, y: 0 },
      { x: Sx, y: 0 },
      { x: Sx, y: Sy },
      { x: 0, y: Sy },
    ],
    fSrc,
  );
  if (!G) return null;
  const Dsrc = ((fw * Wq) / rw + (fh * Hq) / rh) / 2; // finder diameter in frame pixels
  const s = Math.max(22, Math.min(56, Math.round(Dsrc * 1.1)));
  const blvl = pickLevel(levels, Dsrc / s);

  const geo = (nFound === 4 ? 1 : 0.85) * (1 - Math.max(0, Math.abs(tiltDeg) - 18) / 60);
  const lo = 0.5 + FINDER_GAP;
  // sample a little past each band end; blobs centred out there are finder bleed, not symbols
  const ext = FINDER_GAP * 0.85;
  const specs: { side: ViewSide; from: Pt; to: Pt }[] = [
    { side: 'bottom', from: { x: lo - ext, y: Sy }, to: { x: Sx - lo + ext, y: Sy } },
    { side: 'right', from: { x: Sx, y: Sy - lo + ext }, to: { x: Sx, y: lo - ext } },
    // the top strip is read as seen: left to right in the view, so it comes out reversed
    { side: 'top', from: { x: lo - ext, y: 0 }, to: { x: Sx - lo + ext, y: 0 } },
    { side: 'left', from: { x: 0, y: lo - ext }, to: { x: 0, y: Sy - lo + ext } },
  ];
  const bands: BandResult[] = specs.map(({ side, from, to }) => {
    const strip = sampleBand(levels, blvl, G, from, to, s);
    const r = readStrip(strip, s, ext * s);
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    const ux = (to.x - from.x) / len;
    const uy = (to.y - from.y) / len;
    const nx = -uy * 0.5;
    const ny = ux * 0.5;
    const a0 = { x: from.x + ux * ext, y: from.y + uy * ext };
    const a1 = { x: to.x - ux * ext, y: to.y - uy * ext };
    const poly = [
      { x: a0.x - nx, y: a0.y - ny },
      { x: a1.x - nx, y: a1.y - ny },
      { x: a1.x + nx, y: a1.y + ny },
      { x: a0.x + nx, y: a0.y + ny },
    ].map((p) => apply(G, p.x, p.y));
    const position = side === 'bottom' ? 'bottom' : side === 'top' ? 'top' : 'other';
    const reading: StripReading | null = r ? { morse: r.morse, text: r.text, confidence: round2(r.fit * (r.text ? 1 : 0.5) * geo), position } : null;
    return { side, poly, reading, symbols: r?.n ?? 0 };
  });

  const result: FrameResult = { ...base, finders: fSrc, bands, status: 'ok' };
  if (Math.abs(tiltDeg) > ambiguity) {
    result.status = 'ambiguous';
    return result;
  }
  const others = bands.filter((b) => b.side !== 'bottom' && b.reading).map((b) => b.reading as StripReading);
  const bottom = (bands[0] as BandResult).reading;
  if (!bottom) {
    result.status = 'blank';
    result.scan = { primary: null, others, at };
  } else if (bottom.confidence < minConf) {
    result.status = 'unreadable';
  } else {
    result.scan = { primary: bottom, others, at };
  }
  return result;
}

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** The finder bullseye nearest a rectified corner, validated by its offset from both frame edges. */
function findFinder(cc: ReturnType<typeof components>, rw: number, rh: number, corner: Pt): { c: Pt; w: number; h: number; ring: boolean } | null {
  const minSide = Math.min(rw, rh);
  let best: { c: Pt; w: number; h: number; ring: boolean } | null = null;
  let bestScore = Infinity;
  for (let id = 1; id <= cc.count; id++) {
    const bw = (cc.maxX[id] as number) - (cc.minX[id] as number) + 1;
    const bh = (cc.maxY[id] as number) - (cc.minY[id] as number) + 1;
    if (bw < 5 || bh < 5 || bw > minSide * 0.32 || bh > minSide * 0.32 || bw < minSide * 0.035) continue;
    const asp = bw / bh;
    if (asp < 0.55 || asp > 1.8) continue;
    const fill = (cc.area[id] as number) / (bw * bh);
    if (fill < 0.22 || fill > 0.9) continue;
    const cx = ((cc.minX[id] as number) + (cc.maxX[id] as number) + 1) / 2;
    const cy = ((cc.minY[id] as number) + (cc.maxY[id] as number) + 1) / 2;
    const offx = Math.abs(cx - corner.x) / bw;
    const offy = Math.abs(cy - corner.y) / bh;
    if (offx < 0.55 || offx > 1.45 || offy < 0.55 || offy > 1.45) continue;
    const ring = cc.labels[Math.floor(cy) * rw + Math.floor(cx)] !== id;
    const score = Math.abs(offx - FINDER_OFFSET) + Math.abs(offy - FINDER_OFFSET) + (ring ? 0 : 0.35) + Math.abs(Math.log(asp)) * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = { c: { x: cx, y: cy }, w: bw, h: bh, ring };
    }
  }
  return best;
}

/** A band, straightened: x along the reading direction, y across. s pixels per band unit. */
function sampleBand(levels: Gray[], level: number, G: Homography, from: Pt, to: Pt, s: number): Gray {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const w = Math.max(4, Math.round(len * s));
  const h = s;
  const ux = (to.x - from.x) / len;
  const uy = (to.y - from.y) / len;
  // across: perpendicular, any sign (symbols are symmetric across the band)
  const nx = -uy;
  const ny = ux;
  const out = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const a = (j + 0.5) / s - 0.5;
    for (let i = 0; i < w; i++) {
      const t = (i + 0.5) / s;
      const p = apply(G, from.x + ux * t + nx * a, from.y + uy * t + ny * a);
      out[j * w + i] = sampleAt(levels, level, p);
    }
  }
  return { width: w, height: h, data: out };
}

interface Blob {
  c: number;
  L: number;
  T: number;
}

export interface StripRead {
  morse: string;
  text: string | null;
  /** 0..1, how well the blobs fit dots/dashes and 1/3/7 gaps */
  fit: number;
  n: number;
}

/** Read one straightened band. null = blank. */
export function readStrip(img: Gray, s: number, endPad = 0): StripRead | null {
  const { width: w, height: h, data } = img;
  const sorted = Uint8Array.from(data).sort();
  const p5 = sorted[Math.floor(sorted.length * 0.03)] as number;
  const p95 = sorted[Math.floor(sorted.length * 0.97)] as number;
  const contrast = p95 - p5;
  if (contrast < 18) return null;
  const bin = adaptiveThreshold(img, Math.round(s * 1.6) | 1, 0.12, Math.max(8, contrast * 0.22));
  const cc = components(bin, w, h);
  const minArea = Math.max(4, 0.006 * s * s);
  let blobs: Blob[] = [];
  for (let id = 1; id <= cc.count; id++) {
    const x0 = cc.minX[id] as number;
    const x1 = cc.maxX[id] as number;
    const y0 = cc.minY[id] as number;
    const y1 = cc.maxY[id] as number;
    if ((cc.area[id] as number) < minArea) continue;
    if (y0 === 0 || y1 === h - 1) continue;
    const cx = (x0 + x1 + 1) / 2;
    if (cx < endPad || cx > w - endPad) continue;
    if ((x0 === 0 || x1 === w - 1) && endPad === 0) continue;
    const T = y1 - y0 + 1;
    const cyy = (y0 + y1 + 1) / 2;
    if (T > 0.75 * s || T < 0.08 * s) continue;
    if (cyy < 0.25 * s || cyy > 0.75 * s) continue;
    blobs.push({ c: cx, L: x1 - x0 + 1, T });
  }
  if (blobs.length === 0) return null;
  const T = median(blobs.map((b) => b.T));
  blobs = blobs.filter((b) => b.T >= 0.5 * T && b.T <= 1.6 * T);
  if (blobs.length === 0) return null;
  blobs.sort((a, b) => a.c - b.c);

  // 8. fit the unit
  let bestU = T;
  let bestScore = Infinity;
  for (let f = 0.5; f <= 1.3001; f += 0.02) {
    const u = T * f;
    const sc = scoreUnit(blobs, u, T);
    if (sc < bestScore) {
      bestScore = sc;
      bestU = u;
    }
  }
  const { kinds, gaps, dev, gdev } = classify(blobs, bestU, T);
  let morse = '';
  kinds.forEach((k, i) => {
    if (i > 0) morse += gaps[i - 1] === 1 ? '' : gaps[i - 1] === 3 ? ' ' : ' / ';
    morse += k === 1 ? '.' : '-';
  });
  let fit = Math.max(0, Math.min(1, 1 - (bestScore - 0.1) / 0.4));
  // one badly shaped symbol or gap (two dots smeared together, a dash split) sinks the reading
  const worst = Math.max(...dev, ...gdev.map((g) => g * 0.8));
  fit *= Math.max(0, Math.min(1, 1 - (worst - 0.3) / 0.35));
  // strips are printed centred in their band: a reading that is off centre lost a symbol at one end
  if (endPad > 0) {
    const first = blobs[0] as Blob;
    const last = blobs[blobs.length - 1] as Blob;
    const span0 = first.c - (first.L - (T - bestU)) / 2;
    const span1 = last.c + (last.L - (T - bestU)) / 2;
    const off = Math.abs((span0 + span1) / 2 - w / 2) / bestU;
    fit *= Math.max(0, Math.min(1, 1 - (off - 0.6) / 0.8));
  }
  return { morse, text: decodeMorse(morse), fit, n: blobs.length };
}

function classify(blobs: Blob[], u: number, T: number): { kinds: (1 | 3)[]; gaps: (1 | 3 | 7)[]; dev: number[]; gdev: number[] } {
  const b = T - u;
  const kinds: (1 | 3)[] = [];
  const dev: number[] = [];
  for (const bl of blobs) {
    const Lc = Math.max(0.3, (bl.L - b) / u);
    const k = Lc < 2 ? 1 : 3;
    kinds.push(k);
    dev.push(Math.abs(Math.log(Lc / k)));
  }
  const gaps: (1 | 3 | 7)[] = [];
  const gdev: number[] = [];
  for (let i = 0; i + 1 < blobs.length; i++) {
    const g = Math.max(0.3, ((blobs[i + 1] as Blob).c - (blobs[i] as Blob).c) / u - ((kinds[i] as number) + (kinds[i + 1] as number)) / 2);
    const k = g < Math.sqrt(3) ? 1 : g < Math.sqrt(21) ? 3 : 7;
    gaps.push(k);
    gdev.push(Math.abs(Math.log(g / k)));
  }
  return { kinds, gaps, dev, gdev };
}

function scoreUnit(blobs: Blob[], u: number, T: number): number {
  const { dev, gdev } = classify(blobs, u, T);
  const sum = dev.reduce((a, x) => a + x, 0) + 0.8 * gdev.reduce((a, x) => a + x, 0);
  return sum / (dev.length + 0.8 * gdev.length) + 0.15 * Math.abs(Math.log(u / T));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}
