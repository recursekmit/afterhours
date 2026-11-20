// Drops end to end: the console fires a library code drop, phones get the takeover (siren, 3-2-1, type the
// code) and the projector shows the code with a live counter; then a speed question, an everyone-wins room
// drop and a golden slip opened from its QR link. Screenshots go to docs/screens/drops-*.png.
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
  const ctx = await browser.newContext({ ...PHONE, baseURL });
  const page = await ctx.newPage();
  const kit = kits[next++]!;
  expect((await page.request.post('/api/auth/signin', { data: kit })).ok()).toBeTruthy();
  const prof = await page.request.put('/api/me/profile', {
    data: { name: `Drop ${next}`, roll: `D${next}`, nickname: `dropper${next}`, avatar: { shape: 'blob', color: 'sky', eyes: 'wide', mouth: 'grin', top: 'none', extra: 'none' } },
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

/** A top spot unlocks a sticker: its celebration pops over everything; stick it in. */
async function stick(page: Page) {
  const btn = page.getByRole('button', { name: 'stick it in' });
  await expect(btn).toBeVisible({ timeout: 6000 });
  await btn.click();
  await expect(btn).toBeHidden();
}

type AdminState = { drops: { id: number; status: string; title: string }[] };

async function cancelLive() {
  const st = await api<AdminState>('GET', '/api/drops/admin');
  for (const d of st.drops.filter((x) => x.status === 'live')) await api('POST', `/api/drops/admin/${d.id}/cancel`, {});
}

test.describe.serial('drops', () => {
  test.beforeAll(async ({ playwright }, info) => {
    baseURL = String(info.project.use.baseURL);
    admin = await playwright.request.newContext({ baseURL });
    expect((await admin.post('/api/admin/session', { data: { pin: '2468' } })).ok()).toBeTruthy();
    kits = (await api<{ kits: { kitId: string; password: string }[] }>('POST', '/api/admin/kits', { mode: 'blank', count: 6 })).kits;
    await api('POST', '/api/admin/screen/pin', { sceneId: null });
    await api('POST', '/api/drops/admin/reset', { confirm: 'reset drops' });
    await api('PATCH', '/api/drops/admin/settings', { feedMuted: false, hypeEnabled: true, hypeAuto: false });
  });

  test('code drop: console fires it, the phone types the code first, the projector counts', async ({ browser }) => {
    const phone = await attendee(browser);
    const other = await attendee(browser);
    await phone.goto('/');
    await other.goto('/');
    const screen = await projector(browser);
    await api('POST', '/api/drops/admin/feed', { text: 'chai is out at the atrium' });

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL });
    const con = await ctx.newPage();
    await con.goto('/admin');
    await con.getByLabel('PIN').fill('2468');
    await con.keyboard.press('Enter');
    await expect(con.getByRole('heading', { name: 'kits and sign-ins' })).toBeVisible();
    await con.goto('/admin/drops');
    await expect(con.getByRole('heading', { name: 'drop library' })).toBeVisible();
    await con.waitForTimeout(500);
    await con.screenshot({ path: `${SHOT}/drops-console-1280.png` });
    const card = con.locator('li', { hasText: 'flash drop: say the magic word' });
    await card.getByRole('button', { name: 'fire' }).click();

    // the takeover lands with a 3-2-1
    const take = phone.getByRole('dialog', { name: /flash drop/ });
    await expect(take).toBeVisible({ timeout: 6000 });
    await expect(take.locator('[aria-live="assertive"]')).toBeVisible();
    await phone.screenshot({ path: `${SHOT}/drops-phone-lead-390.png` });
    await expect(screen.getByText('SUDO', { exact: true })).toBeVisible({ timeout: 8000 });
    // claims open: a wrong one shakes, the right one wins
    const input = take.getByLabel('the code on the big screen');
    await expect(input).toBeVisible({ timeout: 6000 });
    await phone.waitForTimeout(300);
    await phone.screenshot({ path: `${SHOT}/drops-phone-code-390.png` });
    await input.fill('SUDOO');
    await take.getByRole('button', { name: 'send' }).click();
    await expect(take.getByText(/not it\. 5 tries left/)).toBeVisible();
    await input.fill('sudo');
    await take.getByRole('button', { name: 'send' }).click();
    await expect(take.getByText('first! +15')).toBeVisible();
    await expect(take.getByText('1/20 claimed')).toBeVisible();
    await stick(phone);
    await phone.waitForTimeout(600);
    await phone.screenshot({ path: `${SHOT}/drops-phone-won-390.png` });
    // the second phone takes the second spot
    const t2 = other.getByRole('dialog', { name: /flash drop/ });
    await t2.getByLabel('the code on the big screen').fill('SUDO');
    await t2.getByRole('button', { name: 'send' }).click();
    await expect(t2.getByText('#2! +15')).toBeVisible();
    await stick(other);
    await expect(screen.getByText('2/20 claimed')).toBeVisible({ timeout: 5000 });
    await screen.waitForTimeout(800);
    await screen.screenshot({ path: `${SHOT}/drops-projector-code-1080.png` });
    await con.waitForTimeout(800);
    await con.screenshot({ path: `${SHOT}/drops-console-live-1280.png` });

    // the organiser calls it off early: phones and the projector say so, winners keep their points
    await cancelLive();
    await expect(take.getByText('the organisers called this one off. your points stay.')).toBeVisible({ timeout: 6000 });
    await expect(screen.getByText('called off by the organisers.')).toBeVisible({ timeout: 6000 });
    await take.getByRole('button', { name: 'back to it' }).click();
    await expect(take).toBeHidden();

    // points landed once
    const lb = (await (await phone.request.get('/api/leaderboard')).json()) as { me: { liveTotal: number } };
    expect(lb.me.liveTotal).toBe(35);

    // the home strip: streak chip and the feed, in the page flow
    await phone.reload();
    await expect(phone.getByText('cracked the code first')).toBeVisible({ timeout: 8000 });
    await phone.getByLabel(/streak:/).scrollIntoViewIfNeeded();
    await phone.waitForTimeout(500);
    await phone.screenshot({ path: `${SHOT}/drops-home-strip-390.png` });
    await screen.waitForTimeout(13_000);
    await expect(screen.locator('li', { hasText: 'cracked the code first' })).toBeVisible();
    await screen.screenshot({ path: `${SHOT}/drops-projector-ticker-1080.png` });
    await ctx.close();
    await screen.context().close();
    await other.context().close();
    await phone.context().close();
  });

  test('speed question: first right answer wins big', async ({ browser }) => {
    const phone = await attendee(browser);
    await phone.goto('/');
    const screen = await projector(browser);
    await api('POST', '/api/drops/admin', {
      title: 'speed round: http 418',
      blurb: 'first right answer takes the big points.',
      durationSec: 10,
      config: { kind: 'speed', question: 'what does http status 418 mean?', choices: ["i'm a teapot", 'not found', 'too many requests', 'gone'], correct: 0, topPoints: 30, floorPoints: 5 },
      when: 'now',
    });
    const take = phone.getByRole('dialog', { name: /flash drop/ });
    await expect(take.getByRole('button', { name: "i'm a teapot" })).toBeVisible({ timeout: 8000 });
    await expect(screen.getByText('what does http status 418 mean?')).toBeVisible({ timeout: 8000 });
    await screen.waitForTimeout(500);
    await screen.screenshot({ path: `${SHOT}/drops-projector-speed-1080.png` });
    await phone.screenshot({ path: `${SHOT}/drops-phone-speed-390.png` });
    await take.getByRole('button', { name: "i'm a teapot" }).click();
    await expect(take.getByText('first! +30')).toBeVisible();
    await stick(phone);
    // the window shuts on the server clock: everyone sees the reveal
    await expect(take.getByText(/it was/)).toBeVisible({ timeout: 15_000 });
    await expect(screen.getByText(/it was/)).toBeVisible({ timeout: 6000 });
    await screen.waitForTimeout(600);
    await screen.screenshot({ path: `${SHOT}/drops-projector-reveal-1080.png` });
    await phone.screenshot({ path: `${SHOT}/drops-phone-reveal-390.png` });
    await screen.context().close();
    await phone.context().close();
  });

  test('everyone wins: the room fills the bar together', async ({ browser }) => {
    const phone = await attendee(browser);
    await phone.goto('/');
    const screen = await projector(browser);
    await api('POST', '/api/drops/admin', { title: 'the room did it', blurb: 'mash it.', durationSec: 30, config: { kind: 'room', goal: 12, points: 5 }, when: 'now' });
    const take = phone.getByRole('dialog', { name: /flash drop/ });
    const btn = take.getByRole('button', { name: 'tap tap tap' });
    await expect(btn).toBeVisible({ timeout: 8000 });
    for (let i = 0; i < 6; i++) await btn.click();
    await expect(screen.getByText(/\/12/)).toBeVisible({ timeout: 5000 });
    await phone.screenshot({ path: `${SHOT}/drops-phone-room-390.png` });
    await screen.waitForTimeout(800);
    await screen.screenshot({ path: `${SHOT}/drops-projector-room-1080.png` });
    for (let i = 0; i < 10; i++) {
      if (!(await btn.isVisible())) break;
      await btn.click({ timeout: 2000 }).catch(() => undefined);
      await phone.waitForTimeout(120);
    }
    await expect(take.getByText('the room did it!')).toBeVisible({ timeout: 8000 });
    await screen.context().close();
    await phone.context().close();
  });

  test('golden slip: the QR link claims it for the first finder', async ({ browser }) => {
    const phone = await attendee(browser);
    const late = await attendee(browser);
    await api('POST', '/api/drops/admin', { title: 'a golden slip is loose', blurb: 'first to find it takes the bonus.', durationSec: 300, config: { kind: 'golden', token: 'E2EGOLD', hint: 'under the stairs', bonus: 50 }, when: 'now' });
    await phone.waitForTimeout(3500);
    await phone.goto('/drop/g/E2EGOLD');
    await expect(phone.getByText('you found it first! +50')).toBeVisible({ timeout: 8000 });
    await stick(phone);
    await phone.waitForTimeout(800);
    await phone.screenshot({ path: `${SHOT}/drops-phone-golden-390.png` });
    await late.goto('/drop/g/E2EGOLD');
    await expect(late.getByText(/no golden slip is loose|too slow/)).toBeVisible({ timeout: 8000 });
    await late.context().close();
    await phone.context().close();
  });
});
