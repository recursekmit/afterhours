/* Messages between the page and the scanner worker. */
import type { FrameResult } from './pipeline';

export type WorkerIn = {
  type: 'frame';
  id: number;
  width: number;
  height: number;
  at: number;
  /** preferred: the worker draws it (zero copies on the page) */
  bitmap?: ImageBitmap;
  /** fallback: RGBA bytes the page read from its own canvas (transferred, handed back with the result) */
  rgba?: ArrayBuffer;
};

export type WorkerOut =
  | { type: 'ready'; offscreen: boolean }
  | { type: 'result'; id: number; result: FrameResult; rgba?: ArrayBuffer }
  | { type: 'error'; id: number; message: string; rgba?: ArrayBuffer };
