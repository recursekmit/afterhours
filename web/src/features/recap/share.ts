/*
  The shareable story image: 1080x1920, drawn on a canvas in the browser (no server rendering,
  no libraries). It is the recap's best card (your personality) with your avatar, its doodle,
  three big numbers, your top moment, the Recurse logo and the event line.
  Colours and fonts come from the live design tokens, so it always matches the app.
*/
import { PERSONALITIES, type Recap } from '@afterhours/shared/features/recap';
import logoBlack from '../../assets/brand/recurse-logo-black.png';

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

/** Uneven "hand cut" rounded rectangle, like the cards. */
function cutRect(c: Ctx, x: number, y: number, w: number, h: number, r: [number, number, number, number]) {
  const [a, b, d, e] = r;
  c.beginPath();
  c.moveTo(x + a, y);
  c.lineTo(x + w - b, y);
  c.quadraticCurveTo(x + w, y, x + w, y + b);
  c.lineTo(x + w, y + h - d);
  c.quadraticCurveTo(x + w, y + h, x + w - d, y + h);
  c.lineTo(x + e, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - e);
  c.lineTo(x, y + a);
  c.quadraticCurveTo(x, y, x + a, y);
  c.closePath();
}

/** Ink outline + hard offset shadow, the zine card look. */
function block(c: Ctx, tk: Tokens, x: number, y: number, w: number, h: number, fill: string, opts: { rot?: number; shadow?: number; line?: number; r?: [number, number, number, number] } = {}) {
  const { rot = 0, shadow = 18, line = 8, r = [34, 48, 30, 42] } = opts;
  c.save();
  c.translate(x + w / 2, y + h / 2);
  c.rotate((rot * Math.PI) / 180);
  c.translate(-w / 2, -h / 2);
  if (shadow) {
    cutRect(c, shadow, shadow * 1.2, w, h, r);
    c.fillStyle = tk.ink;
    c.fill();
  }
  cutRect(c, 0, 0, w, h, r);
  c.fillStyle = fill;
  c.fill();
  c.lineWidth = line;
  c.strokeStyle = tk.ink;
  c.stroke();
  c.restore();
}

function halftone(c: Ctx, tk: Tokens, x: number, y: number, w: number, h: number, alpha = 0.16) {
  c.save();
  c.globalAlpha = alpha;
  c.fillStyle = tk.ink;
  for (let yy = y; yy < y + h; yy += 22) for (let xx = x + ((yy / 22) % 2) * 11; xx < x + w; xx += 22) {
    c.beginPath();
    c.arc(xx, yy, 3, 0, Math.PI * 2);
    c.fill();
  }
  c.restore();
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

function starburst(c: Ctx, tk: Tokens, cx: number, cy: number, r: number, fill: string) {
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.42 : r;
    c.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  c.closePath();
  c.fillStyle = fill;
  c.fill();
  c.lineWidth = 6;
  c.strokeStyle = tk.ink;
  c.stroke();
}

async function fontsReady(tk: Tokens) {
  try {
    await Promise.all([
      document.fonts.load(`120px ${tk.display}`),
      document.fonts.load(`700 48px ${tk.hand}`),
      document.fonts.load(`800 40px ${tk.body}`),
    ]);
  } catch {
    /* system fallbacks still draw */
  }
}

export interface ShareArt {
  avatar: SVGSVGElement | null;
  doodle: SVGSVGElement | null;
}

/** Draw the story image onto `canvas` (sized to 1080x1920). */
export async function renderShareImage(canvas: HTMLCanvasElement, recap: Recap, art: ShareArt): Promise<void> {
  const tk = tokens();
  await fontsReady(tk);
  const [avatar, doodle, logo] = await Promise.all([
    art.avatar ? svgToImage(art.avatar, 520, tk).catch(() => null) : null,
    art.doodle ? svgToImage(art.doodle, 520, tk).catch(() => null) : null,
    loadImage(logoBlack).catch(() => null),
  ]);
  canvas.width = SHARE_W;
  canvas.height = SHARE_H;
  const c = canvas.getContext('2d');
  if (!c) return;
  const p = PERSONALITIES[recap.personality.id];
  const tone = tk.get(p.color, tk.paper2);
  const onTone = p.color === 'grape' ? tk.paper3 : tk.ink;

  // paper
  c.fillStyle = tk.paper;
  c.fillRect(0, 0, SHARE_W, SHARE_H);
  halftone(c, tk, 0, 0, SHARE_W, SHARE_H, 0.05);

  // the big colour block
  block(c, tk, 60, 150, 950, 1090, tone, { rot: -1.6, shadow: 22, line: 9 });
  c.save();
  c.translate(SHARE_W / 2, 695);
  c.rotate((-1.6 * Math.PI) / 180);
  c.beginPath();
  c.rect(-440, -500, 880, 1000);
  c.clip();
  halftone(c, tk, -440, -500, 560, 420, 0.18);
  c.restore();

  // logo on a paper label with tape
  if (logo) {
    const lh = 92;
    const lw = Math.round((lh * logo.width) / logo.height);
    block(c, tk, 96, 60, lw + 56, lh + 40, tk.paper3, { rot: -3, shadow: 8, line: 6, r: [18, 24, 16, 20] });
    c.save();
    c.translate(96 + (lw + 56) / 2, 60 + (lh + 40) / 2);
    c.rotate((-3 * Math.PI) / 180);
    c.drawImage(logo, -lw / 2, -lh / 2, lw, lh);
    c.restore();
    c.save();
    c.translate(96 + (lw + 56) / 2, 58);
    c.rotate((4 * Math.PI) / 180);
    c.globalAlpha = 0.85;
    c.fillStyle = tk.get('sun', tk.paper2);
    c.fillRect(-80, -20, 160, 40);
    c.restore();
  }

  // "my after hours personality"
  c.fillStyle = onTone;
  c.font = `800 56px ${tk.hand}`;
  c.save();
  c.translate(130, 330);
  c.rotate((-2 * Math.PI) / 180);
  c.fillText('my after hours personality:', 0, 0);
  c.restore();

  // the title, chunky with an offset shadow
  const title = fitText(c, p.title, tk.display, 168, 820, 2);
  c.save();
  c.translate(130, 330 + title.size * 1.05);
  c.rotate((-2.4 * Math.PI) / 180);
  title.lines.forEach((l, i) => {
    const y = i * title.size * 0.98;
    c.fillStyle = p.color === 'grape' ? tk.ink : tk.paper3;
    c.fillText(l, 9, y + 10);
    c.fillStyle = onTone;
    c.fillText(l, 0, y);
  });
  c.restore();
  const afterTitle = 330 + title.size * 1.05 + (title.lines.length - 1) * title.size * 0.98;

  // the line, in an ink scrap
  c.font = `700 46px ${tk.hand}`;
  const lines = wrap(c, p.line, 760);
  const boxH = lines.length * 60 + 56;
  block(c, tk, 120, afterTitle + 60, 840, boxH, tk.ink, { rot: 1.2, shadow: 0, line: 6, r: [20, 30, 18, 26] });
  c.save();
  c.translate(160, afterTitle + 60 + 72);
  c.rotate((1.2 * Math.PI) / 180);
  c.fillStyle = tk.paper;
  lines.forEach((l, i) => c.fillText(l, 0, i * 60));
  c.restore();

  // avatar sticker + doodle, overlapping the bottom of the block
  const artY = 1180 - 420;
  c.save();
  c.translate(330, artY + 230);
  c.rotate((-6 * Math.PI) / 180);
  c.beginPath();
  c.arc(14, 18, 230, 0, Math.PI * 2);
  c.fillStyle = tk.ink;
  c.fill();
  c.beginPath();
  c.arc(0, 0, 230, 0, Math.PI * 2);
  c.fillStyle = tk.paper3;
  c.fill();
  c.lineWidth = 9;
  c.strokeStyle = tk.ink;
  c.stroke();
  if (avatar) c.drawImage(avatar, -190, -190, 380, 380);
  c.restore();
  if (doodle) {
    c.save();
    c.translate(790, artY + 250);
    c.rotate((8 * Math.PI) / 180);
    c.drawImage(doodle, -200, -200, 400, 400);
    c.restore();
  }
  starburst(c, tk, 560, artY + 40, 54, tk.get('sun', tk.paper2));

  // nickname tag
  c.font = `800 64px ${tk.body}`;
  const nick = `@${recap.attendee.nickname}`.slice(0, 22);
  const nw = Math.min(900, c.measureText(nick).width + 70);
  block(c, tk, 150, 1225, nw, 104, tk.paper3, { rot: -2, shadow: 10, line: 7, r: [16, 22, 14, 20] });
  c.save();
  c.translate(150 + nw / 2, 1225 + 52);
  c.rotate((-2 * Math.PI) / 180);
  c.fillStyle = tk.ink;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(nick, 0, 4);
  c.restore();

  // three big numbers
  const stats: { big: string; small: string; color: string; rot: number }[] = [
    { big: recap.standing.rank ? `#${recap.standing.rank}` : '-', small: 'final rank', color: tk.get('sun', tk.paper2), rot: -3 },
    { big: recap.standing.total.toLocaleString('en-IN'), small: 'points', color: tk.get('lime', tk.paper2), rot: 2 },
    { big: `${recap.stickers.count}`, small: 'stickers', color: tk.get('pink', tk.paper2), rot: -1.5 },
  ];
  stats.forEach((st, i) => {
    const x = 70 + i * 322;
    const y = 1400;
    block(c, tk, x, y, 292, 250, st.color, { rot: st.rot, shadow: 12, line: 7, r: [22, 30, 18, 26] });
    c.save();
    c.translate(x + 146, y + 125);
    c.rotate((st.rot * Math.PI) / 180);
    c.fillStyle = tk.ink;
    c.textAlign = 'center';
    const big = fitText(c, st.big, tk.display, 110, 250, 1);
    c.font = `${big.size}px ${tk.display}`;
    c.fillText(st.big, 0, 20);
    c.font = `800 40px ${tk.hand}`;
    c.fillText(st.small, 0, 84);
    c.restore();
  });

  // top moment
  if (recap.topMoment) {
    c.fillStyle = tk.ink;
    c.font = `800 44px ${tk.hand}`;
    const tm = `biggest moment: +${recap.topMoment.points} ${recap.topMoment.label}`;
    const fit = fitText(c, tm, tk.hand, 44, 920, 1, '800');
    c.font = `800 ${fit.size}px ${tk.hand}`;
    c.textAlign = 'left';
    c.fillText(fit.lines[0] ?? tm, 80, 1735);
  }

  // footer strip
  c.fillStyle = tk.ink;
  c.fillRect(0, SHARE_H - 120, SHARE_W, 120);
  c.fillStyle = tk.paper;
  c.font = `800 48px ${tk.hand}`;
  c.textAlign = 'center';
  c.fillText(EVENT_LINE, SHARE_W / 2, SHARE_H - 46);
  c.textAlign = 'left';
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
