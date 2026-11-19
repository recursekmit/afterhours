// Main flow of every feature, end to end on the built app (empty DB, set up through the console API).
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } as const;

let admin: APIRequestContext;
let kits: { kitId: string; password: string }[] = [];
let baseURL = '';

async function api<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, data?: unknown): Promise<T> {
  const r = await admin.fetch(path, { method, data: data as object | undefined });
  expect(r.ok(), `${method} ${path}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()) as T;
}

let next = 0;
async function attendee(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ ...PHONE, baseURL });
  const page = await ctx.newPage();
  const kit = kits[next++]!;
  expect((await page.request.post('/api/auth/signin', { data: kit })).ok()).toBeTruthy();
  const prof = await page.request.put('/api/me/profile', {
    data: { name: `Player ${next}`, roll: `R${next}`, nickname: `player${next}`, avatar: { shape: 'blob', color: 'sky', eyes: 'wide', mouth: 'grin', top: 'none', extra: 'none' } },
  });
  expect(prof.ok()).toBeTruthy();
  return page;
}

test.describe.serial('features', () => {
  test.beforeAll(async ({ playwright }, info) => {
    baseURL = String(info.project.use.baseURL);
    admin = await playwright.request.newContext({ baseURL });
    expect((await admin.post('/api/admin/session', { data: { pin: '2468' } })).ok()).toBeTruthy();
    const r = await api<{ kits: { kitId: string; password: string }[] }>('POST', '/api/admin/kits', { mode: 'blank', count: 12 });
    kits = r.kits;
  });

  test('schedule: now and next on home, the timeline, start from the console', async ({ browser }) => {
    const t0 = Date.now();
    await api('POST', '/api/schedule', { title: 'opening jam', startAt: t0 + 3_600_000, endAt: t0 + 5_400_000, location: 'hall' });
    const st = await api<{ activities: { id: number; title: string }[] }>('POST', '/api/schedule', { title: 'the big poll', startAt: t0 + 6_000_000, endAt: t0 + 7_000_000, highlight: true, link: '/polls' });
    const page = await attendee(browser);
    await page.goto('/');
    await expect(page.getByText('up next')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'opening jam' })).toBeVisible();
    const id = st.activities.find((a) => a.title === 'opening jam')!.id;
    await api('POST', `/api/schedule/${id}/start`, {});
    await expect(page.getByText('happening now')).toBeVisible({ timeout: 5000 });
    await page.goto('/schedule');
    await expect(page.getByRole('heading', { name: 'the afternoon' })).toBeVisible();
    await expect(page.getByText('live', { exact: true }).first()).toBeVisible();
    await page.context().close();
  });

  test('attendance: open a check-in, type the code, get the sticker', async ({ browser }) => {
    const st = await api<{ activities: { id: number }[] }>('GET', '/api/schedule');
    const id = String(st.activities[0]!.id);
    await api('POST', '/api/attendance/admin/open', { activityId: id });
    const scr = await api<{ open: { activityId: string; code: string }[] }>('GET', '/api/attendance/screen');
    const code = scr.open.find((o) => o.activityId === id)!.code;
    const page = await attendee(browser);
    await page.goto('/checkin');
    await page.getByLabel('code character 1').fill(code);
    await expect(page.getByText("you're")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('#1')).toBeVisible();
    await page.context().close();
  });

  test('polls: launch takes over the phone, vote, results race', async ({ browser }) => {
    const p = await api<{ poll: { id: number } }>('POST', '/api/polls/admin', { kind: 'single', question: 'best snack?', options: [{ label: 'samosa' }, { label: 'maggi' }] });
    const page = await attendee(browser);
    await page.goto('/');
    await page.waitForTimeout(1500);
    await api('POST', `/api/polls/admin/${p.poll.id}/launch`, { closeCurrent: true });
    const dialog = page.getByRole('dialog', { name: 'live poll' });
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await dialog.getByRole('button', { name: 'samosa' }).click();
    await expect(dialog.getByText('100%')).toBeVisible({ timeout: 5000 });
    // first vote unlocks a sticker: stick it in first
    await page.getByRole('button', { name: 'stick it in' }).click();
    await dialog.getByRole('button', { name: 'hide poll' }).click();
    await expect(page.getByText('poll is live')).toBeVisible();
    await api('POST', `/api/polls/admin/${p.poll.id}/close`, {});
    await page.context().close();
  });

  test('hunt: open, start, scan a sticker link, get the stamp', async ({ browser }) => {
    await api('POST', '/api/hunt/admin/stops', { title: 'the door', clue: 'where you came in', answers: ['door'] });
    await api('POST', '/api/hunt/admin/stops', { title: 'the end', clue: 'the stage', answers: ['stage'] });
    await api('PUT', '/api/hunt/admin/state', { status: 'open' });
    const page = await attendee(browser);
    await page.goto('/hunt');
    await page.getByRole('link', { name: /the after hours hunt/ }).click();
    await page.getByRole('button', { name: 'start my hunt' }).click();
    await expect(page.getByText(/clue 1\/\d/)).toBeVisible({ timeout: 6000 });
    const me = (await (await page.request.get('/api/hunt')).json()) as { current: { stopId: number } };
    const tok = (await api<{ stops: { id: number; token: string }[] }>('GET', '/api/hunt/admin')).stops.find((x) => x.id === me.current.stopId)!.token;
    await page.goto(`/hunt/s/${tok}`);
    await expect(page.getByText(/stamped:/)).toBeVisible({ timeout: 5000 });
    await page.context().close();
  });

  test('trails: a morse slip trail, typed reading sends you on, a decoy does not', async ({ browser }) => {
    const tr = (await api<{ trail: { id: number } }>('POST', '/api/hunt/admin/trails', { title: 'e2e slips', kind: 'morse', orderMode: 'graph' })).trail.id;
    const sets = await api<{ sets: { id: number }[] }>('POST', `/api/hunt/admin/slip-sets?trail=${tr}`, { title: 'kit', mode: 'shared' });
    const end = (await api<{ stops: { id: number }[] }>('POST', `/api/hunt/admin/stops?trail=${tr}`, { title: 'the end', clue: 'type recurse', answers: ['recurse'], finale: true })).stops.at(-1)!.id;
    const slips = await api<{ sets: { slips: { id: number }[] }[] }>('POST', `/api/hunt/admin/slip-sets/${sets.sets[0]!.id}/slips`, {
      slipNo: 1,
      label: 'start',
      readings: [
        { orientation: 'bottom', word: 'LAB', outcome: 'next', targetStopId: end },
        { orientation: 'top', word: 'NOPE', outcome: 'decoy' },
      ],
    });
    const slipId = slips.sets[0]!.slips[0]!.id;
    const admin1 = await api<{ stops: { id: number }[] }>('POST', `/api/hunt/admin/stops?trail=${tr}`, { title: 'slip 1', clue: 'scan slip 1', slipId });
    const ids = admin1.stops.map((x) => x.id);
    await api('PUT', `/api/hunt/admin/order?trail=${tr}`, { ids: [ids.at(-1)!, ...ids.slice(0, -1)] });
    await api('PUT', `/api/hunt/admin/state?trail=${tr}`, { status: 'open' });
    const page = await attendee(browser);
    await page.goto('/hunt');
    await page.getByRole('link', { name: /e2e slips/ }).click();
    await page.getByRole('button', { name: 'start this trail' }).click();
    const box = page.getByLabel('or type the word on the bottom edge');
    await box.waitFor({ timeout: 8000 });
    await box.fill('nope');
    await page.getByRole('button', { name: 'read it' }).click();
    await expect(page.getByText('decoy!')).toBeVisible();
    await box.fill('lab');
    await page.getByRole('button', { name: 'read it' }).click();
    await expect(page.getByText('onwards')).toBeVisible();
    await expect(page.getByText('type recurse')).toBeVisible({ timeout: 6000 });
    await page.context().close();
  });

  test('leaderboard: you are #N, freeze shows ???', async ({ browser }) => {
    const page = await attendee(browser);
    await page.goto('/leaderboard');
    await expect(page.getByText('you are')).toBeVisible();
    await api('POST', '/api/leaderboard/admin/freeze', { topN: 3, hideTop: true });
    await expect(page.getByText(/frozen for the big reveal/)).toBeVisible({ timeout: 5000 });
    await api('POST', '/api/leaderboard/admin/unfreeze', {});
    await page.context().close();
  });

  test('morse: ladder, decode round plays and takes a guess', async ({ browser }) => {
    await api('PUT', '/api/morse/admin/enabled', { enabled: true });
    const page = await attendee(browser);
    await page.goto('/morse');
    await page.locator('button', { hasText: 'dit dit' }).first().click();
    await page.getByRole('button', { name: /play the word/ }).click();
    await page.getByLabel('your guess character 1').fill('ZZZZZZ');
    await page.getByRole('button', { name: "that's my answer" }).click();
    await expect(page.getByText(/not quite|round over|nice one|level cleared/)).toBeVisible({ timeout: 5000 });
    await page.context().close();
  });

  test('arcade: a full run of lag spike', async ({ browser }) => {
    const page = await attendee(browser);
    await page.goto('/arcade/reaction');
    await page.getByRole('button', { name: 'insert coin' }).click();
    await page.locator('button', { hasText: 'tap to start' }).dispatchEvent('pointerdown');
    for (let i = 0; i < 5; i++) {
      const now = page.locator('button', { hasText: 'NOW!' });
      await now.waitFor({ timeout: 8000 });
      await page.waitForTimeout(250);
      await now.dispatchEvent('pointerdown');
    }
    await expect(page.getByText(/better than \d+% of players/)).toBeVisible({ timeout: 6000 });
    await page.context().close();
  });

  test('projector rotates real scenes and the console panels load', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL });
    const page = await ctx.newPage();
    await page.request.post('/api/admin/session', { data: { pin: '2468' } });
    await page.request.post('/api/screen/session', { data: { pin: '1357' } });
    for (const [path, text] of [
      ['/admin/schedule', 'the afternoon'],
      ['/admin/alerts', 'say something to everyone'],
      ['/admin/attendance', 'event attendance'],
      ['/admin/polls', 'all polls'],
      ['/admin/hunt', 'stops'],
      ['/admin/leaderboard', 'the big reveal'],
      ['/admin/morse', 'speed round'],
      ['/admin/arcade', 'danger zone'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: text }).first()).toBeVisible();
    }
    await api('POST', '/api/admin/screen/pin', { sceneId: 'schedule' });
    await page.goto('/screen');
    await expect(page.getByText(/happening now|right now|up next/).first()).toBeVisible({ timeout: 8000 });
    await api('POST', '/api/admin/screen/pin', { sceneId: null });
    await ctx.close();
  });
});
