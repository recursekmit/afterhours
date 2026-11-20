// Quick session end to end (E2E_PORT=4903): the console turns pasted text into a live pop quiz, two phones answer,
// the reveal lands on the projector; a code drop fires from the phone-sized speaker view; and we time
// "open the panel" to "live" for three templates. Screenshots go to docs/screens/quick-*.png.
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } as const;
const SHOT = 'docs/screens';

let admin: APIRequestContext;
let kits: { kitId: string; password: string }[] = [];
let baseURL = '';
let next = 0;
const timings: Record<string, number> = {};

async function api<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, data?: unknown): Promise<T> {
  const r = await admin.fetch(path, { method, data: data as object | undefined });
  expect(r.ok(), `${method} ${path}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()) as T;
}

async function attendee(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ ...PHONE, baseURL });
  const page = await ctx.newPage();
  const kit = kits[next++]!;
  expect((await page.request.post('/api/auth/signin', { data: kit })).ok()).toBeTruthy();
  const prof = await page.request.put('/api/me/profile', {
    data: { name: `Quick ${next}`, roll: `Q${next}`, nickname: `quick${next}`, avatar: { shape: 'blob', color: 'sky', eyes: 'wide', mouth: 'grin', top: 'none', extra: 'none' } },
  });
  expect(prof.ok()).toBeTruthy();
  return page;
}

async function projector(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, baseURL });
  const page = await ctx.newPage();
  await page.request.post('/api/screen/session', { data: { pin: '1357' } });
  await page.goto('/screen');
  return page;
}

async function console1280(browser: Browser, width = 1280, height = 900): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height }, baseURL });
  expect((await ctx.request.post('/api/admin/session', { data: { pin: '2468' } })).ok()).toBeTruthy();
  return ctx.newPage();
}

async function endEverything() {
  const polls = await api<{ polls: { poll: { id: number; status: string } }[] }>('GET', '/api/polls/admin');
  for (const p of polls.polls.filter((x) => x.poll.status === 'live')) await api('POST', `/api/polls/admin/${p.poll.id}/close`, {});
  const drops = await api<{ drops: { id: number; status: string }[] }>('GET', '/api/drops/admin');
  for (const d of drops.drops.filter((x) => x.status === 'live')) await api('POST', `/api/drops/admin/${d.id}/cancel`, {});
}

test.describe.serial('quick session', () => {
  test.beforeAll(async ({ playwright }, info) => {
    baseURL = String(info.project.use.baseURL);
    admin = await playwright.request.newContext({ baseURL });
    expect((await admin.post('/api/admin/session', { data: { pin: '2468' } })).ok()).toBeTruthy();
    kits = (await api<{ kits: { kitId: string; password: string }[] }>('POST', '/api/admin/kits', { mode: 'blank', count: 6 })).kits;
    await api('POST', '/api/admin/screen/pin', { sceneId: null });
    await api('POST', '/api/schedule/reset', { confirm: 'reset schedule', reseed: false });
  });

  test('the panel is the first item in the console nav; the gallery and every form', async ({ browser }) => {
    const con = await console1280(browser);
    await con.goto('/admin/quick');
    await expect(con.getByRole('heading', { name: 'quick session' })).toBeVisible();
    const nav = con.getByRole('navigation', { name: 'console' }).getByRole('link');
    await expect(nav.first()).toHaveText(/quick session/);
    await expect(con.getByRole('list', { name: 'templates' }).getByRole('button')).toHaveCount(10);
    await con.waitForTimeout(400);
    await con.screenshot({ path: `${SHOT}/quick-console-1280.png`, fullPage: true });
    for (const id of ['instant poll', 'word cloud', 'pop quiz', 'code drop', 'speed question', 'everyone reacts', 'morse speed round', 'check-in', 'mini hunt', 'announcement']) {
      await con.getByRole('button', { name: id, exact: true }).click();
      await expect(con.getByRole('button', { name: /go live now/ })).toBeVisible();
      await con.waitForTimeout(250);
      await con.screenshot({ path: `${SHOT}/quick-form-${id.replace(/[^a-z]+/g, '-')}-1280.png` });
      await con.keyboard.press('Escape');
      await expect(con.getByRole('list', { name: 'templates' })).toBeVisible();
    }
    await con.context().close();
  });

  test('pop quiz from pasted text: live, two phones answer, the reveal shows on the projector', async ({ browser }) => {
    const phoneA = await attendee(browser);
    const phoneB = await attendee(browser);
    await phoneA.goto('/');
    await phoneB.goto('/');
    const screen = await projector(browser);
    const con = await console1280(browser);

    const t0 = Date.now();
    await con.goto('/admin/quick');
    await expect(con.getByRole('heading', { name: 'quick session' })).toBeVisible();
    await con.getByRole('button', { name: 'pop quiz', exact: true }).click();
    await con.getByLabel(/questions: a blank line/).fill('Which port is https?\n*443\n80\n8080\n\nWhat does CSS stand for?\n*cascading style sheets\ncomputer style system');
    await con.getByLabel('seconds per question').fill('30');
    await con.getByLabel('for which speaker or session').fill('Dr Rao');
    await expect(con.getByRole('list', { name: 'preview' })).toBeVisible();
    await con.screenshot({ path: `${SHOT}/quick-quiz-filled-1280.png` });
    await con.keyboard.press('Control+Enter');
    const card = con.getByTestId('live-card').first();
    await expect(card).toContainText('Q1. Which port is https?');
    timings['pop quiz (pasted)'] = Date.now() - t0;
    await con.waitForTimeout(500);
    await con.screenshot({ path: `${SHOT}/quick-live-quiz-1280.png` });

    // the phones took over by themselves; both answer, one right and one wrong
    for (const [page, answer] of [[phoneA, /443/], [phoneB, /(^|\s)80$/]] as const) {
      const pick = page.getByRole('button', { name: answer });
      await expect(pick).toBeVisible({ timeout: 9000 });
      await pick.click();
      await expect(page.getByText('locked in').first()).toBeVisible({ timeout: 4000 });
    }
    await expect(card.getByText('voted')).toBeVisible();
    await expect(card).toContainText('2');
    await phoneA.screenshot({ path: `${SHOT}/quick-phone-quiz-390.png` });

    await card.getByRole('button', { name: 'close voting' }).click();
    await expect(card.getByRole('button', { name: 'reveal' })).toBeVisible();
    await card.getByRole('button', { name: 'reveal' }).click();
    await expect(card.getByRole('button', { name: 'next question' })).toBeVisible();
    // the projector shows the reveal: the right answer and the room's counts
    await expect(screen.getByText('Which port is https?').first()).toBeVisible({ timeout: 8000 });
    await screen.waitForTimeout(2500);
    await screen.screenshot({ path: `${SHOT}/quick-projector-reveal-1080.png` });
    await expect(screen.getByText('443').first()).toBeVisible();

    // second question, then finish
    await card.getByRole('button', { name: 'next question' }).click();
    await expect(card).toContainText('Q2. What does CSS stand for?');
    await card.getByRole('button', { name: 'end now' }).click();
    await expect(con.getByTestId('live-card').first()).toHaveAttribute('data-phase', 'done');
    await con.screenshot({ path: `${SHOT}/quick-history-1280.png`, fullPage: true });
    for (const p of [phoneA, phoneB, screen, con]) await p.context().close();
  });

  test('speaker view: a volunteer fires the code drop preset with one tap', async ({ browser }) => {
    await endEverything();
    const phone = await attendee(browser);
    await phone.goto('/');
    const sp = await console1280(browser, 390, 844);
    await sp.goto('/admin/quick/speaker');
    await expect(sp.getByRole('heading', { name: 'speaker view' })).toBeVisible();
    await sp.getByLabel('who is on stage').fill('Prof Mehta');
    await sp.waitForTimeout(300);
    await sp.screenshot({ path: `${SHOT}/quick-speaker-390.png` });
    const noSideScroll = async (page: Page) =>
      expect(await page.evaluate(() => [document.documentElement, document.querySelector('[data-testid="speaker-view"]')!].every((el) => el.scrollWidth <= el.clientWidth))).toBe(true);
    await noSideScroll(sp);
    const narrow = await console1280(browser, 360, 780);
    await narrow.goto('/admin/quick/speaker');
    await expect(narrow.getByRole('heading', { name: 'speaker view' })).toBeVisible();
    await narrow.waitForTimeout(300);
    await noSideScroll(narrow);
    await narrow.screenshot({ path: `${SHOT}/quick-speaker-360.png` });
    await narrow.context().close();
    await sp.getByRole('button', { name: 'fire first to type the code' }).click();
    const card = sp.getByTestId('live-card').first();
    await expect(card).toContainText('Prof Mehta: code drop');
    await expect(card.getByLabel('the code')).toHaveText(/^[A-Z0-9]{5}$/);
    const d = await api<{ drops: { status: string; kind: string; title: string }[] }>('GET', '/api/drops/admin');
    expect(d.drops.find((x) => x.status === 'live')).toMatchObject({ kind: 'code', title: 'Prof Mehta: code drop' });
    await expect(phone.getByRole('dialog', { name: /flash drop/ })).toBeVisible({ timeout: 8000 });
    await sp.waitForTimeout(500);
    await noSideScroll(sp);
    await sp.screenshot({ path: `${SHOT}/quick-speaker-live-390.png` });
    // a second tap of a drop while one is live explains itself and offers the way out
    await sp.getByRole('button', { name: 'fire everyone react' }).click();
    await expect(sp.getByRole('alert')).toContainText(/already live/);
    await noSideScroll(sp);
    await sp.screenshot({ path: `${SHOT}/quick-speaker-conflict-390.png` });
    await sp.getByRole('button', { name: 'close it and launch this' }).click();
    await expect(sp.getByTestId('live-card').first()).toContainText('everyone react');
    await phone.context().close();
    await sp.context().close();
  });

  test('time from opening the panel to live, three templates by keyboard', async ({ browser }) => {
    await endEverything();
    const con = await console1280(browser);
    const timeIt = async (name: string, run: () => Promise<void>) => {
      const t0 = Date.now();
      await con.goto('/admin/quick');
      await expect(con.getByRole('heading', { name: 'quick session' })).toBeVisible();
      await run();
      timings[name] = Date.now() - t0;
    };
    await timeIt('instant poll (this or that)', async () => {
      await con.getByRole('button', { name: 'instant poll', exact: true }).click();
      await con.getByRole('radio', { name: 'this or that' }).click();
      await con.getByLabel('question').fill('tabs or spaces?');
      await con.getByLabel(/the two sides/).fill('tabs\nspaces');
      await con.keyboard.press('Control+Enter');
      await expect(con.getByTestId('live-card').first()).toContainText('tabs or spaces?');
    });
    await timeIt('code drop (made-up code)', async () => {
      await con.getByRole('button', { name: 'code drop', exact: true }).click();
      await con.getByRole('button', { name: /go live now/ }).click();
      await expect(con.getByLabel('the code')).toBeVisible();
    });
    await endEverything();
    await timeIt('word cloud', async () => {
      await con.getByRole('button', { name: 'word cloud', exact: true }).click();
      await con.getByLabel('the prompt').fill('one word for this talk');
      await con.keyboard.press('Control+Enter');
      await expect(con.getByTestId('live-card').first()).toContainText('one word for this talk');
    });
    console.log('TIMINGS (ms, machine driven, incl. page load):', JSON.stringify(timings));
    await con.context().close();
  });
});
