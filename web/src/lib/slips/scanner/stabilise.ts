/*
  Stability gate: a reading is only reported once the same primary Morse has
  been read in N consecutive processed frames. The reported confidence is the
  mean over those frames. The same reading is not reported twice in a row
  until the slip has left the view (or a different reading was reported).
*/
import type { SlipScan } from '@afterhours/shared/morse-slip';
import type { FrameResult } from './pipeline';

export interface StabiliserOptions {
  /** consecutive identical frames needed. default 3 */
  frames?: number;
  /** frames without a slip after which the same reading may be reported again. default 8 */
  forgetAfter?: number;
}

export class SlipStabiliser {
  private readonly need: number;
  private readonly forgetAfter: number;
  private key: string | null = null;
  private run: FrameResult[] = [];
  private lastReported: string | null = null;
  private absent = 0;

  constructor(opts: StabiliserOptions = {}) {
    this.need = Math.max(1, opts.frames ?? 3);
    this.forgetAfter = opts.forgetAfter ?? 8;
  }

  /** How far the current candidate is towards being reported, 0..1 (for a progress ring). */
  get progress(): number {
    return this.key ? Math.min(1, this.run.length / this.need) : 0;
  }

  reset(): void {
    this.key = null;
    this.run = [];
    this.lastReported = null;
    this.absent = 0;
  }

  /** Feed every processed frame. Returns a SlipScan when a reading has become stable. */
  push(r: FrameResult): SlipScan | null {
    const primary = r.status === 'ok' ? r.scan?.primary : null;
    if (r.status === 'none') {
      if (++this.absent >= this.forgetAfter) this.lastReported = null;
    } else this.absent = 0;
    if (!primary || !r.scan) {
      this.key = null;
      this.run = [];
      return null;
    }
    if (primary.morse !== this.key) {
      this.key = primary.morse;
      this.run = [];
    }
    this.run.push(r);
    if (this.run.length < this.need || this.key === this.lastReported) return null;
    const window = this.run.slice(-this.need);
    const conf = window.reduce((s, x) => s + (x.scan?.primary?.confidence ?? 0), 0) / window.length;
    this.lastReported = this.key;
    const scan = r.scan;
    return { primary: { ...primary, confidence: Math.round(conf * 100) / 100 }, others: scan.others, at: scan.at };
  }
}
