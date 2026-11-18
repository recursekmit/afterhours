/*
  Morse slips, end to end on /dev/slips.
  1. Print a slip with the real SVG renderer (screenshot at 4x = ~15 px/mm), save it as a fixture.
  2. "Photograph" it with the synthetic camera at 0 / 90 / 180 degrees into y4m files.
  3. Launch Chromium with --use-file-for-fake-video-capture on each y4m and check that the
     scanner's primary reading follows the rotation (code -> hi -> lab).
  4. Screenshots at 390 x 844 and 360 x 740: scanner idle, strip highlighted, result,
     typed fallback, the dev page; plus an A4 slip sheet.
  Run: npm run build && E2E_PORT=4601 npx playwright test e2e/slips.spec.ts
*/
import { type Browser, chromium, expect, type Page, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { decodePng, encodeGrayPng } from '../web/src/lib/slips/scanner/testing/png';
import { cameraScene, rgbaToFloat, type CameraOptions, type FloatImage } from '../web/src/lib/slips/scanner/testing/synth';

const SHOTS = 'docs/screens';
const FIX = 'web/src/lib/slips/scanner/fixtures';
const TMP = join('.playwright', 'slips');
mkdirSync(SHOTS, { recursive: true });
mkdirSync(FIX, { recursive: true });
mkdirSync(TMP, { recursive: true });

const PORT = Number(process.env.E2E_PORT ?? 4310);
const BASE = `http://127.0.0.1:${PORT}`;
const WORDS = 'b=code&r=hi&t=lab&l=sun&n=7';
const SIZES = [
  { w: 390, h: 844 },
  { w: 360, h: 740 },
] as const;
const PRINT_SCALE = 4; // CSS px are 96/in, so 4x = 15.1 px/mm

let print: FloatImage | null = null;

/** Y4M (I420), the format Chromium's fake capture reads. A few frames with fresh noise; it loops. */
function writeY4m(path: string, frames: { width: number; height: number; data: Uint8Array }[]) {
  const { width, height } = frames[0]!;
  const parts: Buffer[] = [Buffer.from(`YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420jpeg\n`)];
  const chroma = Buffer.alloc((width / 2) * (height / 2), 128);
  for (const f of frames) {
    parts.push(Buffer.from('FRAME\n'), Buffer.from(f.data), chroma, chroma);
  }
  writeFileSync(path, Buffer.concat(parts));
}

function scene(opts: Partial<CameraOptions>, seed: number) {
  if (!print) throw new Error('print the slip first');
  const mm = { w: 85, h: 55 };
  // the screenshot includes 6 mm of padding around the slip: crop it off by scaling the pose
  return cameraScene(print, { slipMm: { w: mm.w + 12, h: mm.h + 12 }, width: 720, height: 1280, pxPerMm: 6.2, blur: 0.8, noise: 0.012, seed, ...opts });
}

async function withCamera(browser: Browser | null, y4m: string, fn: (page: Page) => Promise<void>, size: { w: number; h: number } = SIZES[0]) {
  const b =
    browser ??
    (await chromium.launch({
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`],
    }));
  try {
    const ctx = await b.newContext({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, baseURL: BASE, permissions: ['camera'] });
    const page = await ctx.newPage();
    await fn(page);
    await ctx.close();
  } finally {
    if (!browser) await b.close();
  }
}

test.describe.serial('morse slips', () => {
  test('print a slip with the real renderer', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 600, height: 400 }, deviceScaleFactor: PRINT_SCALE });
    const page = await ctx.newPage();
    await page.goto(`/dev/slips?${WORDS}&print=1`);
    const el = page.getByTestId('slip-print');
    await expect(el.locator('svg')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const png = await el.screenshot();
    writeFileSync(join(FIX, 'slip-code-hi-lab-sun.png'), png);
    const r = await decodePng(new Uint8Array(png), (d) => inflateSync(d));
    print = rgbaToFloat(r.rgba, r.width, r.height);
    expect(r.width).toBeGreaterThan(1200);
    await ctx.close();
  });

  test('the fake camera reads the bottom strip, and turning the slip changes it', async () => {
    const cases = [
      { roll: 0, want: 'code' },
      { roll: 90, want: 'hi' },
      { roll: 180, want: 'lab' },
    ];
    for (const c of cases) {
      const frames = [0, 1, 2].map((k) => scene({ rollDeg: c.roll + 4 + k * 0.4, pitchDeg: 8 }, 10 * c.roll + k));
      const y4m = join(TMP, `slip-${c.roll}.y4m`);
      writeY4m(y4m, frames);
      if (c.roll === 0) writeFileSync(join(TMP, 'frame-0.png'), await encodeGrayPng(720, 1280, frames[0]!.data, (d) => deflateSync(d)));
      await withCamera(null, y4m, async (page) => {
        await page.goto(`/dev/slips?${WORDS}&scan=1`);
        await expect(page.getByTestId('dev-last-primary')).toContainText(c.want, { timeout: 20_000 });
      });
    }
  });

  test('screenshots: scanner idle, strip highlighted, result, typed fallback, dev page', async () => {
    const empty = join(TMP, 'empty.y4m');
    writeY4m(empty, [scene({ offset: { x: 5000, y: 0 } }, 1)]);
    // framed for the screenshots: the whole slip inside the cover-cropped view
    const framed = join(TMP, 'framed.y4m');
    writeY4m(framed, [0, 1].map((k) => scene({ rollDeg: 3 + k * 0.3, pitchDeg: 6, pxPerMm: 4.3, offset: { x: 0, y: -40 } }, 70 + k)));
    for (const size of SIZES) {
      const tag = `${size.w}`;
      // idle: camera on, nothing in view
      await withCamera(null, empty, async (page) => {
        await page.goto(`/dev/slips?${WORDS}`);
        await page.getByTestId('open-scanner').click();
        await expect(page.getByTestId('slip-guide')).toContainText('hold it flat');
        // hide the dev overlay for the product screenshots
        await page.addStyleTag({ content: '[data-testid="dev-live"]{display:none}' });
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${SHOTS}/slips-scanner-idle-${tag}.png` });
      }, size);
      // highlighted bottom strip (a never-satisfied stability gate keeps it live), then the result card
      await withCamera(null, framed, async (page) => {
        await page.goto(`/dev/slips?${WORDS}&scan=1&stable=100000`);
        await page.addStyleTag({ content: '[data-testid="dev-live"]{display:none}' });
        await expect(page.getByTestId('slip-scanner')).toHaveAttribute('data-status', 'ok', { timeout: 20_000 });
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${SHOTS}/slips-scanner-strip-${tag}.png` });
      }, size);
      await withCamera(null, framed, async (page) => {
        await page.goto(`/dev/slips?${WORDS}&scan=1&after=result`);
        await page.addStyleTag({ content: '[data-testid="dev-live"]{display:none}' });
        await expect(page.getByTestId('slip-result-word')).toHaveText('code', { timeout: 20_000 });
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${SHOTS}/slips-result-${tag}.png` });
      }, size);
    }
  });

  test('camera denied: keypad fallback gives the same reading shape', async ({ browser }) => {
    for (const size of SIZES) {
      const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      // no camera at all in this context
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'mediaDevices', {
          value: { getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) },
          configurable: true,
        });
      });
      await page.goto(`/dev/slips?${WORDS}&scan=1&after=result`);
      await expect(page.getByTestId('morse-keypad')).toBeVisible();
      await page.addStyleTag({ content: '[data-testid="dev-live"]{display:none}' });
      // H I = .... ..
      for (const k of ['dot', 'dot', 'dot', 'dot']) await page.getByRole('button', { name: k, exact: true }).dispatchEvent('pointerdown');
      await page.getByRole('button', { name: 'next letter' }).click();
      for (const k of ['dot', 'dot']) await page.getByRole('button', { name: k, exact: true }).dispatchEvent('pointerdown');
      await expect(page.getByTestId('keypad-submit')).toContainText("that's hi");
      await page.screenshot({ path: `${SHOTS}/slips-typed-${size.w}.png` });
      await page.getByTestId('keypad-submit').click();
      await expect(page.getByTestId('slip-result-word')).toHaveText('hi');
      const last = JSON.parse((await page.getByTestId('dev-last-scan').textContent()) ?? '{}');
      expect(last.primary).toEqual({ morse: '.... ..', text: 'HI', confidence: 1, position: 'bottom' });
      expect(last.others).toEqual([]);
      await ctx.close();
    }
  });

  test('dev page and the A4 sheet', async ({ browser }) => {
    for (const size of SIZES) {
      const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      await page.goto(`/dev/slips?${WORDS}`);
      await expect(page.getByRole('heading', { name: 'slips', exact: true })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/slips-dev-${size.w}.png`, fullPage: true });
      await ctx.close();
    }
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 1300 }, deviceScaleFactor: 1.5 });
    const page = await ctx.newPage();
    await page.goto(`/dev/slips?${WORDS}`);
    await page.getByTestId('print-sheet').click();
    const sheet = page.getByTestId('slip-sheet-page').first();
    await expect(sheet).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await sheet.screenshot({ path: `${SHOTS}/slips-sheet-a4.png` });
    await page.screenshot({ path: `${SHOTS}/slips-sheet-screen.png` });
    await ctx.close();
  });
});
