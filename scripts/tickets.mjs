/* global Image, document */
// Crops the owner's four ticket designs (design/tickets/source-*.png, two per sheet) into separate art files.
//   node scripts/tickets.mjs
// No dependencies beyond Playwright's Chromium (already a dev dependency): the source is drawn on a canvas,
// the ticket bounds are found by scanning for the non-white card, and each crop is encoded by the browser.
// Writes:
//   design/tickets/<id>.png               the whole ticket, full resolution (reference)
//   web/src/assets/tickets/<id>-field.jpg the art field inside the ticket's own border, print quality
//   web/src/assets/tickets/<id>-sm.webp   the whole ticket, small, for screens
//   web/src/assets/tickets/<id>-field-sm.webp  the art field, small, for screens
// and prints each ticket's bounds and sampled ground colour (copied into web/src/lib/slips/tickets.ts).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const TICKETS = [
  // source sheet, which half, id
  { src: 'design/tickets/source-1.png', half: 'top', id: 'armillary' },
  { src: 'design/tickets/source-1.png', half: 'bottom', id: 'wave' },
  { src: 'design/tickets/source-2.png', half: 'top', id: 'ginkgo' },
  { src: 'design/tickets/source-2.png', half: 'bottom', id: 'ruins' },
];
/** The art field: inside the ticket's own double rule, as a fraction of the ticket. */
const FIELD = { x: 0.035, y: 0.062 };

mkdirSync('web/src/assets/tickets', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
const out = [];
for (const t of TICKETS) {
  const dataUrl = `data:image/png;base64,${readFileSync(t.src).toString('base64')}`;
  const res = await page.evaluate(
    async ({ dataUrl, half, FIELD }) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const W = img.naturalWidth;
      const H = img.naturalHeight;
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, W, H).data;
      const y0 = half === 'top' ? 0 : Math.floor(H / 2);
      const y1 = half === 'top' ? Math.floor(H / 2) : H;
      const dark = (x, y) => {
        const i = (y * W + x) * 4;
        return d[i] + d[i + 1] + d[i + 2] < 3 * 200;
      };
      // bounds: rows/columns where a good share of pixels belong to the (dark) card
      let minX = W, maxX = 0, minY = H, maxY = 0;
      for (let y = y0; y < y1; y += 1) {
        let n = 0;
        for (let x = 0; x < W; x += 4) if (dark(x, y)) n++;
        if (n > W / 4 / 5) {
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
      const midY = Math.round((minY + maxY) / 2);
      for (let x = 0; x < W; x++) if (dark(x, midY)) { minX = x; break; }
      for (let x = W - 1; x >= 0; x--) if (dark(x, midY)) { maxX = x; break; }
      const box = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
      // ground: the darkest median among a few patches in the empty sky
      const patches = [[0.6, 0.12], [0.6, 0.8], [0.5, 0.25], [0.88, 0.8], [0.45, 0.85]];
      let ground = null;
      for (const [fx, fy] of patches) {
        const px = Math.round(box.x + fx * box.w);
        const py = Math.round(box.y + fy * box.h);
        const cols = [];
        for (let yy = py - 12; yy < py + 12; yy++)
          for (let xx = px - 12; xx < px + 12; xx++) {
            const i = (yy * W + xx) * 4;
            cols.push([d[i], d[i + 1], d[i + 2]]);
          }
        cols.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
        const m = cols[Math.floor(cols.length / 2)];
        if (!ground || m[0] + m[1] + m[2] < ground[0] + ground[1] + ground[2]) ground = m;
      }
      const hex = '#' + ground.map((v) => v.toString(16).padStart(2, '0')).join('');
      const crop = (r, w, type, q) => {
        const k = document.createElement('canvas');
        k.width = w;
        k.height = Math.round((w * r.h) / r.w);
        const kg = k.getContext('2d');
        kg.imageSmoothingQuality = 'high';
        kg.drawImage(c, r.x, r.y, r.w, r.h, 0, 0, k.width, k.height);
        return k.toDataURL(type, q);
      };
      const field = { x: box.x + Math.round(box.w * FIELD.x), y: box.y + Math.round(box.h * FIELD.y), w: Math.round(box.w * (1 - 2 * FIELD.x)), h: Math.round(box.h * (1 - 2 * FIELD.y)) };
      return {
        box,
        field,
        ground: hex,
        full: crop(box, box.w, 'image/png'),
        fieldJpg: crop(field, field.w, 'image/jpeg', 0.9),
        sm: crop(box, 720, 'image/webp', 0.82),
        fieldSm: crop(field, 640, 'image/webp', 0.8),
      };
    },
    { dataUrl, half: t.half, FIELD },
  );
  const save = (path, url) => writeFileSync(path, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
  save(`design/tickets/${t.id}.png`, res.full);
  save(`web/src/assets/tickets/${t.id}-field.jpg`, res.fieldJpg);
  save(`web/src/assets/tickets/${t.id}-sm.webp`, res.sm);
  save(`web/src/assets/tickets/${t.id}-field-sm.webp`, res.fieldSm);
  out.push({ id: t.id, box: res.box, field: res.field, ratio: +(res.box.w / res.box.h).toFixed(3), ground: res.ground });
}
await browser.close();
console.log(JSON.stringify(out, null, 2));
