// Polish pass: drives the interactive bits of the non-trail features and saves screenshots to docs/screens/polish-*.png.
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } as const;
const SMALL = { viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } as const;
const SHOT = 'docs/screens';

let admin: APIRequestContext;
let kits: { kitId: string; password: string }[] = [];
let baseURL = '';
let next = 0;

async function api<T = unknown>(method: 'GET' | 'POST' | 'PUT', path: string, data?: unknown): Promise<T> {
  const r = await admin.fetch(path, { method, data: data as object | undefined });
  expect(r.ok(), `${method} ${path}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()) as T;
}

async function attendee(browser: Browser, opts: typeof PHONE | typeof SMALL = PHONE): Promise<Page> {
  const ctx = await browser.newContext({ ...opts, baseURL });
  const page = await ctx.newPage();
  const kit = kits[next++]!;
  expect((await page.request.post('/api/auth/signin', { data: kit })).ok()).toBeTruthy();
  const prof = await page.request.put('/api/me/profile', {
    data: { name: `Polish ${next}`, roll: `P${next}`, nickname: `polish${next}`, avatar: { shape: 'blob', color: 'lime', eyes: 'wide', mouth: 'grin', top: 'none', extra: 'none' } },
  });
  expect(prof.ok()).toBeTruthy();
  return page;
}

async function projector(browser: Browser, sceneId: string | null): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, baseURL });
  const page = await ctx.newPage();
  await page.request.post('/api/screen/session', { data: { pin: '1357' } });
  await api('POST', '/api/admin/screen/pin', { sceneId });
  await page.goto('/screen');
  return page;
}

test.describe.serial('polish', () => {
  test.beforeAll(async ({ playwright }, info) => {
    baseURL = String(info.project.use.baseURL);
    admin = await playwright.request.newContext({ baseURL });
    expect((await admin.post('/api/admin/session', { data: { pin: '2468' } })).ok()).toBeTruthy();
    kits = (await api<{ kits: { kitId: string; password: string }[] }>('POST', '/api/admin/kits', { mode: 'blank', count: 20 })).kits;
  });

  test('schedule: delay shows a +10 marker, started shows done stamps', async ({ browser }) => {
    // the suite shares one server: start from an empty schedule whatever ran before (play.spec starts activities early)
    await api('POST', '/api/schedule/reset', { confirm: 'reset schedule' });
    const t0 = Date.now();
    await api('POST', '/api/schedule', { title: 'opening jam', startAt: t0 - 600_000, endAt: t0 + 1_800_000, location: 'hall', kind: 'talk' });
    await api('POST', '/api/schedule', { title: 'chai break', startAt: t0 + 2_000_000, endAt: t0 + 2_600_000, location: 'atrium', kind: 'break' });
    const st = await api<{ activities: { id: number; title: string }[] }>('POST', '/api/schedule', { title: 'the big poll', blurb: 'vote, then watch the bars race.', startAt: t0 + 3_000_000, endAt: t0 + 4_500_000, highlight: true, link: '/polls', kind: 'poll' });
    const big = st.activities.find((a) => a.title === 'the big poll')!.id;
    const page = await attendee(browser);
    await page.goto('/');
    await expect(page.getByText('happening now')).toBeVisible();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOT}/polish-schedule-home-390.png` });
    await page.goto('/schedule');
    await expect(page.getByRole('heading', { name: 'the afternoon' })).toBeVisible();
    await api('POST', `/api/schedule/${big}/delay`, { minutes: 10 });
    await expect(page.getByText('+10', { exact: true }).first()).toBeVisible({ timeout: 4000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOT}/polish-schedule-delay-390.png` });
    await page.context().close();
    const small = await attendee(browser, SMALL);
    await small.goto('/schedule');
    await small.waitForTimeout(1200);
    await small.screenshot({ path: `${SHOT}/polish-schedule-timeline-360.png` });
    await small.context().close();
  });

  test('alerts: a banner flies in as tape and can be swiped away', async ({ browser }) => {
    const page = await attendee(browser);
    await page.goto('/');
    await page.waitForTimeout(1500);
    await api('POST', '/api/alerts/announce', { title: 'chai is out', body: 'samosas at the atrium. go go go.', push: false });
    const banner = page.getByRole('status').filter({ hasText: 'chai is out' });
    await expect(banner).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${SHOT}/polish-alerts-banner-390.png` });
    await banner.getByRole('button', { name: 'dismiss' }).click();
    await expect(banner).toHaveCount(0, { timeout: 3000 });
    await page.context().close();
  });

  test('polls: rating marker, quiz game show, projector', async ({ browser }) => {
    const rate = await api<{ poll: { id: number } }>('POST', '/api/polls/admin', { kind: 'rating', question: 'how was the talk?', scale: { min: 1, max: 5, style: 'slider', lowLabel: 'meh', highLabel: 'wow' } });
    const page = await attendee(browser);
    await page.goto('/');
    await page.waitForTimeout(1500);
    await api('POST', `/api/polls/admin/${rate.poll.id}/launch`, { closeCurrent: true });
    const dialog = page.getByRole('dialog', { name: 'live poll' });
    await expect(dialog).toBeVisible({ timeout: 5000 });
    const slider = dialog.getByRole('slider');
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(slider).toHaveAttribute('aria-valuenow', '5');
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOT}/polish-polls-rating-390.png` });
    await dialog.getByRole('button', { name: "that's my number" }).click();
    await page.getByRole('button', { name: 'stick it in' }).click();
    await page.waitForTimeout(1600);
    await page.screenshot({ path: `${SHOT}/polish-polls-results-390.png` });
    await dialog.getByRole('button', { name: 'hide poll' }).click();
    await api('POST', `/api/polls/admin/${rate.poll.id}/close`, {});

    const quiz = await api<{ poll: { id: number } }>('POST', '/api/polls/admin', { kind: 'quiz', question: 'which port is https?', options: [{ label: '80' }, { label: '443' }, { label: '8080' }, { label: '22' }], correct: 1, durationMs: 20_000 });
    await api('POST', `/api/polls/admin/${quiz.poll.id}/launch`, { closeCurrent: true });
    const proj = await projector(browser, 'polls');
    const lead = page.getByText('ready?');
    await expect(lead).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: `${SHOT}/polish-polls-quiz-leadin-390.png` });
    const pick = page.getByRole('button', { name: /443/ });
    await expect(pick).toBeVisible({ timeout: 8000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOT}/polish-polls-quiz-390.png` });
    await proj.screenshot({ path: `${SHOT}/polish-polls-projector-quiz-1080.png` });
    await pick.click();
    await expect(page.getByText('locked in').first()).toBeVisible({ timeout: 4000 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${SHOT}/polish-polls-locked-390.png` });
    await api('POST', `/api/polls/admin/${quiz.poll.id}/close`, {});
    await proj.waitForTimeout(1500);
    await proj.screenshot({ path: `${SHOT}/polish-polls-projector-drumroll-1080.png` });
    await api('POST', `/api/polls/admin/${quiz.poll.id}/reveal`, {});
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${SHOT}/polish-polls-reveal-390.png` });
    await proj.waitForTimeout(2500);
    await proj.screenshot({ path: `${SHOT}/polish-polls-projector-reveal-1080.png` });
    await proj.context().close();
    await page.context().close();
  });

  test('attendance: wrong code nopes, right code slaps the sticker, projector code', async ({ browser }) => {
    const st = await api<{ activities: { id: number }[] }>('GET', '/api/schedule');
    const id = String(st.activities[0]!.id);
    await api('POST', '/api/attendance/admin/open', { activityId: id });
    const code = (await api<{ open: { activityId: string; code: string }[] }>('GET', '/api/attendance/screen')).open.find((o) => o.activityId === id)!.code;
    const page = await attendee(browser);
    await page.goto('/checkin');
    await page.getByLabel('code character 1').fill(code.split('').reverse().join('') === code ? code.slice(1) + code[0] : code.split('').reverse().join(''));
    await expect(page.getByText('nope', { exact: true })).toBeVisible({ timeout: 4000 });
    await page.screenshot({ path: `${SHOT}/polish-attendance-nope-390.png` });
    await page.waitForTimeout(1200);
    await page.getByLabel('code character 1').fill(code);
    await expect(page.getByText("you're")).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(1800);
    await page.screenshot({ path: `${SHOT}/polish-attendance-success-390.png` });
    await page.context().close();
    const proj = await projector(browser, 'attendance');
    await proj.waitForTimeout(2500);
    await proj.screenshot({ path: `${SHOT}/polish-attendance-projector-1080.png` });
    await proj.context().close();
  });

  test('leaderboard: phone card, then the projector reveal', async ({ browser }) => {
    const pages: Page[] = [];
    for (let i = 0; i < 6; i++) pages.push(await attendee(browser));
    const st = await api<{ activities: { id: number }[] }>('GET', '/api/schedule');
    const act = String(st.activities[0]!.id);
    const code = (await api<{ open: { activityId: string; code: string }[] }>('GET', '/api/attendance/screen')).open.find((o) => o.activityId === act)?.code;
    if (code) for (const p of pages.slice(0, 3)) await p.request.post('/api/attendance/checkin', { data: { code } });
    const me = pages[0]!;
    await me.goto('/leaderboard');
    await expect(me.getByText('you are')).toBeVisible();
    await me.waitForTimeout(1800);
    await me.screenshot({ path: `${SHOT}/polish-leaderboard-390.png` });
    await api('POST', '/api/leaderboard/admin/freeze', { topN: 5, stepMs: 1500, suspenseMs: 2500, hideTop: true });
    await expect(me.getByText('your points still count')).toBeVisible({ timeout: 5000 });
    await me.screenshot({ path: `${SHOT}/polish-leaderboard-frozen-390.png` });
    const proj = await projector(browser, 'leaderboard');
    await proj.waitForTimeout(1500);
    await proj.screenshot({ path: `${SHOT}/polish-leaderboard-projector-frozen-1080.png` });
    await api('POST', '/api/leaderboard/admin/reveal', {});
    await proj.waitForTimeout(4500);
    await proj.screenshot({ path: `${SHOT}/polish-leaderboard-projector-reveal-1080.png` });
    await expect(proj.getByText('drum roll...')).toBeVisible({ timeout: 12_000 });
    await proj.screenshot({ path: `${SHOT}/polish-leaderboard-projector-drumroll-1080.png` });
    await expect(proj.getByText('your champion')).toBeVisible({ timeout: 12_000 });
    await proj.waitForTimeout(1500);
    await proj.screenshot({ path: `${SHOT}/polish-leaderboard-projector-champion-1080.png` });
    await proj.context().close();
    for (const p of pages) await p.context().close();
  });

  test('arcade: cabinets, lag spike field, base rush, echo', async ({ browser }) => {
    const page = await attendee(browser);
    await page.goto('/arcade');
    await expect(page.getByText('insert coin').first()).toBeVisible();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${SHOT}/polish-arcade-hub-390.png` });

    await page.goto('/arcade/reaction');
    await page.getByRole('button', { name: 'insert coin' }).click();
    await page.locator('button', { hasText: 'tap to start' }).dispatchEvent('pointerdown');
    const now = page.locator('button', { hasText: 'NOW!' });
    await now.waitFor({ timeout: 8000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOT}/polish-arcade-lagspike-green-390.png` });
    await now.dispatchEvent('pointerdown');
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOT}/polish-arcade-lagspike-ms-390.png` });
    await page.getByRole('button', { name: 'quit' }).click();

    await page.goto('/arcade/hexbin');
    await page.getByRole('button', { name: 'insert coin' }).click();
    await expect(page.getByText(/^to (binary|decimal|hex)$/)).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOT}/polish-arcade-baserush-390.png` });
    await page.getByRole('button', { name: 'quit' }).click();

    await page.goto('/arcade/memory');
    await page.getByRole('button', { name: 'insert coin' }).click();
    await expect(page.getByText('watch...')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${SHOT}/polish-arcade-echo-390.png` });
    await page.getByRole('button', { name: 'quit' }).click();
    await page.context().close();

    const small = await attendee(browser, SMALL);
    await small.goto('/arcade/hexbin');
    await small.getByRole('button', { name: 'insert coin' }).click();
    await expect(small.getByText(/^to (binary|decimal|hex)$/)).toBeVisible({ timeout: 5000 });
    await small.waitForTimeout(600);
    await small.screenshot({ path: `${SHOT}/polish-arcade-baserush-360.png` });
    await small.context().close();
  });

  test('reactions: taps float and the combo counts', async ({ browser }) => {
    const page = await attendee(browser);
    await page.goto('/');
    await page.waitForTimeout(1500);
    const pad = page.getByRole('button', { name: 'send fire' });
    await pad.scrollIntoViewIfNeeded();
    for (let i = 0; i < 4; i++) {
      await pad.dispatchEvent('pointerdown');
      await page.waitForTimeout(120);
    }
    await expect(page.getByText('x4')).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOT}/polish-reactions-390.png` });
    const proj = await projector(browser, 'schedule');
    for (let i = 0; i < 6; i++) await pad.dispatchEvent('pointerdown');
    await proj.waitForTimeout(2500);
    await proj.screenshot({ path: `${SHOT}/polish-reactions-projector-1080.png` });
    await proj.context().close();
    await page.context().close();
  });
});
