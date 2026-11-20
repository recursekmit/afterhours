/*
  confetti: gold four-point stars, sparks and flakes of gold leaf, on one
  shared canvas that exists only while pieces are flying.
  prefers-reduced-motion: fewer pieces that drift down gently (reduced, not removed).
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

type Kind = 'scrap' | 'squiggle' | 'star' | 'dot';
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
}

let canvas: HTMLCanvasElement | null = null;
let pieces: Piece[] = [];
let raf = 0;

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function palette(): { colors: string[]; ink: string } {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, fb: string) => cs.getPropertyValue(n).trim() || fb;
  return {
    colors: [v('--gold', '#e3c48a'), v('--gold-bright', '#f5dfac'), v('--cream', '#f3e8cc'), v('--ink-soft', '#c9b48a')],
    ink: v('--paper-2', '#0b1124'),
  };
}

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
  const { ink } = palette();
  const w = window.innerWidth;
  const h = window.innerHeight;
  const slow = reduced();
  c.clearRect(0, 0, w, h);
  c.lineJoin = 'round';
  c.lineCap = 'round';
  for (const p of pieces) {
    p.vy += slow ? 0.05 : 0.32;
    p.vx *= 0.985;
    p.vy *= 0.985;
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.vr;
    p.flip += p.vf;
    c.save();
    c.translate(p.x, p.y);
    c.rotate(p.rot);
    c.scale(1, Math.cos(p.flip));
    c.fillStyle = p.color;
    c.strokeStyle = ink;
    c.lineWidth = 1.6;
    const s = p.size;
    if (p.kind === 'scrap') {
      c.beginPath();
      c.moveTo(-s, -s * 0.55);
      c.lineTo(s * 0.9, -s * 0.6);
      c.lineTo(s, s * 0.5);
      c.lineTo(-s * 0.85, s * 0.6);
      c.closePath();
      c.fill();
      c.stroke();
    } else if (p.kind === 'star') {
      drawStar(c, s);
      c.fill();
      c.stroke();
    } else if (p.kind === 'dot') {
      c.beginPath();
      c.arc(0, 0, s * 0.6, 0, Math.PI * 2);
      c.fill();
      c.stroke();
    } else {
      c.strokeStyle = p.color;
      c.lineWidth = 3.2;
      c.beginPath();
      c.moveTo(-s * 1.4, 0);
      c.bezierCurveTo(-s * 0.7, -s, -s * 0.2, s, s * 0.3, 0);
      c.bezierCurveTo(s * 0.7, -s * 0.8, s * 1.1, s * 0.6, s * 1.5, 0);
      c.stroke();
    }
    c.restore();
  }
  pieces = pieces.filter((p) => p.y < h + 60 && p.x > -80 && p.x < w + 80);
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
  const kinds: Kind[] = ['star', 'star', 'star', 'dot', 'dot', 'scrap'];
  for (let i = 0; i < count; i++) {
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
      color: colors[i % colors.length] ?? '#ff6a1f',
      kind: kinds[Math.floor(Math.random() * kinds.length)] ?? 'scrap',
    });
  }
  if (pieces.length > 600) pieces.splice(0, pieces.length - 600);
  if (!raf) raf = requestAnimationFrame(frame);
}

/** The full win moment: confetti from both sides + fanfare + celebratory buzz. */
export function celebrate(opts: { x?: number; y?: number; sound?: boolean } = {}): void {
  confetti({ x: opts.x ?? 0.2, y: opts.y ?? 0.75, spread: 70, count: 70, power: 1.15 });
  confetti({ x: opts.x !== undefined ? opts.x : 0.8, y: opts.y ?? 0.75, spread: 70, count: 70, power: 1.15 });
  if (opts.sound !== false) sfx.fanfare();
  haptics.celebrate();
}
