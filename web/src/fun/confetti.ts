/*
  confetti, now spell-sparks: gold four-point stars that burst and fall, bright glints that wink out,
  and candle embers that drift up and fade. One shared canvas that exists only while pieces are alive.
  prefers-reduced-motion: fewer pieces that drift gently (reduced, not removed).
*/
import { haptics } from './haptics';
import { sfx } from './sfx';

export interface ConfettiOptions {
  /** Origin, 0..1 of the viewport. Default: centre, a bit above the middle. */
  x?: number;
  y?: number;
  count?: number;
  /** Spread in degrees around straight up. */
  spread?: number;
  power?: number;
  /** CSS colour values; defaults to the palette. */
  colors?: string[];
}

type Kind = 'star' | 'glint' | 'ember';
interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  flip: number;
  vf: number;
  size: number;
  color: string;
  kind: Kind;
  /** frames lived, and how many it gets */
  age: number;
  life: number;
}

let canvas: HTMLCanvasElement | null = null;
let pieces: Piece[] = [];
let raf = 0;

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function palette(): { colors: string[] } {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, fb: string) => cs.getPropertyValue(n).trim() || fb;
  return { colors: [v('--gold', '#e3c48a'), v('--gold-bright', '#f5dfac'), v('--cream', '#f3e8cc')] };
}
const EMBERS = ['#ffb55c', '#ff8a3d', '#ffd27a'];

function ensureCanvas() {
  if (canvas) return canvas;
  canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, {
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100dvh',
    pointerEvents: 'none',
    zIndex: '90',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(canvas);
  resize();
  window.addEventListener('resize', resize);
  return canvas;
}

function resize() {
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawStar(c: CanvasRenderingContext2D, r: number) {
  c.beginPath();
  // the tickets' four-point star
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4 - Math.PI / 2;
    const rr = i % 2 ? r * 0.28 : r * 1.25;
    c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  c.closePath();
}

function frame() {
  if (!canvas) return;
  const c = canvas.getContext('2d');
  if (!c) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const slow = reduced();
  c.clearRect(0, 0, w, h);
  c.globalCompositeOperation = 'lighter';
  for (const p of pieces) {
    p.age++;
    if (p.kind === 'ember' && !slow) {
      // embers: a short burst, then they rise and sway like sparks off a candle
      p.vy = p.vy * 0.94 - 0.035;
      p.vx = p.vx * 0.94 + Math.sin((p.age + p.flip * 40) / 14) * 0.05;
    } else {
      p.vy += slow ? 0.05 : 0.26;
      p.vx *= 0.985;
      p.vy *= 0.985;
    }
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.vr;
    p.flip += p.vf;
    const t = p.age / p.life;
    const fade = t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.3);
    const s = p.size;
    c.save();
    c.translate(p.x, p.y);
    c.globalAlpha = fade;
    if (p.kind === 'star') {
      c.rotate(p.rot);
      c.scale(1, 0.6 + 0.4 * Math.abs(Math.cos(p.flip)));
      // a soft halo, then the star
      c.globalAlpha = fade * 0.22;
      c.fillStyle = p.color;
      drawStar(c, s * 1.9);
      c.fill();
      c.globalAlpha = fade;
      drawStar(c, s);
      c.fill();
    } else if (p.kind === 'glint') {
      const twinkle = 0.5 + 0.5 * Math.sin(p.flip * 3);
      c.globalAlpha = fade * twinkle;
      c.fillStyle = p.color;
      c.beginPath();
      c.arc(0, 0, s * 0.35, 0, Math.PI * 2);
      c.fill();
      c.fillRect(-s * 1.1, -0.5, s * 2.2, 1);
      c.fillRect(-0.5, -s * 1.1, 1, s * 2.2);
    } else {
      const flicker = 0.75 + 0.25 * Math.sin(p.flip * 5);
      c.globalAlpha = fade * flicker * 0.3;
      c.fillStyle = p.color;
      c.beginPath();
      c.arc(0, 0, s * 0.9, 0, Math.PI * 2);
      c.fill();
      c.globalAlpha = fade * flicker;
      c.beginPath();
      c.arc(0, 0, s * 0.32, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }
  pieces = pieces.filter((p) => p.age < p.life && p.y < h + 60 && p.y > -200 && p.x > -80 && p.x < w + 80);
  if (pieces.length) raf = requestAnimationFrame(frame);
  else stop();
}

function stop() {
  cancelAnimationFrame(raf);
  raf = 0;
  if (canvas) {
    window.removeEventListener('resize', resize);
    canvas.remove();
    canvas = null;
  }
}

/** Throw confetti. Safe to call often; pieces are capped. */
export function confetti(opts: ConfettiOptions = {}): void {
  if (typeof document === 'undefined') return;
  ensureCanvas();
  const slow = reduced();
  const { colors: pal } = palette();
  const colors = opts.colors ?? pal;
  const count = Math.round((opts.count ?? 90) * (slow ? 0.3 : 1));
  const ox = (opts.x ?? 0.5) * window.innerWidth;
  const oy = (opts.y ?? 0.45) * window.innerHeight;
  const spread = ((opts.spread ?? 110) * Math.PI) / 180;
  const power = opts.power ?? 1;
  const kinds: Kind[] = ['star', 'star', 'star', 'glint', 'glint', 'ember', 'ember'];
  for (let i = 0; i < count; i++) {
    const kind = kinds[Math.floor(Math.random() * kinds.length)] ?? 'star';
    const a = -Math.PI / 2 + (Math.random() - 0.5) * spread;
    const v = slow ? 1 + Math.random() * 2 : (7 + Math.random() * 9) * power;
    pieces.push({
      x: slow ? Math.random() * window.innerWidth : ox,
      y: slow ? -20 - Math.random() * 100 : oy,
      vx: slow ? (Math.random() - 0.5) * 0.6 : Math.cos(a) * v,
      vy: slow ? v : Math.sin(a) * v,
      rot: Math.random() * Math.PI * 2,
      vr: slow ? 0.01 : (Math.random() - 0.5) * 0.3,
      flip: Math.random() * Math.PI,
      vf: slow ? 0.02 : 0.08 + Math.random() * 0.18,
      size: 5 + Math.random() * 6,
      color: kind === 'ember' && !opts.colors ? (EMBERS[i % EMBERS.length] ?? '#ffb55c') : (colors[i % colors.length] ?? '#e3c48a'),
      kind,
      age: 0,
      life: (kind === 'ember' ? 110 : kind === 'glint' ? 70 : 150) * (slow ? 2.2 : 1) + Math.random() * 40,
    });
  }
  if (pieces.length > 600) pieces.splice(0, pieces.length - 600);
  if (!raf) raf = requestAnimationFrame(frame);
}

/** The full win moment: spell-sparks and embers from both sides + fanfare + celebratory buzz. */
export function celebrate(opts: { x?: number; y?: number; sound?: boolean } = {}): void {
  confetti({ x: opts.x ?? 0.2, y: opts.y ?? 0.75, spread: 70, count: 70, power: 1.15 });
  confetti({ x: opts.x !== undefined ? opts.x : 0.8, y: opts.y ?? 0.75, spread: 70, count: 70, power: 1.15 });
  if (opts.sound !== false) sfx.fanfare();
  haptics.celebrate();
}
