/* Plane geometry for the scanner: homographies, convex hulls, quad fitting, line fits. */

export interface Pt {
  x: number;
  y: number;
}

/** 3x3 row-major, maps (x, y, 1) -> (u, v, w). */
export type Homography = Float64Array;

/** The homography taking src[i] to dst[i] (4 points, no three collinear). Null if degenerate. */
export function homography(src: readonly Pt[], dst: readonly Pt[]): Homography | null {
  // Solve A h = b for the 8 unknowns (h33 = 1).
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i] as Pt;
    const { x: u, y: v } = dst[i] as Pt;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  if (!h) return null;
  return Float64Array.from([...h, 1]);
}

function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i] as number]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs((M[r] as number[])[c] as number) > Math.abs((M[p] as number[])[c] as number)) p = r;
    const pr = M[p] as number[];
    if (Math.abs(pr[c] as number) < 1e-12) return null;
    [M[c], M[p]] = [pr, M[c] as number[]];
    const rc = M[c] as number[];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const rr = M[r] as number[];
      const f = (rr[c] as number) / (rc[c] as number);
      if (f === 0) continue;
      for (let k = c; k <= n; k++) rr[k] = (rr[k] as number) - f * (rc[k] as number);
    }
  }
  return M.map((row, i) => (row[n] as number) / (row[i] as number));
}

export function apply(H: Homography, x: number, y: number): Pt {
  const w = (H[6] as number) * x + (H[7] as number) * y + (H[8] as number);
  return { x: ((H[0] as number) * x + (H[1] as number) * y + (H[2] as number)) / w, y: ((H[3] as number) * x + (H[4] as number) * y + (H[5] as number)) / w };
}

/** Composition: (A after B)(p) = A(B(p)). */
export function compose(A: Homography, B: Homography): Homography {
  const out = new Float64Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += (A[r * 3 + k] as number) * (B[k * 3 + c] as number);
      out[r * 3 + c] = s;
    }
  return out;
}

export function invert(H: Homography): Homography | null {
  const [a, b, c, d, e, f, g, h, i] = H as unknown as number[] as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return Float64Array.from([A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det));
}

const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Convex hull, monotone chain. Returns points in clockwise order on screen (y down). */
export function convexHull(points: Pt[]): Pt[] {
  if (points.length < 3) return [...points];
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] as Pt, lower[lower.length - 1] as Pt, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i] as Pt;
    while (upper.length >= 2 && cross(upper[upper.length - 2] as Pt, upper[upper.length - 1] as Pt, q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export function polygonArea(poly: readonly Pt[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Pt;
    const b = poly[(i + 1) % poly.length] as Pt;
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Signed distance of p from the line a->b. */
function lineDist(a: Pt, b: Pt, p: Pt): number {
  const L = dist(a, b) || 1;
  return cross(a, b, p) / L;
}

/** A quadrilateral spanning the hull: two far-apart corners, then the farthest point on each side. */
export function quadFromHull(hull: Pt[]): Pt[] | null {
  if (hull.length < 4) return null;
  const c = hull.reduce((s, p) => ({ x: s.x + p.x / hull.length, y: s.y + p.y / hull.length }), { x: 0, y: 0 });
  let A = hull[0] as Pt;
  for (const p of hull) if (dist(p, c) > dist(A, c)) A = p;
  let C = hull[0] as Pt;
  for (const p of hull) if (dist(p, A) > dist(C, A)) C = p;
  let B: Pt | null = null;
  let D: Pt | null = null;
  let bd = 0;
  let dd = 0;
  for (const p of hull) {
    const s = lineDist(A, C, p);
    if (s > bd) {
      bd = s;
      B = p;
    }
    if (-s > dd) {
      dd = -s;
      D = p;
    }
  }
  if (!B || !D) return null;
  return orderClockwise([A, B, C, D]);
}

/** Order 4 points clockwise on screen (y down), starting anywhere. */
export function orderClockwise(q: Pt[]): Pt[] {
  const c = q.reduce((s, p) => ({ x: s.x + p.x / q.length, y: s.y + p.y / q.length }), { x: 0, y: 0 });
  return [...q].sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x));
}

/** Total least squares line through points: centroid + unit direction. */
export function fitLine(pts: Pt[]): { c: Pt; d: Pt } | null {
  if (pts.length < 2) return null;
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= pts.length;
  my /= pts.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { c: { x: mx, y: my }, d: { x: Math.cos(theta), y: Math.sin(theta) } };
}

export function intersect(l1: { c: Pt; d: Pt }, l2: { c: Pt; d: Pt }): Pt | null {
  const det = l1.d.x * l2.d.y - l1.d.y * l2.d.x;
  if (Math.abs(det) < 1e-9) return null;
  const t = ((l2.c.x - l1.c.x) * l2.d.y - (l2.c.y - l1.c.y) * l2.d.x) / det;
  return { x: l1.c.x + t * l1.d.x, y: l1.c.y + t * l1.d.y };
}

/**
 * Refine a rough quad with robust line fits: boundary points near each edge
 * (ignoring the rounded corners) are fitted, trimmed of outliers (a finger on the
 * frame), refitted, and adjacent lines intersected.
 */
export function refineQuad(quad: Pt[], boundary: Pt[]): Pt[] {
  const lines: { c: Pt; d: Pt }[] = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i] as Pt;
    const b = quad[(i + 1) % 4] as Pt;
    const L = dist(a, b);
    const tol = Math.max(3, L * 0.06);
    const ux = (b.x - a.x) / L;
    const uy = (b.y - a.y) / L;
    let pts = boundary.filter((p) => {
      const t = (p.x - a.x) * ux + (p.y - a.y) * uy;
      return t > L * 0.12 && t < L * 0.88 && Math.abs(lineDist(a, b, p)) < tol;
    });
    let line = fitLine(pts);
    if (!line || pts.length < 6) return quad;
    for (let it = 0; it < 2; it++) {
      const ln = line;
      const res = pts.map((p) => Math.abs((p.x - ln.c.x) * -ln.d.y + (p.y - ln.c.y) * ln.d.x));
      const sorted = [...res].sort((x, y) => x - y);
      const cut = Math.max(1, (sorted[Math.floor(sorted.length * 0.8)] as number) * 1.5);
      pts = pts.filter((_, k) => (res[k] as number) <= cut);
      const nl = fitLine(pts);
      if (!nl) break;
      line = nl;
    }
    lines.push(line);
  }
  const out: Pt[] = [];
  for (let i = 0; i < 4; i++) {
    const p = intersect(lines[(i + 3) % 4] as { c: Pt; d: Pt }, lines[i] as { c: Pt; d: Pt });
    if (!p) return quad;
    // a refinement that moves a corner far is a bad fit, keep the rough one
    if (dist(p, quad[i] as Pt) > Math.max(6, 0.08 * dist(quad[i] as Pt, quad[(i + 2) % 4] as Pt))) return quad;
    out.push(p);
  }
  return out;
}

export function isConvex(q: readonly Pt[]): boolean {
  let sign = 0;
  for (let i = 0; i < q.length; i++) {
    const c = cross(q[i] as Pt, q[(i + 1) % q.length] as Pt, q[(i + 2) % q.length] as Pt);
    if (Math.abs(c) < 1e-9) return false;
    const s = Math.sign(c);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

export { dist };
