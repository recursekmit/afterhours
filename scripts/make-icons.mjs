// Generates the PWA icons and iOS launch images in the engraved-ticket style: the Recurse icon on the
// wave-navy ground inside the tickets' gold double rule with four-point stars, using the Chromium that
// Playwright installs (canvas, no extra dependency).
//   node scripts/make-icons.mjs
/* global Image, document, FontFace */
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'web/src/assets/brand/recurse-icon.png')).toString('base64');
const logo = readFileSync(join(root, 'web/src/assets/brand/recurse-logo-white.png')).toString('base64');
const font = readFileSync(join(root, 'web/src/assets/fonts/cinzel-900.woff2')).toString('base64');
const out = join(root, 'web/public/icons');
mkdirSync(out, { recursive: true });

// tokens.css: --ticket-wave / --paper (wave), --gold, --gold-bright
const GROUND = '#121a33';
const GOLD = '#e3c48a';

const browser = await chromium.launch();
const page = await browser.newPage();

// shared drawing helpers, installed in the page once
await page.evaluate(
  ({ GROUND, GOLD }) => {
    const w = /** @type {any} */ (window);
    w.ground = (g, x, y, W, H, r) => {
      // flat ground: gradients bloat the PNGs (the 512 icons are precached)
      g.fillStyle = GROUND;
      g.beginPath();
      if (r) g.roundRect(x, y, W, H, r);
      else g.rect(x, y, W, H);
      g.fill();
    };
    w.star = (g, cx, cy, r) => {
      g.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4 - Math.PI / 2;
        const rr = i % 2 ? r * 0.22 : r;
        g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      }
      g.closePath();
      g.fillStyle = GOLD;
      g.fill();
    };
    // the double rule: a gold line, a gap, a hairline; notched corners; a star in each corner
    w.frame = (g, x, y, W, H, k) => {
      const n = k * 2.2;
      const path = (o) => {
        g.beginPath();
        g.moveTo(x + o + n, y + o);
        g.lineTo(x + W - o - n, y + o);
        g.lineTo(x + W - o, y + o + n);
        g.lineTo(x + W - o, y + H - o - n);
        g.lineTo(x + W - o - n, y + H - o);
        g.lineTo(x + o + n, y + H - o);
        g.lineTo(x + o, y + H - o - n);
        g.lineTo(x + o, y + o + n);
        g.closePath();
      };
      g.strokeStyle = GOLD;
      g.lineWidth = Math.max(1, k * 0.55);
      path(0);
      g.stroke();
      g.globalAlpha = 0.55;
      g.lineWidth = Math.max(0.6, k * 0.22);
      path(k * 1.3);
      g.stroke();
      g.globalAlpha = 1;
      for (const [sx, sy] of [
        [x, y],
        [x + W, y],
        [x, y + H],
        [x + W, y + H],
      ])
        w.star(g, sx, sy, k * 2.2);
    };
  },
  { GROUND, GOLD },
);

const specs = [
  { file: 'icon-192.png', size: 192, pad: 0.2, round: true },
  { file: 'icon-512.png', size: 512, pad: 0.2, round: true },
  // maskable: art inside the central 60% safe zone, full-bleed ground
  { file: 'icon-maskable-512.png', size: 512, pad: 0.27, full: true },
  { file: 'icon-maskable-192.png', size: 192, pad: 0.27, full: true },
  { file: 'apple-touch-icon.png', size: 180, pad: 0.2, full: true },
  { file: 'favicon-32.png', size: 32, pad: 0.04, tiny: true },
];
for (const sp of specs) {
  const dataUrl = await page.evaluate(
    async ({ src, sp }) => {
      const w = /** @type {any} */ (window);
      const img = new Image();
      img.src = `data:image/png;base64,${src}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = sp.size;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      const S = sp.size;
      if (!sp.tiny) {
        if (sp.full) w.ground(g, 0, 0, S, S, 0);
        else w.ground(g, S * 0.02, S * 0.02, S * 0.96, S * 0.96, S * 0.18);
        const inset = sp.full ? S * 0.14 : S * 0.1;
        w.frame(g, inset, inset, S - inset * 2, S - inset * 2, S * 0.012);
      }
      const art = S * (1 - sp.pad * 2);
      const o = (S - art) / 2;
      g.drawImage(img, o, o, art, art);
      return c.toDataURL('image/png');
    },
    { src, sp },
  );
  writeFileSync(join(out, sp.file), Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('wrote', sp.file);
}

// Monochrome notification badge (Android draws it as a white silhouette): keep the
// robot's light pixels as opaque white, everything else transparent.
for (const [file, size] of [
  ['badge-96.png', 96],
  ['icon-monochrome-192.png', 192],
]) {
  const dataUrl = await page.evaluate(
    async ({ src, size }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${src}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, size, size);
      const d = g.getImageData(0, 0, size, size);
      for (let i = 0; i < d.data.length; i += 4) {
        const lum = (d.data[i] + d.data[i + 1] + d.data[i + 2]) / 3;
        const a = d.data[i + 3] * Math.max(0, Math.min(1, (lum - 110) / 90));
        d.data[i] = d.data[i + 1] = d.data[i + 2] = 255;
        d.data[i + 3] = a;
      }
      g.putImageData(d, 0, 0);
      return c.toDataURL('image/png');
    },
    { src, size },
  );
  writeFileSync(join(out, file), Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('wrote', file);
}

// iOS launch images (apple-touch-startup-image): the night ground in the gold double rule, the icon,
// "after hours" in engraved capitals, the white Recurse logo.
for (const [W, H] of [
  [1170, 2532],
  [1179, 2556],
  [1284, 2778],
  [1290, 2796],
  [750, 1334],
  [828, 1792],
]) {
  const dataUrl = await page.evaluate(
    async ({ src, logo, font, W, H, GOLD }) => {
      const w = /** @type {any} */ (window);
      const load = async (b64) => {
        const i = new Image();
        i.src = `data:image/png;base64,${b64}`;
        await i.decode();
        return i;
      };
      const ff = new FontFace('CinzelIcons', `url(data:font/woff2;base64,${font})`);
      await ff.load();
      document.fonts.add(ff);
      const [icon, mark] = [await load(src), await load(logo)];
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');
      w.ground(g, 0, 0, W, H, 0);
      const k = W * 0.006;
      w.frame(g, W * 0.06, W * 0.06, W * 0.88, H - W * 0.12, k);
      const s = Math.round(W * 0.3);
      const x = (W - s) / 2;
      const y = H * 0.32;
      g.drawImage(icon, x, y, s, s);
      g.fillStyle = GOLD;
      g.textAlign = 'center';
      g.textBaseline = 'alphabetic';
      g.font = `900 ${Math.round(W * 0.1)}px CinzelIcons`;
      const ty = y + s + H * 0.075;
      g.fillText('AFTER HOURS', W / 2, ty);
      // a star rule under the words
      g.strokeStyle = GOLD;
      g.lineWidth = Math.max(1, k * 0.5);
      const ry = ty + H * 0.025;
      g.beginPath();
      g.moveTo(W * 0.25, ry);
      g.lineTo(W * 0.46, ry);
      g.moveTo(W * 0.54, ry);
      g.lineTo(W * 0.75, ry);
      g.stroke();
      w.star(g, W / 2, ry, k * 3);
      const mw = W * 0.4;
      const mh = (mw * mark.height) / mark.width;
      g.drawImage(mark, (W - mw) / 2, ry + H * 0.04, mw, mh);
      return c.toDataURL('image/png');
    },
    { src, logo, font, W, H, GOLD },
  );
  writeFileSync(join(out, `splash-${W}x${H}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('wrote', `splash-${W}x${H}.png`);
}
await browser.close();
