/*
  The morse slip and player visibility, end to end (E2E_PORT=4906).
  1. Both events start hidden: no hunt tab, no morse slip on the Morse page, /hunt says "not open yet".
  2. The console switches "show morse challenge to players" on: the phone shows the morse slip live,
     without a reload; the treasure hunt stays hidden.
  3. Phone A's ticket (copy 001, printed in its own design by the real renderer, seen by the fake camera):
     turned so the left edge is at the bottom, a bonus; held upright, the bottom edge finishes the challenge.
  4. Phone B scans phone A's ticket: "not your slip".
  5. The treasure hunt switch shows the hunt tab live.
  6. Phone A signs out (in-page confirm), lands on sign-in, and signs straight back in on the same phone.
  7. The console logs out: the PIN gate is back and the session is gone on the server.
  Screenshots: hidden and shown phones, the scans, sign-out confirm, the console switches, a print page
  of morse slip tickets in mixed designs.
*/
import { type APIRequestContext, type BrowserContext, chromium, expect, type Page, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { decodePng } from '../web/src/lib/slips/scanner/testing/png';
import { cameraScene, type FloatImage, rgbaToFloat } from '../web/src/lib/slips/scanner/testing/synth';

const SHOTS = 'docs/screens';
const TMP = join('.playwright', 'morse-slip');
mkdirSync(TMP, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 4310);
const BASE = `http://127.0.0.1:${PORT}`;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } as const;

type Edges = Record<'bottom' | 'right' | 'top' | 'left', { word: string; morse: string } | null>;
type State = Awaited<ReturnType<BrowserContext['storageState']>>;
interface Copy {
  serial: number;
  ticket: string;
  edges: Edges;
}

let admin: APIRequestContext;
let trailId = 0;
let setId = 0;
const copies = new Map<number, Copy>();
const prints = new Map<number, FloatImage>();
const phones: Record<'a' | 'b', State | null> = { a: null, b: null };
const kits: { kitId: string; password: string }[] = [];

async function api<T = unknown>(method: 'GET' | 'POST' | 'PUT', path: string, data?: unknown): Promise<T> {
  const r = await admin.fetch(path, { method, data: data as object | undefined });
  expect(r.ok(), `${method} ${path}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()) as T;
}

function writeY4m(path: string, frames: { width: number; height: number; data: Uint8Array }[]) {
  const { width, height } = frames[0]!;
  const parts: Buffer[] = [Buffer.from(`YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420jpeg\n`)];
  const chroma = Buffer.alloc((width / 2) * (height / 2), 128);
  for (const f of frames) parts.push(Buffer.from('FRAME\n'), Buffer.from(f.data), chroma, chroma);
  writeFileSync(path, Buffer.concat(parts));
}

/** A phone; with `serial`, its camera sees that printed copy turned `roll` degrees. */
async function phone(who: 'a' | 'b', fn: (page: Page) => Promise<void>, cam?: { serial: number; roll: number }) {
  const args = ['--use-fake-ui-for-media-stream'];
  if (cam) {
    const print = prints.get(cam.serial)!;
    const y4m = join(TMP, `copy-${cam.serial}-${cam.roll}.y4m`);
    writeY4m(
      y4m,
      [0, 1, 2].map((k) => cameraScene(print, { slipMm: { w: 176 + 12, h: 80 + 12 }, width: 1080, height: 1920, pxPerMm: 5, blur: 0.8, noise: 0.012, rollDeg: cam.roll + 4 + k * 0.4, pitchDeg: 8, seed: 100 * cam.serial + k + cam.roll })),
    );
    args.push('--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`);
  }
  const b = await chromium.launch({ args });
  try {
    const ctx = await b.newContext({ ...PHONE, baseURL: BASE, permissions: ['camera'], storageState: phones[who] ?? undefined });
    const page = await ctx.newPage();
    await fn(page);
    phones[who] = await ctx.storageState();
    await ctx.close();
  } finally {
    await b.close();
  }
}

async function scan(page: Page) {
  await page.goto(`/morse/t/${trailId}`);
  await expect(page.getByText('Your kit has one Morse slip')).toBeVisible();
  await page.getByTestId('slip-scan-open').click();
}

test.describe.serial('the morse slip: separate events, one ticket each, logouts', () => {
  test.beforeAll(async ({ playwright }) => {
    admin = await playwright.request.newContext({ baseURL: BASE });
    expect((await admin.post('/api/admin/session', { data: { pin: '2468' } })).ok()).toBeTruthy();
  });

  test('set up: the morse slip (80 unique tickets in four designs), two phones, both events hidden', async ({ browser }) => {
    const r = await api<{ trailId: number; setId: number; created: boolean }>('POST', '/api/hunt/admin/morse-slip');
    expect(r.created).toBe(true);
    ({ trailId, setId } = r);
    expect(await api('GET', '/api/hunt/visibility')).toEqual({ hunt: false, morse: false });
    const sheet = await api<{ slips: { serial: number; ticket: string; edges: Edges }[] }>('GET', `/api/hunt/admin/slip-print?set=${setId}`);
    expect(sheet.slips).toHaveLength(80);
    for (const d of ['armillary', 'wave', 'ginkgo', 'ruins']) expect(sheet.slips.filter((s) => s.ticket === d)).toHaveLength(20);
    for (const s of sheet.slips) copies.set(s.serial, { serial: s.serial, ticket: s.ticket, edges: s.edges });

    // copy 001 printed exactly as the console prints it: its own design, its own words
    const ctx = await browser.newContext({ viewport: { width: 900, height: 500 }, deviceScaleFactor: 3 });
    const page = await ctx.newPage();
    const c = copies.get(1)!;
    await page.goto(`${BASE}/dev/slips?size=ticket&ticket=${c.ticket}&b=${c.edges.bottom!.word}&r=${c.edges.right!.word}&t=${c.edges.top!.word}&l=${c.edges.left!.word}&n=1&serial=1&print=1`);
    const el = page.getByTestId('slip-print');
    await expect(el.locator('svg').first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const png = await el.screenshot();
    writeFileSync(join(TMP, 'copy-1.png'), png);
    const img = await decodePng(new Uint8Array(png), (d) => inflateSync(d));
    prints.set(1, rgbaToFloat(img.rgba, img.width, img.height));
    await ctx.close();

    kits.push(...(await api<{ kits: { kitId: string; password: string }[] }>('POST', '/api/admin/kits', { mode: 'blank', count: 2 })).kits);
    for (const [i, who] of (['a', 'b'] as const).entries()) {
      const pctx = await browser.newContext({ ...PHONE, baseURL: BASE });
      expect((await pctx.request.post('/api/auth/signin', { data: kits[i] })).ok()).toBeTruthy();
      const avatar = { shape: 'blob', color: i ? 'pink' : 'sky', eyes: 'wide', mouth: 'grin', top: 'none', extra: 'none' };
      expect((await pctx.request.put('/api/me/profile', { data: { name: `Phone ${who}`, roll: `M${i}`, nickname: `phone ${who}`, avatar } })).ok()).toBeTruthy();
      phones[who] = await pctx.storageState();
      await pctx.close();
    }
  });

  test('hidden: no hunt tab, no morse slip, /hunt says not open; the console shows morse and the phone updates live', async ({ browser }) => {
    await phone('a', async (page) => {
      await page.goto('/morse');
      const nav = page.getByRole('navigation', { name: 'main' });
      await expect(nav.getByRole('link', { name: 'morse' })).toBeVisible();
      await expect(nav.getByRole('link', { name: 'hunt' })).toHaveCount(0);
      await expect(page.getByTestId('morse-trails')).toHaveCount(0);
      await page.screenshot({ path: `${SHOTS}/morse-slip-hidden-390.png` });

      // the organiser switches the morse challenge on in the console
      const cctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: BASE });
      const con = await cctx.newPage();
      await con.request.post('/api/admin/session', { data: { pin: '2468' } });
      await con.goto('/admin/hunt');
      const sw = con.getByTestId('switch-morse');
      await expect(sw).toHaveAttribute('data-on', 'false');
      await sw.getByRole('button', { name: 'show to players' }).click();
      await expect(sw).toHaveAttribute('data-on', 'true');
      await con.getByTestId('switch-hunt').scrollIntoViewIfNeeded();
      await con.screenshot({ path: `${SHOTS}/console-player-switches.png` });
      await cctx.close();

      // live, no reload: the morse slip appears; the hunt does not
      await expect(page.getByTestId('morse-trails')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole('link', { name: 'the morse slip' })).toBeVisible();
      await expect(nav.getByRole('link', { name: 'hunt' })).toHaveCount(0);
      await page.screenshot({ path: `${SHOTS}/morse-slip-shown-390.png` });
      await page.goto('/hunt');
      await expect(page.getByTestId('not-open')).toBeVisible();
      await expect(page.getByText('not open yet')).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/hunt-not-open-390.png` });
      expect((await page.request.get('/api/hunt/trails?group=hunt')).status()).toBe(403);
    });
  });

  test('phone A: the left edge pays a bonus, the bottom edge finishes the challenge', async () => {
    await phone('a', async (page) => {
      await page.goto(`/morse/t/${trailId}`);
      await page.getByRole('button', { name: 'start this trail' }).click();
      await expect(page.getByText('Your kit has one Morse slip')).toBeVisible();
    });
    await phone(
      'a',
      async (page) => {
        await scan(page);
        await expect(page.getByText(/\+10 bonus/)).toBeVisible({ timeout: 20_000 });
        await expect(page.getByTestId('slip-copy')).toHaveText('your copy: no. 001', { timeout: 6000 });
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${SHOTS}/morse-slip-bonus-390.png` });
      },
      { serial: 1, roll: 270 },
    );
    await phone(
      'a',
      async (page) => {
        await scan(page);
        await expect(page.getByText('onwards')).toBeVisible({ timeout: 20_000 });
        // the finish: a stamp and the rank
        await page.getByRole('button', { name: 'stick it in' }).click({ timeout: 4000 }).catch(() => undefined);
        await expect(page.getByText(/#1/).first()).toBeVisible({ timeout: 8000 });
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${SHOTS}/morse-slip-finished-390.png` });
      },
      { serial: 1, roll: 0 },
    );
    const me = await api<{ rows: { nickname: string; finishedAt: number | null; rank: number | null }[] }>('GET', `/api/hunt/admin/progress?trail=${trailId}`);
    expect(me.rows.find((r) => r.nickname === 'phone a')).toMatchObject({ rank: 1 });
  });

  test("phone B scans phone A's ticket: not your slip", async () => {
    await phone('b', async (page) => {
      await page.goto(`/morse/t/${trailId}`);
      await page.getByRole('button', { name: 'start this trail' }).click();
      await expect(page.getByText('Your kit has one Morse slip')).toBeVisible();
    });
    await phone(
      'b',
      async (page) => {
        await scan(page);
        await expect(page.getByText('not your slip')).toBeVisible({ timeout: 20_000 });
        await expect(page.getByText('this slip belongs to someone else. scan your own.')).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/morse-slip-not-yours-390.png` });
      },
      { serial: 1, roll: 0 },
    );
  });

  test('the treasure hunt switch shows the hunt tab live', async () => {
    await phone('b', async (page) => {
      await page.goto('/');
      const nav = page.getByRole('navigation', { name: 'main' });
      await expect(nav.getByRole('link', { name: 'hunt' })).toHaveCount(0);
      await api('PUT', '/api/hunt/admin/visibility', { hunt: true });
      await expect(nav.getByRole('link', { name: 'hunt' })).toBeVisible({ timeout: 10_000 });
      await api('PUT', '/api/hunt/admin/visibility', { hunt: false });
      await expect(nav.getByRole('link', { name: 'hunt' })).toHaveCount(0, { timeout: 10_000 });
    });
  });

  test('phone A signs out with an in-page confirm and signs straight back in on the same phone', async () => {
    await phone('a', async (page) => {
      await page.goto('/');
      await page.getByTestId('signout-open').click();
      const confirm = page.getByTestId('signout-confirm');
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText('stays tied to this phone');
      await confirm.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/signout-confirm-390.png` });
      // "stay signed in" backs out
      await page.getByRole('button', { name: 'stay signed in' }).click();
      await expect(confirm).toHaveCount(0);
      await page.getByTestId('signout-open').click();
      await page.getByRole('button', { name: 'yes, sign out' }).click();
      await expect(page.getByLabel('kit id')).toBeVisible({ timeout: 8000 });
      expect((await page.request.get('/api/me')).status()).toBe(401);
      await page.screenshot({ path: `${SHOTS}/signout-landed-390.png` });
      // same phone, same card: straight back in (the kit stays bound to this browser)
      await page.getByLabel('kit id').fill(kits[0]!.kitId);
      await page.getByLabel('password').fill(kits[0]!.password);
      await page.getByLabel('password').press('Enter');
      await expect(page.getByTestId('signout-open')).toBeVisible({ timeout: 10_000 });
      expect((await page.request.get('/api/me')).ok()).toBeTruthy();
    });
  });

  test('console: a print page of morse slip tickets in mixed designs, then log out ends the session', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 1500 }, baseURL: BASE });
    const page = await ctx.newPage();
    await page.request.post('/api/admin/session', { data: { pin: '2468' } });
    await page.goto('/admin/hunt');
    await page.locator('button', { hasText: 'the morse slip' }).first().click();
    await page.getByRole('tab', { name: 'slips' }).click();
    await page.getByTestId(`print-slips-${setId}`).click();
    const sheet = page.getByTestId('slip-sheet-page').first();
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId('slip-sheet-page')).toHaveCount(27);
    // the first page's three tickets, in their copies' own designs
    const want = [1, 2, 3].map((s) => copies.get(s)!.ticket);
    expect(await sheet.locator('[data-ticket]').evaluateAll((els) => els.map((e) => e.getAttribute('data-ticket')))).toEqual(want);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);
    await sheet.screenshot({ path: `${SHOTS}/morse-slip-sheet-mixed.png` });
    await page.keyboard.press('Escape');

    await page.goto('/admin/hunt');
    await page.getByTestId('admin-logout').click();
    await expect(page.getByLabel('PIN')).toBeVisible({ timeout: 8000 });
    expect((await page.request.get('/api/admin/session')).status()).toBe(401);
    expect((await page.request.get('/api/hunt/admin/trails')).status()).toBe(401);
    await ctx.close();
  });
});
