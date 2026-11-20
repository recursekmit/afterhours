/*
  The shareable story image: 1080x1920, drawn on a canvas in the browser (no server rendering,
  no libraries). It is the recap's best card (your personality) with your avatar, its doodle,
  three big numbers, your top moment, the Recurse logo and the event line.
  Colours and fonts come from the live design tokens, so it always matches the app.
*/
import { PERSONALITIES, type Recap } from '@afterhours/shared/features/recap';
import logoWhite from '../../assets/brand/recurse-logo-white.png';

export const SHARE_W = 1080;
export const SHARE_H = 1920;
export const EVENT_LINE = 'after hours, recurse kmit, 21 nov 2026';

type Ctx = CanvasRenderingContext2D;

function tokens() {
  const css = getComputedStyle(document.documentElement);
  const t = (name: string, fallback: string) => css.getPropertyValue(`--${name}`).trim() || fallback;
  return {
    get: t,
    paper: t('paper', 'black'),
    paper2: t('paper-2', 'black'),
    paper3: t('paper-3', 'black'),
    ink: t('ink', 'black'),
    display: t('font-display', 'Impact, sans-serif'),
    body: t('font-body', 'sans-serif'),
    hand: t('font-hand', 'cursive'),
  };
}
type Tokens = ReturnType<typeof tokens>;

/** Swap var(--x) for the token's value so a standalone SVG image renders the same colours. */
function resolveVars(svg: string, tk: Tokens): string {
  return svg.replace(/var\(--([a-z0-9-]+)\)/g, (_, name: string) => tk.get(name, 'black'));
}

export function svgToImage(el: SVGSVGElement, px: number, tk = tokens()): Promise<HTMLImageElement> {
  const clone = el.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(px));
  clone.setAttribute('height', String(px));
  clone.removeAttribute('class');
  // filters point at defs elsewhere in the page; a standalone image cannot see them
  clone.querySelectorAll('[filter]').forEach((n) => n.removeAttribute('filter'));
  const src = resolveVars(new XMLSerializer().serializeToString(clone), tk);
  return loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(src)}`);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed to load'));
    img.src = src;
  });
}

function wrap(c: Ctx, text: string, maxW: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (c.measureText(next).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Shrink the font until the text fits maxW on at most maxLines lines. */
function fitText(c: Ctx, text: string, family: string, start: number, maxW: number, maxLines: number, weight = ''): { size: number; lines: string[] } {
  for (let size = start; size > 24; size -= 6) {
    c.font = `${weight} ${size}px ${family}`.trim();
    const lines = wrap(c, text, maxW);
    if (lines.length <= maxLines && lines.every((l) => c.measureText(l).width <= maxW)) return { size, lines };
  }
  c.font = `${weight} 24px ${family}`.trim();
  return { size: 24, lines: wrap(c, text, maxW) };
}

async function fontsReady(tk: Tokens) {
  try {
    await Promise.all([
      document.fonts.load(`120px ${tk.display}`),
      document.fonts.load(`900 120px ${tk.display}`),
      document.fonts.load(`italic 48px ${tk.hand}`),
      document.fonts.load(`italic 600 40px ${tk.body}`),
    ]);
  } catch {
    /* system fallbacks still draw */
  }
}

export interface ShareArt {
  avatar: SVGSVGElement | null;
  doodle: SVGSVGElement | null;
}

/** Draw the story image onto `canvas` (sized to 1080x1920): an engraved ticket on the ruins plum. */
export async function renderShareImage(canvas: HTMLCanvasElement, recap: Recap, art: ShareArt): Promise<void> {
  const tk = tokens();
  await fontsReady(tk);
  const [avatar, doodle, logo] = await Promise.all([
    art.avatar ? svgToImage(art.avatar, 520, tk).catch(() => null) : null,
    art.doodle ? svgToImage(art.doodle, 520, tk).catch(() => null) : null,
    loadImage(logoWhite).catch(() => null),
  ]);
  canvas.width = SHARE_W;
  canvas.height = SHARE_H;
  const c = canvas.getContext('2d');
  if (!c) return;
  const p = PERSONALITIES[recap.personality.id];
  const col = {
    ground: tk.get('ticket-ruins', '#27132d'),
    deep: tk.get('dusk', '#170c1c'),
    night: tk.get('night', '#0a0d18'),
    gold: tk.get('gold', '#e3c48a'),
    bright: tk.get('gold-bright', '#f5dfac'),
    cream: tk.get('cream', '#f3e8cc'),
    parchment: tk.get('parchment', '#f1e5c6'),
    iron: tk.get('iron-gall', '#2a1c10'),
    wax: tk.get('wax', '#8e1f24'),
    waxDark: tk.get('wax-dark', '#5a0f14'),
  };

  // the ground, lit by a candle near the top
  c.fillStyle = col.deep;
  c.fillRect(0, 0, SHARE_W, SHARE_H);
  const glow = c.createRadialGradient(SHARE_W / 2, 560, 40, SHARE_W / 2, 560, 1100);
  glow.addColorStop(0, col.ground);
  glow.addColorStop(1, col.deep);
  c.fillStyle = glow;
  c.fillRect(0, 0, SHARE_W, SHARE_H);
  stardust(c, col.gold);

  // the ticket's double rule with notched corners and four-point stars
  frame(c, 44, 44, SHARE_W - 88, SHARE_H - 88, col.gold);

  // Recurse, top centre
  if (logo) {
    const lh = 78;
    const lw = Math.round((lh * logo.width) / logo.height);
    c.drawImage(logo, (SHARE_W - lw) / 2, 110, lw, lh);
  }

  c.textAlign = 'center';
  c.fillStyle = col.cream;
  c.font = `italic 52px ${tk.hand}`;
  c.fillText('my after hours personality', SHARE_W / 2, 280);

  // the title, struck in gold capitals
  const title = fitText(c, p.title.toUpperCase(), tk.display, 128, 880, 2, '900');
  c.font = `900 ${title.size}px ${tk.display}`;
  c.fillStyle = col.gold;
  c.shadowColor = 'rgb(255 196 110 / 0.35)';
  c.shadowBlur = 30;
  title.lines.forEach((l, i) => c.fillText(l, SHARE_W / 2, 280 + title.size * 1.1 + i * title.size * 1.02));
  c.shadowBlur = 0;
  const afterTitle = 280 + title.size * 1.1 + (title.lines.length - 1) * title.size * 1.02;
  starRule(c, SHARE_W / 2, afterTitle + 50, 360, col.gold);

  // the line, on a parchment cartouche
  c.font = `italic 600 44px ${tk.body}`;
  const lines = wrap(c, p.line, 740);
  const boxH = lines.length * 58 + 64;
  const boxY = afterTitle + 100;
  plaque(c, 140, boxY, 800, boxH, 22, col.parchment, col.gold);
  c.fillStyle = col.iron;
  lines.forEach((l, i) => c.fillText(l, SHARE_W / 2, boxY + 70 + i * 58));

  // avatar in a gold medallion, the personality's doodle beside it
  const artY = Math.max(boxY + boxH + 230, 1000);
  c.save();
  c.translate(SHARE_W / 2 - 120, artY);
  c.beginPath();
  c.arc(0, 0, 210, 0, Math.PI * 2);
  c.fillStyle = col.night;
  c.fill();
  c.lineWidth = 8;
  c.strokeStyle = col.gold;
  c.stroke();
  c.beginPath();
  c.arc(0, 0, 192, 0, Math.PI * 2);
  c.lineWidth = 2;
  c.globalAlpha = 0.6;
  c.stroke();
  c.globalAlpha = 1;
  if (avatar) c.drawImage(avatar, -160, -160, 320, 320);
  c.restore();
  if (doodle) c.drawImage(doodle, SHARE_W / 2 + 110, artY - 170, 300, 300);
  star(c, SHARE_W / 2 + 120, artY - 210, 34, col.bright);

  // nickname under the medallion
  c.font = `700 60px ${tk.display}`;
  c.fillStyle = col.cream;
  const nick = `@${recap.attendee.nickname}`.slice(0, 22);
  c.fillText(nick, SHARE_W / 2, artY + 300);

  // three numbers on night plaques
  const stats: { big: string; small: string }[] = [
    { big: recap.standing.rank ? `#${recap.standing.rank}` : '-', small: 'final rank' },
    { big: recap.standing.total.toLocaleString('en-IN'), small: 'points' },
    { big: `${recap.stickers.count}`, small: 'stickers' },
  ];
  const sy = Math.min(artY + 370, 1460);
  stats.forEach((st, i) => {
    const x = 92 + i * 310;
    plaque(c, x, sy, 276, 230, 18, col.night, col.gold);
    c.fillStyle = col.gold;
    const big = fitText(c, st.big, tk.display, 100, 230, 1, '900');
    c.font = `900 ${big.size}px ${tk.display}`;
    c.fillText(st.big, x + 138, sy + 130);
    c.fillStyle = col.cream;
    c.font = `italic 40px ${tk.hand}`;
    c.fillText(st.small, x + 138, sy + 190);
  });

  // top moment
  if (recap.topMoment) {
    c.fillStyle = col.cream;
    const tm = `biggest moment: +${recap.topMoment.points} ${recap.topMoment.label}`;
    const fit = fitText(c, tm, tk.hand, 44, 880, 1);
    c.font = `italic ${fit.size}px ${tk.hand}`;
    c.fillText(fit.lines[0] ?? tm, SHARE_W / 2, sy + 310);
  }

  // the event line, sealed
  c.fillStyle = col.gold;
  c.font = `700 40px ${tk.display}`;
  c.fillText(EVENT_LINE.toUpperCase(), SHARE_W / 2, SHARE_H - 110);
  starRule(c, SHARE_W / 2, SHARE_H - 160, 300, col.gold);
  c.textAlign = 'left';
}

function star(c: Ctx, cx: number, cy: number, r: number, fill: string) {
  c.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4 - Math.PI / 2;
    const rr = i % 2 ? r * 0.22 : r;
    c.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  c.closePath();
  c.fillStyle = fill;
  c.fill();
}

function notched(c: Ctx, x: number, y: number, w: number, h: number, n: number) {
  c.beginPath();
  c.moveTo(x + n, y);
  c.lineTo(x + w - n, y);
  c.lineTo(x + w, y + n);
  c.lineTo(x + w, y + h - n);
  c.lineTo(x + w - n, y + h);
  c.lineTo(x + n, y + h);
  c.lineTo(x, y + h - n);
  c.lineTo(x, y + n);
  c.closePath();
}

/** The tickets' border: a gold rule, a gap, a hairline, stars in the corners. */
function frame(c: Ctx, x: number, y: number, w: number, h: number, gold: string) {
  c.strokeStyle = gold;
  c.lineWidth = 5;
  notched(c, x, y, w, h, 34);
  c.stroke();
  c.globalAlpha = 0.55;
  c.lineWidth = 2;
  notched(c, x + 16, y + 16, w - 32, h - 32, 26);
  c.stroke();
  c.globalAlpha = 1;
  for (const [sx, sy] of [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
  ] as const)
    star(c, sx, sy, 34, gold);
}

/** The notched cartouche: a filled plaque with a gold double rule. */
function plaque(c: Ctx, x: number, y: number, w: number, h: number, n: number, fill: string, gold: string) {
  notched(c, x, y, w, h, n);
  c.fillStyle = fill;
  c.fill();
  c.strokeStyle = gold;
  c.lineWidth = 4;
  c.stroke();
  c.globalAlpha = 0.6;
  c.lineWidth = 1.5;
  notched(c, x + 9, y + 9, w - 18, h - 18, n - 5);
  c.stroke();
  c.globalAlpha = 1;
}

function starRule(c: Ctx, cx: number, cy: number, half: number, gold: string) {
  c.strokeStyle = gold;
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(cx - half, cy);
  c.lineTo(cx - 34, cy);
  c.moveTo(cx + 34, cy);
  c.lineTo(cx + half, cy);
  c.stroke();
  star(c, cx, cy, 22, gold);
}

/** A scatter of faint gold stars over the ground (seeded, so every image is the same). */
function stardust(c: Ctx, gold: string) {
  c.save();
  let s = 7;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 70; i++) {
    c.globalAlpha = 0.12 + rnd() * 0.25;
    star(c, rnd() * SHARE_W, rnd() * SHARE_H, 3 + rnd() * 7, gold);
  }
  c.restore();
}

export function canvasToFile(canvas: HTMLCanvasElement, name = 'after-hours-recap.png'): Promise<File | null> {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b ? new File([b], name, { type: 'image/png' }) : null), 'image/png');
  });
}

export function canShareFiles(file: File | null): boolean {
  try {
    return Boolean(file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] }));
  } catch {
    return false;
  }
}

/** Web Share with the image where the phone supports it, a download everywhere else. */
export async function shareOrDownload(file: File): Promise<'shared' | 'downloaded' | 'cancelled'> {
  if (canShareFiles(file)) {
    try {
      await navigator.share({ files: [file], title: 'my after hours', text: `${EVENT_LINE}. what was yours?` });
      return 'shared';
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
      // fall through to a download (some browsers refuse files late)
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}
