// Screenshot tour of the themed app: every console panel, every projector scene, every attendee page and each
// game's how-to / miss / result, saved as docs/screens/<feature>-<state>-<width>.png. It runs after the feature
// specs (alphabetical), so the database already holds believable activity. Screenshots never fail the suite:
// each step is best-effort; the assertions that matter live in the feature specs.
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } as const;
const SHOT = 'docs/screens';
const NAMES = ['lanternlight', 'quill', 'nightjar.exe', 'byte_bard', 'inkwell', 'starchart', 'brasskey', 'moonlit'];

let admin: APIRequestContext;
let baseURL = '';
let kits: { kitId: string; password: string }[] = [];
let next = 0;

async function api<T = unknown>(method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
  const r = await admin.fetch(path, { method, data: data as object | undefined });
  expect(r.ok(), `${method} ${path}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()) as T;
}

async function attendee(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ ...PHONE, baseURL });
  const page = await ctx.newPage();
  // a missing element skips its screenshot quickly instead of waiting out the test
  page.setDefaultTimeout(6000);
  const kit = kits[next]!;
  const nick = NAMES[next % NAMES.length]!;
  next++;
  expect((await page.request.post('/api/auth/signin', { data: kit })).ok()).toBeTruthy();
  const prof = await page.request.put('/api/me/profile', {
    data: { name: nick, roll: `22BD1A05${String(40 + next).padStart(2, '0')}`, nickname: nick, avatar: { shape: 'blob', color: 'sky', eyes: 'wide', mouth: 'grin', top: 'none', extra: 'none' } },
  });
  expect(prof.ok()).toBeTruthy();
  return page;
}

/** Best effort: a missing state skips its screenshot, it never fails the run. */
async function shot(page: Page, name: string, fullPage = false) {
  try {
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${SHOT}/${name}.png`, fullPage });
  } catch {
    /* page went away: skip */
  }
}

async function soft(step: () => Promise<unknown>) {
  try {
    await step();
  } catch {
    /* a state that is not reachable with this data: skip */
  }
}

test.describe.serial('screenshot tour', () => {
  test.beforeAll(async ({ playwright }, info) => {
    baseURL = String(info.project.use.baseURL);
    admin = await playwright.request.newContext({ baseURL });
    expect((await admin.post('/api/admin/session', { data: { pin: '2468' } })).ok()).toBeTruthy();
    kits = (await api<{ kits: { kitId: string; password: string }[] }>('POST', '/api/admin/kits', { mode: 'blank', count: 8 })).kits;
  });

  test('console: every panel', async ({ browser }) => {
    test.setTimeout(180_000);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL });
    const page = await ctx.newPage();
    expect((await page.request.post('/api/admin/session', { data: { pin: '2468' } })).ok()).toBeTruthy();
    for (const p of ['kits', 'projector', 'schedule', 'attendance', 'alerts', 'polls', 'drops', 'hunt', 'morse', 'arcade', 'leaderboard', 'reactions', 'stalls', 'recap']) {
      await soft(() => page.goto(`/admin/${p}`));
      await shot(page, `console-${p}-1280`);
    }
    await ctx.close();
  });

  test('projector: every scene', async ({ browser }) => {
    test.setTimeout(180_000);
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, baseURL });
    const page = await ctx.newPage();
    await page.request.post('/api/screen/session', { data: { pin: '1357' } });
    for (const id of ['join', 'schedule', 'attendance', 'polls', 'hunt', 'morse', 'arcade', 'drops', 'leaderboard', 'recap']) {
      await soft(() => api('POST', '/api/admin/screen/pin', { sceneId: id }));
      await soft(() => page.goto('/screen'));
      await page.waitForTimeout(1200);
      await shot(page, `projector-${id}-1920`);
    }
    await soft(() => api('POST', '/api/admin/screen/pin', { sceneId: null }));
    await ctx.close();
  });

  test('phone: every page', async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await attendee(browser);
    const trails = await page.request.get('/api/hunt/trails').then((r) => r.json()).catch(() => null) as { trails?: { id: number }[] } | null;
    const pages: [string, string][] = [
      ['home', '/'],
      ['schedule', '/schedule'],
      ['polls', '/polls'],
      ['attendance', '/checkin'],
      ['hunt', '/hunt'],
      ['hunt-trail', `/hunt/t/${trails?.trails?.[0]?.id ?? 1}`],
      ['morse', '/morse'],
      ['arcade', '/arcade'],
      ['stalls', '/wallet'],
      ['stalls-qr', '/wallet/qr'],
      ['stickers', '/stickers'],
      ['leaderboard', '/leaderboard'],
      ['recap', '/recap'],
    ];
    for (const [name, path] of pages) {
      await soft(() => page.goto(path));
      await shot(page, `${name}-page-390`);
    }
    await soft(() => page.goto('/'));
    await page.waitForTimeout(800);
    await shot(page, 'home-full-390', true);
    await soft(async () => {
      await page.goto('/morse');
      await page.getByRole('tab', { name: 'practice' }).click();
    });
    await shot(page, 'morse-practice-390');
    await page.context().close();
  });

  test('games: how-to, a miss and a result', async ({ browser }) => {
    test.setTimeout(420_000);
    const page = await attendee(browser);
    // the classic cabinets: the how-to card before the coin goes in
    for (const [game, name] of [
      ['reaction', 'lagspike'],
      ['hexbin', 'baserush'],
      ['memory', 'echo'],
    ] as const) {
      await soft(() => page.goto(`/arcade/${game}`));
      await shot(page, `arcade-${name}-howto-390`);
    }
    // lag spike: tapping before the screen says NOW is a miss; waiting for it gives a time
    await soft(async () => {
      await page.goto('/arcade/reaction');
      await page.getByRole('button', { name: 'insert coin' }).click();
      await page.locator('button', { hasText: 'tap to start' }).dispatchEvent('pointerdown');
      await page.waitForTimeout(250);
      await page.locator('button').filter({ hasText: /wait|hold|not yet|tap/i }).first().dispatchEvent('pointerdown');
    });
    await shot(page, 'arcade-lagspike-miss-390');
    await soft(async () => {
      await page.goto('/arcade/reaction');
      await page.getByRole('button', { name: 'insert coin' }).click();
      await page.locator('button', { hasText: 'tap to start' }).dispatchEvent('pointerdown');
      const now = page.locator('button', { hasText: 'NOW!' });
      await now.waitFor({ timeout: 8000 });
      await now.dispatchEvent('pointerdown');
    });
    await shot(page, 'arcade-lagspike-result-390');
    // base rush: a wrong answer, then the run ends
    await soft(async () => {
      await page.goto('/arcade/hexbin');
      await page.getByRole('button', { name: 'insert coin' }).click();
      await expect(page.getByText(/^to (binary|decimal|hex)$/)).toBeVisible({ timeout: 5000 });
      await page.locator('input').first().fill('zz');
      await page.keyboard.press('Enter');
    });
    await shot(page, 'arcade-baserush-miss-390');
    // echo: watch, then a wrong pad
    await soft(async () => {
      await page.goto('/arcade/memory');
      await page.getByRole('button', { name: 'insert coin' }).click();
      await expect(page.getByText('watch...')).toBeVisible({ timeout: 5000 });
      await shot(page, 'arcade-echo-watch-390');
      await page.waitForTimeout(4000);
      await page.locator('button[aria-label*="pad"], button[class*="pad"]').first().dispatchEvent('pointerdown');
    });
    await shot(page, 'arcade-echo-miss-390');
    // the puzzle hour: the round-1 games (the rounds spec released round 1)
    for (const [path, name] of [
      ['packet', 'packet'],
      ['patch', 'patch'],
      ['pixels', 'pixels'],
    ] as const) {
      await soft(() => page.goto(`/arcade/${path}`));
      await shot(page, `arcade-${name}-howto-390`);
    }
    await soft(async () => {
      await page.goto('/arcade/packet');
      await page.getByRole('button', { name: 'send' }).click();
      await expect(page.getByText(/no arrow set/)).toBeVisible({ timeout: 10_000 });
    });
    await shot(page, 'arcade-packet-miss-390');
    await soft(async () => {
      await page.getByRole('button', { name: /turn the arrow at J1/ }).click();
      await page.getByRole('button', { name: 'send' }).click();
      await expect(page.getByText('cracked', { exact: true })).toBeVisible({ timeout: 10_000 });
    });
    await shot(page, 'arcade-packet-win-390');
    await soft(() => page.getByRole('button', { name: 'stick it in' }).click({ timeout: 2000 }));
    await soft(async () => {
      await page.goto('/arcade/patch');
      await page.getByRole('button', { name: /^card 1:/ }).click();
      await page.getByRole('button', { name: /^turn left$/ }).click();
      await page.getByRole('button', { name: 'run tests' }).click();
      await expect(page.getByText(/bumped the wall|battery went flat/)).toBeVisible({ timeout: 15_000 });
    });
    await shot(page, 'arcade-patch-miss-390');
    await soft(async () => {
      await page.getByRole('button', { name: 'undo patch' }).click();
      await page.getByRole('button', { name: /^card 3:/ }).click();
      await page.getByRole('button', { name: /^turn right$/ }).click();
      await page.getByRole('button', { name: 'run tests' }).click();
      await expect(page.getByText('cracked', { exact: true })).toBeVisible({ timeout: 15_000 });
    });
    await shot(page, 'arcade-patch-win-390');
    await soft(() => page.getByRole('button', { name: 'stick it in' }).click({ timeout: 2000 }));
    await soft(async () => {
      await page.goto('/arcade/pixels');
      await page.getByRole('gridcell', { name: /^A1,/ }).click();
      await page.getByRole('button', { name: 'check the picture' }).click();
      await expect(page.getByText(/still off|were wrong/)).toBeVisible({ timeout: 8000 });
    });
    await shot(page, 'arcade-pixels-miss-390');
    await soft(async () => {
      await page.getByRole('gridcell', { name: /^A1,/ }).click();
      await page.getByRole('gridcell', { name: /^B3,/ }).click();
      await page.getByRole('button', { name: 'check the picture' }).click();
      await expect(page.getByText("it's a smiley!")).toBeVisible({ timeout: 8000 });
    });
    await shot(page, 'arcade-pixels-win-390');
    await soft(() => page.goto('/arcade'));
    await shot(page, 'arcade-hub-after-390');
    await page.context().close();
  });
});
