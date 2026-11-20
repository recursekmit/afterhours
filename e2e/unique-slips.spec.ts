/*
  Unique slips, end to end with the real camera pipeline (docs/SLIPS.md, "unique slips").
  1. The console builds a graph trail with a UNIQUE slip set: every printed copy of slip 1 has its own
     words, but each orientation does the same thing on every copy.
  2. Copies no. 001 and no. 002 are printed with the real ticket renderer (/dev/slips, the words from
     the console's print sheet) and "photographed" by the synthetic camera into y4m files (Chromium's
     fake capture), turned a quarter so the right edge is at the bottom.
  3. Phone A scans copy 001 and phone B scans copy 002 at that same orientation: different words, the
     same outcome (a clue). Each first scan claims that copy.
  4. Phone B then scans phone A's copy: refused, "this slip belongs to someone else".
  5. Screenshots: a print sheet page of unique slips, the console copies table, the phone's refusal.
  Run: npm run build && E2E_PORT=4905 npx playwright test e2e/unique-slips.spec.ts
*/
import { type APIRequestContext, type BrowserContext, chromium, expect, type Page, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { decodePng } from '../web/src/lib/slips/scanner/testing/png';
import { cameraScene, type FloatImage, rgbaToFloat } from '../web/src/lib/slips/scanner/testing/synth';

const SHOTS = 'docs/screens';
const TMP = join('.playwright', 'unique-slips');
mkdirSync(TMP, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 4310);
const BASE = `http://127.0.0.1:${PORT}`;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } as const;
const CLUE = 'every copy of slip 1 says this on its right edge';

type Edges = Record<'bottom' | 'right' | 'top' | 'left', { word: string; morse: string } | null>;
type State = Awaited<ReturnType<BrowserContext['storageState']>>;

let admin: APIRequestContext;
let trailId = 0;
let setId = 0;
const copies = new Map<number, Edges>();
const prints = new Map<number, FloatImage>();
const phones: Record<'a' | 'b', State | null> = { a: null, b: null };

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

/** A phone whose camera sees printed copy `serial`, turned `roll` degrees. */
async function withCamera(who: 'a' | 'b', serial: number, roll: number, fn: (page: Page) => Promise<void>) {
  const print = prints.get(serial);
  if (!print) throw new Error(`print copy ${serial} first`);
  const y4m = join(TMP, `copy-${serial}-${roll}.y4m`);
  writeY4m(
    y4m,
    [0, 1, 2].map((k) => cameraScene(print, { slipMm: { w: 176 + 12, h: 80 + 12 }, width: 1080, height: 1920, pxPerMm: 5, blur: 0.8, noise: 0.012, rollDeg: roll + 4 + k * 0.4, pitchDeg: 8, seed: 100 * serial + k })),
  );
  const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`] });
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

async function scanOnce(page: Page) {
  await page.goto(`/hunt/t/${trailId}`);
  await expect(page.getByText('take slip 1 from your kit')).toBeVisible();
  await page.getByTestId('slip-scan-open').click();
}

test.describe.serial('unique slips: two phones, two copies, one slip', () => {
  test.beforeAll(async ({ playwright }) => {
    admin = await playwright.request.newContext({ baseURL: BASE });
    expect((await admin.post('/api/admin/session', { data: { pin: '2468' } })).ok()).toBeTruthy();
  });

  test('build a trail with a unique slip set and print two copies with the real renderer', async ({ browser }) => {
    trailId = (await api<{ trail: { id: number } }>('POST', '/api/hunt/admin/trails', { title: 'the unique trail', kind: 'morse', orderMode: 'graph' })).trail.id;
    setId = (await api<{ sets: { id: number; mode: string }[] }>('POST', `/api/hunt/admin/slip-sets?trail=${trailId}`, { title: 'kit slips', mode: 'unique', copies: 12 })).sets[0]!.id;
    const end = (await api<{ stops: { id: number }[] }>('POST', `/api/hunt/admin/stops?trail=${trailId}`, { title: 'the lab', clue: 'you took the lab path: say the club name', answers: ['recurse'], finale: true })).stops.at(-1)!.id;
    const slips = await api<{ sets: { slips: { id: number }[] }[] }>('POST', `/api/hunt/admin/slip-sets/${setId}/slips`, {
      slipNo: 1,
      label: 'start',
      readings: [
        { orientation: 'bottom', outcome: 'next', targetStopId: end },
        { orientation: 'right', outcome: 'clue', clue: CLUE },
        { orientation: 'top', outcome: 'decoy' },
        { orientation: 'left', outcome: 'decoy' },
        { orientation: 'extra', outcome: 'decoy', message: 'upside down!' },
      ],
    });
    const admin1 = await api<{ stops: { id: number }[] }>('POST', `/api/hunt/admin/stops?trail=${trailId}`, { title: 'your kit slip', clue: 'take slip 1 from your kit and scan it', slipId: slips.sets[0]!.slips[0]!.id });
    const ids = admin1.stops.map((x) => x.id);
    await api('PUT', `/api/hunt/admin/order?trail=${trailId}`, { ids: [ids.at(-1)!, ...ids.slice(0, -1)] });
    await api('PUT', `/api/hunt/admin/state?trail=${trailId}`, { status: 'open' });

    const sheet = await api<{ mode: string; slips: { serial: number | null; edges: Edges }[] }>('GET', `/api/hunt/admin/slip-print?set=${setId}`);
    expect(sheet.mode).toBe('unique');
    expect(sheet.slips).toHaveLength(12);
    for (const s of sheet.slips) copies.set(s.serial!, s.edges);
    const [c1, c2] = [copies.get(1)!, copies.get(2)!];
    // two copies of the same slip: a different word on every edge
    for (const e of ['bottom', 'right', 'top', 'left'] as const) expect(c1[e]!.word).not.toBe(c2[e]!.word);

    // the exact tickets the console prints (slip 1 of a mixed set is the armillary), ~11 px/mm
    const ctx = await browser.newContext({ viewport: { width: 900, height: 500 }, deviceScaleFactor: 3 });
    const page = await ctx.newPage();
    for (const serial of [1, 2]) {
      const e = copies.get(serial)!;
      await page.goto(`${BASE}/dev/slips?size=ticket&ticket=armillary&b=${e.bottom!.word}&r=${e.right!.word}&t=${e.top!.word}&l=${e.left!.word}&n=1&serial=${serial}&print=1`);
      const el = page.getByTestId('slip-print');
      await expect(el.locator('svg').first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      const png = await el.screenshot();
      writeFileSync(join(TMP, `copy-${serial}.png`), png);
      const r = await decodePng(new Uint8Array(png), (d) => inflateSync(d));
      prints.set(serial, rgbaToFloat(r.rgba, r.width, r.height));
    }
    await ctx.close();

    // two signed-in attendees with profiles
    const kits = (await api<{ kits: { kitId: string; password: string }[] }>('POST', '/api/admin/kits', { mode: 'blank', count: 2 })).kits;
    for (const [i, who] of (['a', 'b'] as const).entries()) {
      const pctx = await browser.newContext({ ...PHONE, baseURL: BASE });
      expect((await pctx.request.post('/api/auth/signin', { data: kits[i] })).ok()).toBeTruthy();
      expect(
        (
          await pctx.request.put('/api/me/profile', {
            data: { name: `Phone ${who.toUpperCase()}`, roll: `U${i}`, nickname: `phone ${who}`, avatar: { shape: 'blob', color: i ? 'pink' : 'sky', eyes: 'wide', mouth: 'grin', top: 'none', extra: 'none' } },
          })
        ).ok(),
      ).toBeTruthy();
      expect((await pctx.request.post('/api/hunt/start', { data: { trailId } })).ok()).toBeTruthy();
      phones[who] = await pctx.storageState();
      await pctx.close();
    }
  });

  test('phone A scans copy 001 and phone B scans copy 002, same orientation: different words, the same clue', async () => {
    for (const [who, serial] of [['a', 1], ['b', 2]] as const) {
      await withCamera(who, serial, 90, async (page) => {
        await scanOnce(page);
        await expect(page.getByText('a clue', { exact: true })).toBeVisible({ timeout: 20_000 });
        await expect(page.getByText(CLUE)).toBeVisible();
        // the first scan claimed this copy
        await expect(page.getByTestId('slip-copy')).toHaveText(`your copy: no. ${String(serial).padStart(3, '0')}`, { timeout: 6000 });
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${SHOTS}/unique-slip-claimed-${who}-390.png` });
      });
    }
    expect(copies.get(1)!.right!.word).not.toBe(copies.get(2)!.right!.word);
    const table = await api<{ rows: { serial: number; cells: { claimedBy: { nickname: string } | null }[] }[]; claimed: number }>('GET', `/api/hunt/admin/slip-sets/${setId}/copies`);
    expect(table.claimed).toBe(2);
    expect(table.rows[0]!.cells[0]!.claimedBy!.nickname).toBe('phone a');
    expect(table.rows[1]!.cells[0]!.claimedBy!.nickname).toBe('phone b');
    // both people found the same reading (the right edge), from two different words
    const sets = await api<{ sets: { slips: { readings: { orientation: string; finds: number }[] }[] }[] }>('GET', `/api/hunt/admin/slip-sets?trail=${trailId}`);
    expect(sets.sets[0]!.slips[0]!.readings.find((r) => r.orientation === 'right')!.finds).toBe(2);
  });

  test("phone B scans phone A's copy: refused, nothing happens", async () => {
    await withCamera('b', 1, 90, async (page) => {
      await scanOnce(page);
      await expect(page.getByText('not your slip')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('this slip belongs to someone else. scan your own.')).toBeVisible();
      // still on the slip stop, still holding copy 002
      await expect(page.getByText('take slip 1 from your kit')).toBeVisible();
      await expect(page.getByTestId('slip-copy')).toHaveText('your copy: no. 002');
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/unique-slip-not-yours-390.png` });
    });
    // and phone A's own copy still works for A: bottom edge, typed this time
    await withCamera('a', 1, 0, async (page) => {
      await scanOnce(page);
      await expect(page.getByText('onwards')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('you took the lab path')).toBeVisible({ timeout: 6000 });
    });
  });

  test('console: the copies table and a print sheet page of unique slips', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: BASE });
    const page = await ctx.newPage();
    await page.request.post('/api/admin/session', { data: { pin: '2468' } });
    await page.goto('/admin/hunt');
    await page.locator('button', { hasText: 'the unique trail' }).first().click();
    await page.getByRole('tab', { name: 'slips' }).click();
    await page.getByTestId(`copies-${setId}`).click();
    const panel = page.getByTestId(`slip-copies-${setId}`);
    await expect(panel.getByTestId('copies-table')).toBeVisible();
    await expect(panel.getByText('phone a')).toBeVisible();
    await expect(panel.getByText('phone b')).toBeVisible();
    await panel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await panel.screenshot({ path: `${SHOTS}/unique-copies-table.png` });

    // an A4 page is ~1123 css px tall: make room for the whole page plus the overlay's bar
    await page.setViewportSize({ width: 1000, height: 1500 });
    await page.getByTestId(`print-slips-${setId}`).click();
    const sheet = page.getByTestId('slip-sheet-page').first();
    await expect(sheet).toBeVisible();
    // 12 copies of a one-slip set, 3 tickets per A4 page
    await expect(page.getByTestId('slip-sheet-page')).toHaveCount(4);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);
    await sheet.screenshot({ path: `${SHOTS}/unique-slip-sheet-page.png` });
    await ctx.close();
  });
});
