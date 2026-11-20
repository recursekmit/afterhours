// Stalls end to end: the console builds a stall and its menu, a shopkeeper signs in at /stall and hands over
// two free mocktails (typed code, then the /stall/r/<token> link), the third is not free any more and goes
// through on points, and the attendee's phone celebrates each one. Screenshots go to docs/screens/stalls-*.png.
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';

// believable nicknames for the screenshots
const NICKS = ['anika', 'rahul', 'maya', 'krish', 'sneha', 'aryan', 'jiya', 'om'];
const nick = (n: number) => NICKS[(n - 1) % NICKS.length]! + (n > NICKS.length ? String(Math.ceil(n / NICKS.length)) : '');

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } as const;
const SMALL = { viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } as const;
const TABLET = { viewport: { width: 800, height: 1100 }, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true } as const;
const SHOT = 'docs/screens';
const STALL = 'e2e juice bar';

let admin: APIRequestContext;
let kits: { kitId: string; password: string }[] = [];
let baseURL = '';
let next = 0;

async function api<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, data?: unknown): Promise<T> {
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
    data: { name: nick(next), roll: `S${next}`, nickname: nick(next), avatar: { shape: 'blob', color: 'pink', eyes: 'wide', mouth: 'grin', top: 'none', extra: 'none' } },
  });
  expect(prof.ok()).toBeTruthy();
  return page;
}

type Overview = { settings: { allowance: number }; stalls: { id: number; name: string; code: string; items: { id: number; name: string; price: number; freeDrink: boolean }[] }[] };

test.describe.serial('stalls', () => {
  let code = '';

  test.beforeAll(async ({ playwright }, info) => {
    baseURL = String(info.project.use.baseURL);
    admin = await playwright.request.newContext({ baseURL });
    expect((await admin.post('/api/admin/session', { data: { pin: '2468' } })).ok()).toBeTruthy();
    kits = (await api<{ kits: { kitId: string; password: string }[] }>('POST', '/api/admin/kits', { mode: 'blank', count: 6 })).kits;
    // the suite shares one server: start every run from no purchases and the default allowance
    await api('POST', '/api/stalls/admin/reset', { confirm: 'RESET STALLS' });
    await api('PATCH', '/api/stalls/admin/settings', { allowance: 2 });
  });

  test('console: create a stall and its menu', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL });
    const page = await ctx.newPage();
    await page.goto('/admin');
    await page.getByLabel('PIN').fill('2468');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'kits and sign-ins' })).toBeVisible();
    await page.goto('/admin/stalls');
    await expect(page.getByRole('heading', { name: 'stalls and rewards' })).toBeVisible();
    // the mocktail bar is there from the first boot
    await expect(page.getByRole('heading', { name: 'mocktail bar', exact: true })).toBeVisible();

    const ov0 = await api<Overview>('GET', '/api/stalls/admin/overview');
    if (!ov0.stalls.some((s) => s.name === STALL)) {
      // with only the mocktail bar, the console puts "add the second stall" right at the top
      const add = page.locator('div:has(> div > h2:text-is("add the second stall"))');
      await expect(add).toBeVisible();
      await expect(add.getByText('2 stalls')).toBeVisible();
      await add.getByLabel('stall name').fill(STALL);
      await add.getByLabel('where', { exact: true }).fill('by the stage');
      await add.getByRole('button', { name: 'create, get a code' }).click();
      const block = page.locator(`div:has(> div > h2:text-is("${STALL}"))`);
      await expect(block).toBeVisible();
      const addItem = async (name: string, price: string, free: boolean) => {
        await block.getByLabel('new item').fill(name);
        await block.getByLabel('price (pts)').fill(price);
        if (free) await block.getByLabel('free mocktail').check();
        await block.getByRole('button', { name: 'add item' }).click();
        await expect(block.getByRole('textbox', { name: 'item name' }).and(page.locator(`[value="${name}"]`))).toBeVisible();
      };
      await addItem('welcome shot', '0', true);
      await addItem('mocktail', '15', true);
      await addItem('brownie', '5', false);
    }
    const ov = await api<Overview>('GET', '/api/stalls/admin/overview');
    const st = ov.stalls.find((s) => s.name === STALL)!;
    expect(st.items.map((i) => [i.name, i.price, i.freeDrink])).toEqual([
      ['welcome shot', 0, true],
      ['mocktail', 15, true],
      ['brownie', 5, false],
    ]);
    code = st.code;
    await page.waitForTimeout(600);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOT}/stalls-console-1280.png`, fullPage: false });
    await page.getByRole('heading', { name: STALL, exact: true }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOT}/stalls-console-menu-1280.png` });
    await ctx.close();
  });

  test('two free mocktails, the third is not free and goes on points; the phone celebrates', async ({ browser }) => {
    expect(code).toMatch(/^\d{6}$/);
    const phone = await attendee(browser);
    await phone.goto('/');
    const card = phone.getByRole('heading', { name: 'mocktails + stalls' });
    await card.scrollIntoViewIfNeeded();
    await expect(phone.getByText('2 free mocktails, then earn more by playing.', { exact: false })).toBeVisible();
    await expect(phone.getByText(/more to the next|more points to your next mocktail/).first()).toBeVisible();
    await phone.waitForTimeout(700);
    await card.evaluate((el) => el.closest('[class*="card"]')?.scrollIntoView({ block: 'center' }));
    await phone.waitForTimeout(500);
    await phone.screenshot({ path: `${SHOT}/stalls-home-card-390.png` });

    // the full-screen rotating QR with its typed code
    await phone.goto('/wallet/qr');
    const typed = phone.locator('[aria-label^="typed code"]');
    await expect(typed).toHaveText(/^[2-9A-Z]{3} [2-9A-Z]{3}$/);
    await phone.waitForTimeout(600);
    await phone.screenshot({ path: `${SHOT}/stalls-qr-390.png` });

    // shopkeeper on a tablet signs in with the stall code
    const sctx = await browser.newContext({ ...TABLET, baseURL });
    const shop = await sctx.newPage();
    await shop.goto('/stall');
    await expect(shop.getByRole('heading', { name: 'stall sign in' })).toBeVisible();
    await shop.waitForTimeout(500);
    await shop.screenshot({ path: `${SHOT}/stalls-shop-signin-800.png` });
    await shop.getByLabel('stall code').fill('000000');
    await shop.getByRole('button', { name: 'sign in' }).click();
    await expect(shop.getByRole('alert')).toContainText('not right');
    await shop.getByLabel('stall code').fill(code);
    await shop.getByRole('button', { name: 'sign in' }).click();
    await expect(shop.getByRole('heading', { name: 'scan the next person' })).toBeVisible();
    await shop.waitForTimeout(500);
    await shop.screenshot({ path: `${SHOT}/stalls-shop-scan-800.png` });

    // 1st: the typed code
    await shop.getByLabel('or type their code').fill((await typed.textContent())!.replace(' ', ''));
    await shop.getByRole('button', { name: 'go' }).click();
    await expect(shop.getByRole('heading', { name: 'sipper1' })).toBeVisible();
    await expect(shop.getByLabel('2 free mocktails left', { exact: true })).toBeVisible();
    await shop.getByRole('button', { name: 'add mocktail' }).click();
    await expect(shop.locator('[class*=verdict][role=status]')).toContainText('1 free drink');
    await shop.waitForTimeout(400);
    await shop.screenshot({ path: `${SHOT}/stalls-shop-sheet-800.png` });
    await shop.getByRole('button', { name: 'hand it over' }).click();
    await expect(shop.getByRole('heading', { name: '1 free mocktail, 1 left' })).toBeVisible();
    await shop.waitForTimeout(500);
    await shop.screenshot({ path: `${SHOT}/stalls-shop-done-800.png` });

    // the phone left the QR screen and celebrates
    const party = phone.getByRole('alertdialog', { name: 'enjoy your mocktail!' });
    await expect(party).toBeVisible({ timeout: 8000 });
    await expect(party).toContainText('1 free left');
    await phone.waitForTimeout(1200);
    await phone.screenshot({ path: `${SHOT}/stalls-celebrate-390.png` });
    await party.getByRole('button', { name: 'nice' }).click();
    await expect(party).toBeHidden();

    // 2nd: the /stall/r/<token> link, as a phone camera app would open it
    await shop.getByRole('button', { name: 'next person' }).click();
    const qr = (await (await phone.request.get('/api/stalls/qr')).json()) as { url: string; token: string };
    expect(qr.url).toBe(`${baseURL}/stall/r/${qr.token}`);
    await shop.goto(`/stall/r/${qr.token}`);
    await expect(shop.getByRole('heading', { name: 'sipper1' })).toBeVisible();
    await expect(shop).toHaveURL(/\/stall$/);
    await expect(shop.getByLabel('1 free mocktail left', { exact: true })).toBeVisible();
    await shop.getByRole('button', { name: 'add mocktail' }).click();
    await shop.getByRole('button', { name: 'hand it over' }).click();
    await expect(shop.getByRole('heading', { name: '1 free mocktail, 0 left' })).toBeVisible();
    await expect(phone.getByRole('alertdialog')).toContainText('that was your last free one', { timeout: 8000 });
    await phone.getByRole('button', { name: 'nice' }).click();

    // 3rd: the attendee puts a mocktail in their basket; the free route is gone, so it costs 15 of their 20 points
    await phone.goto('/wallet');
    await expect(phone.getByText('free mocktails all used')).toBeVisible();
    await phone.getByRole('tab', { name: new RegExp(STALL) }).click();
    await phone.getByRole('button', { name: 'add mocktail' }).click();
    await expect(phone.getByText(/your basket: 1 thing/)).toBeVisible();
    await phone.waitForTimeout(600);
    await phone.screenshot({ path: `${SHOT}/stalls-wallet-390.png`, fullPage: true });
    await phone.goto('/wallet/qr');
    await expect(typed).toHaveText(/^[2-9A-Z]{3} [2-9A-Z]{3}$/);
    await shop.getByRole('button', { name: 'next person' }).click();
    await shop.getByLabel('or type their code').fill((await typed.textContent())!.replace(' ', ''));
    await shop.getByRole('button', { name: 'go' }).click();
    await expect(shop.getByLabel('0 free mocktails left', { exact: true })).toBeVisible();
    // the free-only item is refused now; the basket came pre-filled with a mocktail on points
    await expect(shop.getByRole('button', { name: 'add welcome shot' })).toBeDisabled();
    await expect(shop.getByRole('button', { name: 'add welcome shot' })).toContainText('no free drinks left');
    await expect(shop.locator('[class*=verdict][role=status]')).toContainText('15 pts');
    await shop.waitForTimeout(400);
    await shop.screenshot({ path: `${SHOT}/stalls-shop-paid-800.png` });
    await shop.getByRole('button', { name: 'hand it over' }).click();
    await expect(shop.getByRole('heading', { name: 'mocktail' })).toBeVisible();
    await expect(shop.getByText('15 pts taken')).toBeVisible();

    const paid = phone.getByRole('alertdialog', { name: 'enjoy!' });
    await expect(paid).toBeVisible({ timeout: 8000 });
    await expect(paid).toContainText('-15 points, 5 to spend');
    await paid.getByRole('button', { name: 'nice' }).click();

    // the counts on the phone
    const w = (await (await phone.request.get('/api/stalls/wallet')).json()) as { balance: number; earned: number; allowance: { left: number }; receipts: unknown[] };
    expect([w.allowance.left, w.balance, w.earned, w.receipts.length]).toEqual([0, 5, 20, 3]);
    await phone.goto('/wallet');
    await expect(phone.getByText('earned 20, spent 15')).toBeVisible();
    await expect(phone.locator('li', { hasText: STALL })).toHaveCount(3);
    // the leaderboard still counts everything earned
    const lb = (await (await phone.request.get('/api/leaderboard')).json()) as { me: { liveTotal: number } | null };
    expect(lb.me?.liveTotal).toBe(20);

    // the console sees the three hand-overs and can refund one
    const tx = await api<{ txns: { id: number; stallName: string; totalPoints: number }[] }>('GET', '/api/stalls/admin/txns');
    const mine = tx.txns.filter((t) => t.stallName === STALL);
    expect(mine.map((t) => t.totalPoints)).toEqual([15, 0, 0]);
    await api('POST', `/api/stalls/admin/txns/${mine[0]!.id}/void`, { reason: 'e2e refund' });
    await expect(phone.getByText(/voided a purchase/)).toBeVisible({ timeout: 8000 });
    const w2 = (await (await phone.request.get('/api/stalls/wallet')).json()) as { balance: number };
    expect(w2.balance).toBe(20);
    await sctx.close();
    await phone.context().close();
  });

  test('small phone: wallet and QR fit at 360', async ({ browser }) => {
    const phone = await attendee(browser, SMALL);
    await phone.goto('/wallet');
    await expect(phone.getByText('2 free mocktails left')).toBeVisible();
    await phone.waitForTimeout(800);
    await phone.screenshot({ path: `${SHOT}/stalls-wallet-360.png` });
    await phone.goto('/wallet/qr');
    await expect(phone.locator('[aria-label^="typed code"]')).toBeVisible();
    await phone.waitForTimeout(600);
    await phone.screenshot({ path: `${SHOT}/stalls-qr-360.png` });
    const box = await phone.getByRole('button', { name: 'close' }).boundingBox();
    expect(box && box.height >= 44).toBeTruthy();
    await phone.context().close();
  });
});
