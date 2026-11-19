/*
  Trails + the real slip camera, end to end.
  1. The console builds a graph Morse slip trail: one kit slip, four edges with different outcomes.
  2. The slip is printed with the real renderer (/dev/slips) and "photographed" by the synthetic
     camera at 90 and 0 degrees into y4m files (Chromium's fake capture).
  3. On the phone's slip stop the scanner reads the right edge (HINT: a clue, you stay), then,
     turned a quarter, the bottom edge (LAB: next stop). Two orientations, two outcomes.
  4. Screenshots: the slip stop, the scanner open and reading, the result, and the console's
     slip sheet print preview.
*/
import { type APIRequestContext, chromium, expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { decodePng } from '../web/src/lib/slips/scanner/testing/png';
import { cameraScene, type CameraOptions, type FloatImage, rgbaToFloat } from '../web/src/lib/slips/scanner/testing/synth';

const SHOTS = 'docs/screens';
const TMP = join('.playwright', 'trails-camera');
mkdirSync(TMP, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 4310);
const BASE = `http://127.0.0.1:${PORT}`;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } as const;

let print: FloatImage | null = null;
let admin: APIRequestContext;
let trailId = 0;
let setId = 0;
let state: Awaited<ReturnType<import('@playwright/test').BrowserContext['storageState']>>;

function writeY4m(path: string, frames: { width: number; height: number; data: Uint8Array }[]) {
  const { width, height } = frames[0]!;
  const parts: Buffer[] = [Buffer.from(`YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420jpeg\n`)];
  const chroma = Buffer.alloc((width / 2) * (height / 2), 128);
  for (const f of frames) parts.push(Buffer.from('FRAME\n'), Buffer.from(f.data), chroma, chroma);
  writeFileSync(path, Buffer.concat(parts));
}

function scene(opts: Partial<CameraOptions>, seed: number) {
  if (!print) throw new Error('print the slip first');
  return cameraScene(print, { slipMm: { w: 85 + 12, h: 55 + 12 }, width: 720, height: 1280, pxPerMm: 6.2, blur: 0.8, noise: 0.012, seed, ...opts });
}

async function api<T = unknown>(method: 'GET' | 'POST' | 'PUT', path: string, data?: unknown): Promise<T> {
  const r = await admin.fetch(path, { method, data: data as object | undefined });
  expect(r.ok(), `${method} ${path}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()) as T;
}

async function withCamera(roll: number, fn: (page: import('@playwright/test').Page) => Promise<void>) {
  const y4m = join(TMP, `slip-${roll}.y4m`);
  writeY4m(
    y4m,
    [0, 1, 2].map((k) => scene({ rollDeg: roll + 4 + k * 0.4, pitchDeg: 8 }, 10 * roll + k)),
  );
  const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`] });
  try {
    const ctx = await b.newContext({ ...PHONE, baseURL: BASE, permissions: ['camera'], storageState: state });
    const page = await ctx.newPage();
    await fn(page);
    state = await ctx.storageState();
    await ctx.close();
  } finally {
    await b.close();
  }
}

test.describe.serial('trails: slip camera', () => {
  test.beforeAll(async ({ playwright }) => {
    admin = await playwright.request.newContext({ baseURL: BASE });
    expect((await admin.post('/api/admin/session', { data: { pin: '2468' } })).ok()).toBeTruthy();
  });

  test('build a slip trail and print its kit slip with the real renderer', async ({ browser }) => {
    trailId = (await api<{ trail: { id: number } }>('POST', '/api/hunt/admin/trails', { title: 'the camera trail', kind: 'morse', orderMode: 'graph' })).trail.id;
    setId = (await api<{ sets: { id: number }[] }>('POST', `/api/hunt/admin/slip-sets?trail=${trailId}`, { title: 'kit slip', mode: 'shared' })).sets[0]!.id;
    const end = (await api<{ stops: { id: number }[] }>('POST', `/api/hunt/admin/stops?trail=${trailId}`, { title: 'the lab', clue: 'you took the lab path: say the club name', answers: ['recurse'], finale: true })).stops.at(-1)!.id;
    const slips = await api<{ sets: { slips: { id: number }[] }[] }>('POST', `/api/hunt/admin/slip-sets/${setId}/slips`, {
      slipNo: 1,
      label: 'start',
      readings: [
        { orientation: 'bottom', word: 'LAB', outcome: 'next', targetStopId: end },
        { orientation: 'right', word: 'HINT', outcome: 'clue', clue: 'every slip has a tech word on it' },
        { orientation: 'top', word: 'NOPE', outcome: 'decoy' },
        { orientation: 'left', word: 'SUN', outcome: 'decoy' },
      ],
    });
    const admin1 = await api<{ stops: { id: number }[] }>('POST', `/api/hunt/admin/stops?trail=${trailId}`, { title: 'your kit slip', clue: 'take slip 1 from your kit and scan it', slipId: slips.sets[0]!.slips[0]!.id });
    const ids = admin1.stops.map((x) => x.id);
    await api('PUT', `/api/hunt/admin/order?trail=${trailId}`, { ids: [ids.at(-1)!, ...ids.slice(0, -1)] });
    await api('PUT', `/api/hunt/admin/state?trail=${trailId}`, { status: 'open' });

    // the exact slip the console prints, rendered at ~15 px/mm
    const ctx = await browser.newContext({ viewport: { width: 600, height: 400 }, deviceScaleFactor: 4 });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/dev/slips?b=lab&r=hint&t=nope&l=sun&n=1&print=1`);
    const el = page.getByTestId('slip-print');
    await expect(el.locator('svg')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const r = await decodePng(new Uint8Array(await el.screenshot()), (d) => inflateSync(d));
    print = rgbaToFloat(r.rgba, r.width, r.height);
    await ctx.close();

    // a signed-in attendee with a profile, kept across the two camera browsers
    const kit = (await api<{ kits: { kitId: string; password: string }[] }>('POST', '/api/admin/kits', { mode: 'blank', count: 1 })).kits[0]!;
    const pctx = await browser.newContext({ ...PHONE, baseURL: BASE });
    expect((await pctx.request.post('/api/auth/signin', { data: kit })).ok()).toBeTruthy();
    expect(
      (await pctx.request.put('/api/me/profile', { data: { name: 'Cam Era', roll: 'C1', nickname: 'camera', avatar: { shape: 'blob', color: 'sky', eyes: 'wide', mouth: 'grin', top: 'none', extra: 'none' } } })).ok(),
    ).toBeTruthy();
    expect((await pctx.request.post('/api/hunt/start', { data: { trailId } })).ok()).toBeTruthy();
    state = await pctx.storageState();
    await pctx.close();
  });

  test('turned a quarter, the right edge reads HINT: a clue, you stay on the stop', async () => {
    await withCamera(90, async (page) => {
      await page.goto(`/hunt/t/${trailId}`);
      await expect(page.getByText('take slip 1 from your kit')).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/trails-slip-stop-390.png` });
      await page.getByTestId('slip-scan-open').click();
      await expect(page.getByTestId('slip-scanner')).toBeVisible();
      // the scanner open and reading: grab it while it locks on
      await page
        .locator('[data-testid="slip-scanner"][data-status="ok"]')
        .waitFor({ timeout: 20_000 })
        .then(() => page.screenshot({ path: `${SHOTS}/trails-slip-scanning-390.png` }))
        .catch(() => undefined);
      await expect(page.getByText('a clue', { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('every slip has a tech word on it')).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/trails-slip-scanned-clue-390.png` });
    });
  });

  test('turned back, the bottom edge reads LAB: next stop', async () => {
    await withCamera(0, async (page) => {
      await page.goto(`/hunt/t/${trailId}`);
      await page.getByTestId('slip-scan-open').click();
      await expect(page.getByText('onwards')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('you took the lab path')).toBeVisible({ timeout: 6000 });
      // the first stamp on a morse trail unlocks a sticker: stick it in, then shoot the next stop
      await page.getByRole('button', { name: 'stick it in' }).click({ timeout: 4000 }).catch(() => undefined);
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${SHOTS}/trails-slip-scanned-next-390.png` });
    });
    const graph = await api<{ edges: { label: string; count: number }[] }>('GET', `/api/hunt/admin/graph?trail=${trailId}`);
    expect(graph.edges.find((e) => e.label.startsWith('bottom'))!.count).toBe(1);
    expect(graph.edges.find((e) => e.label.startsWith('right'))!.count).toBe(1);
  });

  test('console: the slip sheet print preview uses the real renderer', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: BASE });
    const page = await ctx.newPage();
    await page.request.post('/api/admin/session', { data: { pin: '2468' } });
    await page.goto('/admin/hunt');
    await page.locator('button', { hasText: 'the camera trail' }).first().click();
    await page.getByRole('tab', { name: 'slips' }).click();
    await page.getByTestId(`print-slips-${setId}`).click();
    const sheet = page.getByTestId('slip-sheet-page').first();
    await expect(sheet).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/trails-console-slip-sheet.png` });
    await ctx.close();
  });
});
