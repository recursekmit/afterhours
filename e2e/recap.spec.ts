// Recap end to end: locked until the console opens it, then the story (count-ups, tap through), the
// personality card with a non-empty 1080x1920 share canvas and a download fallback, the console preview,
// the projector's room recap and the upgraded sticker book. Screenshots go to docs/screens/recap-*.png.
import { writeFileSync } from 'node:fs';
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } as const;
const SHOT = 'docs/screens';

let admin: APIRequestContext;
let kits: { kitId: string; password: string }[] = [];
let baseURL = '';
let next = 0;

async function api<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, data?: unknown): Promise<T> {
  const r = await admin.fetch(path, { method, data: data as object | undefined });
  expect(r.ok(), `${method} ${path}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()) as T;
}

async function attendee(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ ...PHONE, baseURL, acceptDownloads: true });
  const page = await ctx.newPage();
  const kit = kits[next++]!;
  expect((await page.request.post('/api/auth/signin', { data: kit })).ok()).toBeTruthy();
  const prof = await page.request.put('/api/me/profile', {
    data: { name: `Recap ${next}`, roll: `RC${next}`, nickname: `rewinder${next}`, avatar: { shape: 'blob', color: 'pink', eyes: 'wide', mouth: 'grin', top: 'none', extra: 'none' } },
  });
  expect(prof.ok()).toBeTruthy();
  return page;
}

/** Watching and sharing unlock secret stickers: their celebration pops over everything; stick it in. */
async function stick(page: Page) {
  const btn = page.getByRole('button', { name: 'stick it in' });
  await expect(btn).toBeVisible({ timeout: 6000 });
  await btn.click();
  await expect(btn).toBeHidden();
}

test.describe.serial('recap', () => {
  let phone: Page;

  test.beforeAll(async ({ playwright }, info) => {
    baseURL = String(info.project.use.baseURL);
    admin = await playwright.request.newContext({ baseURL });
    expect((await admin.post('/api/admin/session', { data: { pin: '2468' } })).ok()).toBeTruthy();
    kits = (await api<{ kits: { kitId: string; password: string }[] }>('POST', '/api/admin/kits', { mode: 'blank', count: 4 })).kits;
    await api('POST', '/api/recap/admin/open', { open: false });
  });

  test('locked until the console opens it, then the story plays and shares', async ({ browser }) => {
    phone = await attendee(browser);
    const st = (await (await phone.request.get('/api/recap/status')).json()) as { open: boolean; reason: string | null };
    // a full suite run may already have finished the leaderboard reveal, which opens recaps by itself
    if (!st.open) {
      await phone.goto('/recap');
      await expect(phone.getByRole('heading', { name: 'your recap is cooking' })).toBeVisible();
      await phone.waitForTimeout(500);
      await phone.screenshot({ path: `${SHOT}/recap-locked-390.png` });
    }

    // the console opens recaps
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL });
    const con = await ctx.newPage();
    await con.goto('/admin');
    await con.getByLabel('PIN').fill('2468');
    await con.keyboard.press('Enter');
    await expect(con.getByRole('heading', { name: 'kits and sign-ins' })).toBeVisible();
    await con.goto('/admin/recap');
    const openBtn = con.getByRole('button', { name: 'open recaps now' });
    await expect(openBtn).toBeVisible();
    await openBtn.click();
    await expect(con.getByRole('button', { name: 'close recaps' })).toBeVisible();

    // the home card appears live
    await phone.goto('/');
    await expect(phone.getByRole('heading', { name: 'your recap is ready' })).toBeVisible({ timeout: 8000 });
    await phone.waitForTimeout(800);
    await phone.screenshot({ path: `${SHOT}/recap-home-card-390.png` });
    await phone.getByRole('link', { name: 'watch your after hours recap' }).click();

    const story = phone.getByRole('dialog', { name: 'your after hours recap' });
    await expect(story).toBeVisible();
    await expect(story.getByText('after hours, rewinder1')).toBeVisible();
    await phone.waitForTimeout(900);
    await phone.screenshot({ path: `${SHOT}/recap-story-hello-390.png` });
    // tap through: the right side of the card goes forward
    const stage = story.locator('[class*="stage"]');
    const box = (await stage.boundingBox())!;
    const tap = async () => {
      await phone.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.5);
      await phone.waitForTimeout(450);
    };
    await tap();
    await expect(story.getByText('you walked in at')).toBeVisible();
    await phone.waitForTimeout(1300);
    await phone.screenshot({ path: `${SHOT}/recap-story-arrival-390.png` });
    for (let i = 0; i < 12 && !(await story.locator('[data-card="persona"]').isVisible()); i++) {
      if (await story.locator('[data-card="rank"]').isVisible()) {
        await phone.waitForTimeout(1300);
        await phone.screenshot({ path: `${SHOT}/recap-story-rank-390.png` });
      }
      if (await story.locator('[data-card="stickers"]').isVisible()) {
        await phone.waitForTimeout(900);
        await phone.screenshot({ path: `${SHOT}/recap-story-stickers-390.png` });
      }
      await tap();
    }
    await expect(story.locator('[data-card="persona"]')).toBeVisible();
    await expect(story.getByText('your after hours personality')).toBeVisible();
    await stick(phone); // "rewind": watched it to the end
    const share = story.getByRole('button', { name: 'share my story' });
    await expect(share).toBeEnabled({ timeout: 10_000 });
    // the share canvas is a real 1080x1920 picture, not blank
    const canvas = await story.getByTestId('recap-share-canvas').evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set<number>();
      let ink = 0;
      for (let i = 0; i < d.length; i += 4 * 97) {
        seen.add((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!);
        if (d[i]! + d[i + 1]! + d[i + 2]! < 200) ink++;
      }
      return { w: c.width, h: c.height, colours: seen.size, ink };
    });
    expect(canvas.w).toBe(1080);
    expect(canvas.h).toBe(1920);
    expect(canvas.colours).toBeGreaterThan(20);
    expect(canvas.ink).toBeGreaterThan(200);
    await phone.waitForTimeout(800);
    await phone.screenshot({ path: `${SHOT}/recap-story-personality-390.png` });
    // headless Chromium has no file sharing: the fallback downloads the PNG
    const dl = phone.waitForEvent('download');
    await share.click();
    expect((await dl).suggestedFilename()).toBe('after-hours-recap.png');
    await stick(phone); // "show-off": shared it
    // the share image itself, for the docs
    const png = await story.getByTestId('recap-share-canvas').evaluate((el) => (el as HTMLCanvasElement).toDataURL('image/png'));
    writeFileSync(`${SHOT}/recap-share-image.png`, Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64'));

    // console preview of the same person
    await con.getByLabel('find by kit or nickname').fill('rewinder1');
    await con.getByRole('button', { name: /rewinder1/ }).click();
    await expect(con.getByRole('dialog', { name: 'your after hours recap' })).toBeVisible({ timeout: 8000 });
    await con.waitForTimeout(800);
    await con.screenshot({ path: `${SHOT}/recap-console-1280.png` });
    await ctx.close();
  });

  test('projector: the room recap', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, baseURL });
    const page = await ctx.newPage();
    await page.request.post('/api/screen/session', { data: { pin: '1357' } });
    await api('POST', '/api/admin/screen/pin', { sceneId: 'recap' });
    await page.goto('/screen');
    await expect(page.getByRole('heading', { name: "the room's after hours" })).toBeVisible({ timeout: 8000 });
    await page.waitForTimeout(3500);
    await page.screenshot({ path: `${SHOT}/recap-projector-1080.png` });
    await api('POST', '/api/admin/screen/pin', { sceneId: null });
    await ctx.close();
  });

  test('sticker book: pages, rarity, slap', async () => {
    await phone.goto('/stickers');
    await expect(phone.getByRole('heading', { name: 'sticker book' })).toBeVisible();
    await phone.waitForTimeout(1200);
    await phone.screenshot({ path: `${SHOT}/recap-sticker-book-390.png` });
    // flip to the secret page: the recap stickers just landed there
    await phone.getByRole('button', { name: /secret/ }).click();
    await phone.waitForTimeout(900);
    await phone.screenshot({ path: `${SHOT}/recap-sticker-book-secret-390.png` });
    await expect(phone.getByRole('button', { name: 'rewind', exact: true })).toBeVisible();
    await expect(phone.getByRole('button', { name: 'show-off', exact: true })).toBeVisible();
    await phone.getByRole('button', { name: /^showing up/ }).click();
    await phone.getByRole('button', { name: /showed up/i }).first().click();
    const sheet = phone.getByRole('dialog');
    await expect(sheet.getByText(/have this/)).toBeVisible({ timeout: 5000 });
    const slap = sheet.getByRole('button', { name: /^slap / });
    for (let i = 0; i < 3; i++) await slap.click();
    await expect(sheet.getByText('slapped 3 times')).toBeVisible();
    await phone.waitForTimeout(500);
    await phone.screenshot({ path: `${SHOT}/recap-sticker-detail-390.png` });
    await phone.context().close();
    await api('POST', '/api/recap/admin/open', { open: false });
  });
});
