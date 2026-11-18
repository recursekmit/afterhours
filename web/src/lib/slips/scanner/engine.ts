/*
  Frame pump: camera <video> -> pipeline -> FrameResult, without blocking the UI.

    worker-bitmap   createImageBitmap(video) transferred to the worker, drawn on an
                    OffscreenCanvas there (Chrome Android, Safari 16.4+)
    worker-rgba     the page draws the frame and transfers the RGBA bytes
    main            no workers at all: process on the page, throttled

  Exactly one frame is in flight; a new one is grabbed only when the last result
  is back, so a slow phone simply processes fewer frames instead of lagging.
*/
import { rgbaToGray } from './image';
import { PIPELINE_CONFIG } from './config';
import { type FrameResult, processFrame } from './pipeline';
import type { WorkerIn, WorkerOut } from './protocol';

export type EngineMode = 'worker-bitmap' | 'worker-rgba' | 'main';

export interface EngineStats {
  mode: EngineMode;
  /** processed frames per second (rolling) */
  fps: number;
  /** last pipeline time, ms */
  ms: number;
  width: number;
  height: number;
}

/** Longest side handed to the pipeline (frames are scaled down to this). */
const MAX_SIDE = 1280;
const MAIN_MAX_SIDE = 960;
const MAIN_MIN_INTERVAL_MS = 160;

export class SlipEngine {
  private worker: Worker | null = null;
  private mode: EngineMode = 'main';
  private busy = false;
  private id = 0;
  private canvas: HTMLCanvasElement | null = null;
  private spare: ArrayBuffer | null = null;
  private stamps: number[] = [];
  private lastMs = 0;
  private lastMain = 0;
  private size = { width: 0, height: 0 };
  private disposed = false;

  constructor(private readonly onResult: (r: FrameResult, stats: EngineStats) => void) {}

  /** Start the worker if the browser can; resolves with the mode that will be used. */
  async init(): Promise<EngineMode> {
    if (typeof Worker === 'undefined') return (this.mode = 'main');
    try {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'slip-scanner' });
      const ready = await new Promise<{ offscreen: boolean } | null>((resolve) => {
        const t = window.setTimeout(() => resolve(null), 4000);
        w.onmessage = (e: MessageEvent<WorkerOut>) => {
          if (e.data.type === 'hello') w.postMessage({ type: 'config', spec: PIPELINE_CONFIG.spec, table: { ...PIPELINE_CONFIG.table } } satisfies WorkerIn);
          else if (e.data.type === 'ready') {
            window.clearTimeout(t);
            resolve({ offscreen: e.data.offscreen });
          }
        };
        w.onerror = () => {
          window.clearTimeout(t);
          resolve(null);
        };
      });
      if (!ready || this.disposed) {
        w.terminate();
        return (this.mode = 'main');
      }
      w.onmessage = (e: MessageEvent<WorkerOut>) => this.fromWorker(e.data);
      w.onerror = () => {
        // a crashed worker: carry on in the page
        this.worker?.terminate();
        this.worker = null;
        this.mode = 'main';
        this.busy = false;
      };
      this.worker = w;
      this.mode = ready.offscreen && typeof createImageBitmap === 'function' ? 'worker-bitmap' : 'worker-rgba';
    } catch {
      this.mode = 'main';
    }
    return this.mode;
  }

  get currentMode(): EngineMode {
    return this.mode;
  }

  /** Offer the current video frame. Returns false if a frame is still being processed. */
  feed(video: HTMLVideoElement): boolean {
    if (this.busy || this.disposed || video.readyState < 2 || !video.videoWidth) return false;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const cap = this.mode === 'main' ? MAIN_MAX_SIDE : MAX_SIDE;
    const k = Math.min(1, cap / Math.max(vw, vh));
    const width = Math.round(vw * k);
    const height = Math.round(vh * k);
    this.size = { width, height };
    const at = performance.now();
    if (this.mode === 'main') {
      if (at - this.lastMain < MAIN_MIN_INTERVAL_MS) return false;
      this.lastMain = at;
      const data = this.grab(video, width, height);
      if (!data) return false;
      const r = processFrame(rgbaToGray(data, width, height), at);
      this.done(r);
      return true;
    }
    const id = ++this.id;
    this.busy = true;
    if (this.mode === 'worker-bitmap') {
      const opts: ImageBitmapOptions = k < 1 ? { resizeWidth: width, resizeHeight: height, resizeQuality: 'low' } : {};
      createImageBitmap(video, opts)
        .then((bitmap) => {
          if (this.disposed || !this.worker) return bitmap.close();
          const m: WorkerIn = { type: 'frame', id, width, height, at, bitmap };
          this.worker.postMessage(m, [bitmap]);
        })
        .catch(() => {
          // some Safari versions refuse video bitmaps: fall back to page-side reads
          this.mode = 'worker-rgba';
          this.busy = false;
        });
      return true;
    }
    const data = this.grab(video, width, height);
    if (!data || !this.worker) {
      this.busy = false;
      return false;
    }
    const buf = this.spare && this.spare.byteLength === data.byteLength ? this.spare : new ArrayBuffer(data.byteLength);
    this.spare = null;
    new Uint8ClampedArray(buf).set(data);
    const m: WorkerIn = { type: 'frame', id, width, height, at, rgba: buf };
    this.worker.postMessage(m, [buf]);
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
  }

  private grab(video: HTMLVideoElement, width: number, height: number): Uint8ClampedArray | null {
    if (!this.canvas) this.canvas = document.createElement('canvas');
    const c = this.canvas;
    if (c.width !== width || c.height !== height) {
      c.width = width;
      c.height = height;
    }
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height).data;
  }

  private fromWorker(m: WorkerOut) {
    if (m.type === 'ready' || m.type === 'hello') return;
    if (m.rgba) this.spare = m.rgba;
    this.busy = false;
    if (m.type === 'result') this.done(m.result);
  }

  private done(r: FrameResult) {
    if (this.disposed) return;
    const t = performance.now();
    this.stamps.push(t);
    while (this.stamps.length > 1 && t - (this.stamps[0] as number) > 2000) this.stamps.shift();
    const span = (t - (this.stamps[0] as number)) / 1000;
    this.lastMs = r.ms;
    const fps = span > 0 ? (this.stamps.length - 1) / span : 0;
    this.onResult(r, { mode: this.mode, fps: Math.round(fps * 10) / 10, ms: Math.round(this.lastMs), width: this.size.width, height: this.size.height });
  }
}
