/*
  Slip scanner worker. Receives camera frames (an ImageBitmap it draws into an
  OffscreenCanvas, or raw RGBA bytes the page already read) and runs the same
  processFrame() the tests measure. One frame in flight at a time; the page
  waits for each result before sending the next, so the queue never grows.
*/
import { rgbaToGray } from './image';
import { configurePipeline, processFrame } from './pipeline';
import type { WorkerIn, WorkerOut } from './protocol';

const scope = self as unknown as {
  postMessage(m: WorkerOut, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
};

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
const offscreen = typeof OffscreenCanvas !== 'undefined';

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'config') {
    configurePipeline(m.spec, m.table);
    scope.postMessage({ type: 'ready', offscreen });
    return;
  }
  try {
    let rgba: Uint8ClampedArray;
    if (m.bitmap) {
      if (!canvas || canvas.width !== m.width || canvas.height !== m.height) {
        canvas = new OffscreenCanvas(m.width, m.height);
        ctx = canvas.getContext('2d', { willReadFrequently: true });
      }
      if (!ctx) throw new Error('no 2d context in worker');
      ctx.drawImage(m.bitmap, 0, 0, m.width, m.height);
      m.bitmap.close();
      rgba = ctx.getImageData(0, 0, m.width, m.height).data;
    } else if (m.rgba) {
      rgba = new Uint8ClampedArray(m.rgba);
    } else throw new Error('empty frame');
    const result = processFrame(rgbaToGray(rgba, m.width, m.height), m.at);
    const out: WorkerOut = { type: 'result', id: m.id, result, rgba: m.rgba };
    scope.postMessage(out, m.rgba ? [m.rgba] : []);
  } catch (err) {
    scope.postMessage({ type: 'error', id: m.id, message: (err as Error).message, rgba: m.rgba }, m.rgba ? [m.rgba] : []);
  }
};

scope.postMessage({ type: 'hello' });
