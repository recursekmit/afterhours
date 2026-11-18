/*
  Tiny image toolkit for the slip scanner: 8-bit grayscale buffers, a 2x box
  downscale, integral images, an adaptive (Bradley) threshold, bilinear sampling
  and 4-connected components. Plain typed-array loops; no DOM, so the worker,
  the main-thread fallback and the Node test harness all run the same code.
*/

export interface Gray {
  width: number;
  height: number;
  /** row-major luminance, 0 = black, 255 = white */
  data: Uint8Array;
}

/** RGBA (canvas ImageData layout) to luminance, BT.601 weights in integer maths. */
export function rgbaToGray(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Gray {
  const n = width * height;
  const out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = (77 * (rgba[j] as number) + 150 * (rgba[j + 1] as number) + 29 * (rgba[j + 2] as number)) >> 8;
  }
  return { width, height, data: out };
}

/** Half size, each output pixel the mean of a 2x2 block (cheap anti-aliasing). */
export function downscale2(src: Gray): Gray {
  const w = src.width >> 1;
  const h = src.height >> 1;
  const out = new Uint8Array(w * h);
  const s = src.data;
  const sw = src.width;
  for (let y = 0; y < h; y++) {
    let i = 2 * y * sw;
    let o = y * w;
    for (let x = 0; x < w; x++, i += 2, o++) {
      out[o] = ((s[i] as number) + (s[i + 1] as number) + (s[i + sw] as number) + (s[i + sw + 1] as number) + 2) >> 2;
    }
  }
  return { width: w, height: h, data: out };
}

/** Summed-area table with a zero row/column: (w+1) x (h+1). */
export function integral(src: Gray): Float64Array {
  const w = src.width;
  const h = src.height;
  const W = w + 1;
  const I = new Float64Array(W * (h + 1));
  const d = src.data;
  for (let y = 0; y < h; y++) {
    let row = 0;
    const o = (y + 1) * W;
    const p = y * W;
    for (let x = 0; x < w; x++) {
      row += d[y * w + x] as number;
      I[o + x + 1] = (I[p + x + 1] as number) + row;
    }
  }
  return I;
}

/**
 * Adaptive threshold: ink where a pixel is clearly darker than the mean of its
 * window (handles hall lighting gradients and shadows). 1 = ink, 0 = paper.
 *   t        relative darkness needed (0.15 = 15 % below the local mean)
 *   minDelta absolute darkness needed, so flat dark areas and sensor noise stay paper
 */
export function adaptiveThreshold(src: Gray, window: number, t = 0.15, minDelta = 10, I = integral(src)): Uint8Array {
  const w = src.width;
  const h = src.height;
  const W = w + 1;
  const r = Math.max(1, Math.floor(window / 2));
  const out = new Uint8Array(w * h);
  const d = src.data;
  const k = 1 - t;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    const rowA = y0 * W;
    const rowB = y1 * W;
    const dy = y1 - y0;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const sum = (I[rowB + x1] as number) - (I[rowA + x1] as number) - (I[rowB + x0] as number) + (I[rowA + x0] as number);
      const mean = sum / ((x1 - x0) * dy);
      const v = d[y * w + x] as number;
      if (v < mean * k && mean - v > minDelta) out[y * w + x] = 1;
    }
  }
  return out;
}

/** Bilinear sample (clamped to the image). */
export function sample(src: Gray, x: number, y: number): number {
  const w = src.width;
  const h = src.height;
  if (x < 0) x = 0;
  else if (x > w - 1.001) x = w - 1.001;
  if (y < 0) y = 0;
  else if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * w + x0;
  const d = src.data;
  const a = d[i] as number;
  const b = d[i + 1] as number;
  const c = d[i + w] as number;
  const e = d[i + w + 1] as number;
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + e) * fx * fy;
}

export interface Components {
  /** per pixel: 0 = background, otherwise component id (1..count) */
  labels: Int32Array;
  count: number;
  /** per component id (index 0 unused) */
  area: Int32Array;
  minX: Int32Array;
  maxX: Int32Array;
  minY: Int32Array;
  maxY: Int32Array;
  sumX: Float64Array;
  sumY: Float64Array;
}

/** 4-connected components of the ink pixels (two pass, union-find). */
export function components(bin: Uint8Array, w: number, h: number): Components {
  const labels = new Int32Array(w * h);
  let parent = new Int32Array(1024);
  let next = 1;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a] as number] as number;
      a = parent[a] as number;
    }
    return a;
  };
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (!bin[i]) continue;
      const left = x > 0 ? (labels[i - 1] as number) : 0;
      const up = y > 0 ? (labels[i - w] as number) : 0;
      if (left && up) {
        const a = find(left);
        const b = find(up);
        labels[i] = a;
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      } else if (left || up) {
        labels[i] = left || up;
      } else {
        if (next >= parent.length) {
          const p = new Int32Array(parent.length * 2);
          p.set(parent);
          parent = p;
        }
        parent[next] = next;
        labels[i] = next++;
      }
    }
  }
  // compact ids
  const map = new Int32Array(next);
  let count = 0;
  for (let l = 1; l < next; l++) {
    const r = find(l);
    if (r === l) map[l] = ++count;
  }
  for (let l = 1; l < next; l++) map[l] = map[find(l)] as number;
  const area = new Int32Array(count + 1);
  const minX = new Int32Array(count + 1).fill(w);
  const maxX = new Int32Array(count + 1).fill(-1);
  const minY = new Int32Array(count + 1).fill(h);
  const maxY = new Int32Array(count + 1).fill(-1);
  const sumX = new Float64Array(count + 1);
  const sumY = new Float64Array(count + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const l0 = labels[i] as number;
      if (!l0) continue;
      const l = map[l0] as number;
      labels[i] = l;
      area[l]!++;
      if (x < (minX[l] as number)) minX[l] = x;
      if (x > (maxX[l] as number)) maxX[l] = x;
      if (y < (minY[l] as number)) minY[l] = y;
      if (y > (maxY[l] as number)) maxY[l] = y;
      sumX[l]! += x;
      sumY[l]! += y;
    }
  }
  return { labels, count, area, minX, maxX, minY, maxY, sumX, sumY };
}
