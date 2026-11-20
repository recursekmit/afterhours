import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const SHOTS = 'docs/screens';
mkdirSync(SHOTS, { recursive: true });

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } as const;

async function phone(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  return { ctx, page };
}

async function adminPage(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto('/admin');
  await page.getByLabel('PIN').fill('2468');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'kits and sign-ins' })).toBeVisible();
  return { ctx, page };
}

let kits: { kitId: string; password: string }[] = [];

async function signedInPhone(browser: Browser, i: number, block?: (page: Page) => Promise<void>) {
  const { ctx, page } = await phone(browser);
  if (block) await block(page);
  const kit = kits[i]!;
  const res = await page.request.post('/api/auth/signin', { data: { kitId: kit.kitId, password: kit.password } });
  expect(res.ok()).toBeTruthy();
  const prof = await page.request.put('/api/me/profile', {
    data: {
      name: `Tester ${i}`,
      roll: `T${i}`,
      nickname: `tester${i}`,
      avatar: { shape: 'blob', color: 'lime', eyes: 'wide', mouth: 'grin', top: 'cap', extra: 'none' },
    },
  });
  expect(prof.ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByText('hype the room')).toBeVisible();
  return { ctx, page };
}

test.describe.serial('after hours foundation', () => {
  test('console: PIN gate refuses a wrong PIN, then generates kits and a printable sheet', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto('/admin');
    await page.getByLabel('PIN').fill('0000');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toContainText('Wrong PIN');
    await page.screenshot({ path: `${SHOTS}/console-pin-1280.png` });
    await ctx.close();

    const admin = await adminPage(browser);
    const p = admin.page;
    await p.getByLabel('how many?').fill('6');
    await p.getByRole('button', { name: 'make them' }).click();
    await expect(p.getByText('fresh kits, passwords inside')).toBeVisible();
    await expect(p.getByTestId('kit-row-AH-001')).toBeVisible();
    await p.waitForTimeout(4500);
    await p.screenshot({ path: `${SHOTS}/console-kits-1280.png` });

    // CSV download
    const [dl] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: 'download csv' }).click()]);
    // the suite shares one server, and specs that sort earlier (drops) make kits too: any 6-kit batch
    expect(dl.suggestedFilename()).toMatch(/^afterhours-kits-AH-\d{3}-AH-\d{3}\.csv$/);

    await p.getByRole('button', { name: 'card sheet' }).click();
    const cards = p.getByTestId('kit-card');
    await expect(cards).toHaveCount(6);
    kits = [];
    for (let i = 0; i < 6; i++) {
      const card = cards.nth(i);
      const kitId = (await card.locator('p').filter({ hasText: /^AH-\d{3}$/ }).innerText()).trim();
      const pw = (await card.locator('span').filter({ hasText: /^[A-Z2-9]{3} [A-Z2-9]{3}$/ }).innerText()).replace(/\s/g, '');
      kits.push({ kitId, password: pw });
      // QR opens the app with the kit prefilled and NEVER carries the password
      const qr = (await card.locator('svg[data-qr-text]').getAttribute('data-qr-text')) ?? '';
      expect(qr).toContain(`?kit=${kitId}`);
      expect(qr.toUpperCase()).not.toContain(pw);
    }
    expect(kits).toHaveLength(6);
    await p.screenshot({ path: `${SHOTS}/console-print-sheet-1280.png` });
    await admin.ctx.close();
  });

  test('attendee: sign in from the QR link, build a face, land on home', async ({ browser }) => {
    const { ctx, page } = await phone(browser);
    const kit = kits[0]!;
    await page.goto(`/?kit=${kit.kitId}`);
    await expect(page.getByLabel('kit id')).toHaveValue(kit.kitId);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${SHOTS}/attendee-signin-390.png` });

    await page.getByLabel('password').fill('WRONG1');
    await page.getByRole('button', { name: 'let me in' }).click();
    await expect(page.getByRole('alert').first()).toContainText("don't match");

    await page.getByLabel('password').fill(kit.password.toLowerCase());
    await page.getByRole('button', { name: 'let me in' }).click();
    await expect(page.getByRole('heading', { name: 'who are you?' })).toBeVisible();

    // the live stream delivers the "showed up" sticker as a celebration
    await expect(page.getByRole('alertdialog')).toContainText('showed up', { timeout: 10_000 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${SHOTS}/stickers-celebration-390.png` });
    await page.getByRole('button', { name: 'stick it in' }).click();

    // play with the builder
    await page.getByRole('tab', { name: 'hat' }).click();
    await page.getByRole('option', { name: 'crown' }).click();
    await page.getByRole('tab', { name: 'eyes' }).click();
    await page.getByRole('option', { name: 'stars' }).click();
    await page.getByRole('button', { name: 'boop your avatar' }).click();
    await page.waitForTimeout(3200);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/attendee-avatar-builder-390.png` });

    await page.getByLabel('your name').fill('Sana Qureshi');
    await page.getByLabel('roll number').fill('23bd1a0506');
    await page.getByLabel('nickname (shows on the leaderboard)').fill('sana');
    await page.getByRole('button', { name: "that's me" }).click();
    await expect(page.getByRole('heading', { name: 'sana' })).toBeVisible();
    await expect(page.getByRole('alertdialog')).toContainText('new face');
    await page.getByRole('button', { name: 'stick it in' }).click();
    await expect(page.getByText('hype the room')).toBeVisible();
    await page.waitForTimeout(4500);
    await page.screenshot({ path: `${SHOTS}/attendee-home-390.png` });

    await page.getByRole('link', { name: 'stickers' }).click();
    await expect(page.getByRole('heading', { name: 'sticker book' })).toBeVisible();
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${SHOTS}/stickers-book-390.png` });
    await ctx.close();
  });

  test('a second device is refused until the console resets the kit', async ({ browser }) => {
    const kit = kits[0]!;
    const second = await phone(browser);
    const signIn = async () => {
      await second.page.goto(`/?kit=${kit.kitId}`);
      await second.page.getByLabel('password').fill(kit.password);
      await second.page.getByRole('button', { name: 'let me in' }).click();
    };
    await signIn();
    await expect(second.page.getByRole('alert').first()).toContainText('already signed in on another phone');

    const admin = await adminPage(browser);
    await admin.page.getByTestId(`kit-row-${kit.kitId}`).getByRole('button', { name: /reset/ }).click();
    await admin.page.getByRole('button', { name: 'reset, same password' }).click();
    await expect(admin.page.getByText(`${kit.kitId} is free`)).toBeVisible();
    await admin.ctx.close();

    await signIn();
    await expect(second.page.getByRole('heading', { name: 'welcome back' }).or(second.page.getByRole('heading', { name: 'sana' }))).toBeVisible();
    await second.ctx.close();
  });

  test('live: an event reaches the page over SSE', async ({ browser }) => {
    const { ctx, page } = await signedInPhone(browser, 1);
    await expect(page.locator('html')).toHaveAttribute('data-live', 'live');
    await page.request.post('/api/reactions', { data: { kind: 'fire' } });
    await expect(page.getByTestId('reaction-floaters').locator('[data-kind="fire"]').first()).toBeAttached();
    await ctx.close();
  });

  test('live: polling fallback takes over when SSE is blocked', async ({ browser }) => {
    const { ctx, page } = await signedInPhone(browser, 2, async (p) => {
      await p.route(/\/api\/live(\?.*)?$/, (r) => r.abort());
    });
    await expect(page.locator('html')).toHaveAttribute('data-live', 'polling', { timeout: 15_000 });
    await page.request.post('/api/reactions', { data: { kind: 'party' } });
    await expect(page.getByTestId('reaction-floaters').locator('[data-kind="party"]').first()).toBeAttached({ timeout: 10_000 });
    await ctx.close();
  });

  test('deep link /hunt/s/:token survives sign-in', async ({ browser }) => {
    const { ctx, page } = await phone(browser);
    const kit = kits[3]!;
    await page.goto('/hunt/s/abc123');
    await page.getByLabel('kit id').fill(kit.kitId);
    await page.getByLabel('password').fill(kit.password);
    await page.getByRole('button', { name: 'let me in' }).click();
    await expect(page.getByRole('heading', { name: 'who are you?' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/hunt/s/abc123');
    await ctx.close();
  });

  test('kit page and projector', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto('/dev/kit');
    await expect(page.getByRole('heading', { name: 'kit', exact: true })).toBeVisible();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOTS}/kit-dev-1280.png`, fullPage: true });
    await ctx.close();

    const sc = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const sp = await sc.newPage();
    await sp.goto('/screen');
    await sp.getByLabel('PIN').fill('1357');
    await sp.keyboard.press('Enter');
    await expect(sp.locator('svg[data-qr-text]')).toBeVisible();
    await sp.waitForTimeout(1500);
    await sp.screenshot({ path: `${SHOTS}/projector-join-1280.png` });
    await sc.close();
  });
});
