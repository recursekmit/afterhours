/*
  Student-ID login, end to end. Made-up people only.
  1. The console imports a roster in the participants panel (with a duplicate and a conflict).
  2. A phone signs in by scanning a rendered student-ID QR through Chromium's fake camera
     (a y4m file, as in trails-camera.spec.ts), confirms "that's you?", builds a profile, lands on home.
     No BarcodeDetector in desktop Chromium, so this runs the lazy jsQR fallback.
  3. Typed fallback (roll + last 4 phone digits), a shared card number that shows the "who are you?" picker,
     a card not on the list, a second phone refused, the desk unbinding it, camera denied.
  4. Screenshots of every step into docs/screens.
*/
import { type Browser, type BrowserContext, chromium, expect, type Page, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from 'uqr';

const SHOTS = 'docs/screens';
const TMP = join('.playwright', 'idlogin');
mkdirSync(TMP, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 4310);
const BASE = `http://127.0.0.1:${PORT}`;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } as const;

const ROSTER = [
  'name,year,section,roll,phone,email',
  'Kavya Iyer,1st,CSE-A,26BD1A0581,9000000081,kavya@example.com',
  'Rohan Mehta,1st,CSE-B,26BD1A0582,9000000082,rohan@example.com',
  'Asha Rao,2nd,CSE-C,25BD1A0563,9000000063,asha@example.com',
  'Anil Rao,1st,CSE-C,26BD1A0563,9000000064,anil@example.com',
  'Meera Das,1st,CSM-A,26BD1A660Q,9000000066,meera@example.com',
  'Kavya Iyer,1st,CSE-A,26BD1A0581,9000000081,kavya@example.com',
  'K Iyer,1st,CSE-A,26BD1A0581,9000000099,k@example.com',
  'Demo (trial),1st,CSE-A,26BD1A0590,9000000090,demo@example.com',
].join('\n');

const CARD_KAVYA = '0581-12600-A-IYER-CSE-260908';
const CARD_ROHAN = '0582-12601-B-MEHTA-CSE-260908';
const CARD_RAO = '0563-12602-C-RAO-CSE';
const CARD_NOBODY = '0999-12603-D-NOBODY-CSE-260908';

/** One grey frame with a white ID card and its QR in the middle, as Chromium's fake camera plays it. */
function writeCardY4m(path: string, payload: string | null) {
  const W = 640;
  const H = 480;
  const y = new Uint8Array(W * H).fill(96);
  const card = { x: 120, y: 70, w: 400, h: 340 };
  for (let r = card.y; r < card.y + card.h; r++) y.fill(236, r * W + card.x, r * W + card.x + card.w);
  if (payload) {
    const { data } = encode(payload, { ecc: 'M', border: 0 });
    const n = data.length;
    const mod = Math.floor(220 / n);
    const ox = Math.round(W / 2 - (n * mod) / 2);
    const oy = Math.round(H / 2 - (n * mod) / 2);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        if (data[i]?.[j]) for (let a = 0; a < mod; a++) y.fill(20, (oy + i * mod + a) * W + ox + j * mod, (oy + i * mod + a) * W + ox + (j + 1) * mod);
  }
  const chroma = Buffer.alloc((W / 2) * (H / 2), 128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), Buffer.from(y), chroma, chroma]);
  writeFileSync(path, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F15:1 Ip A1:1 C420jpeg\n`), frame, frame, frame]));
}

/** A fresh phone whose camera sees `payload` (null: a card with no QR). */
async function withCamera<T>(name: string, payload: string | null, fn: (page: Page, ctx: BrowserContext) => Promise<T>, storageState?: Awaited<ReturnType<BrowserContext['storageState']>>): Promise<T> {
  const y4m = join(TMP, `${name}.y4m`);
  writeCardY4m(y4m, payload);
  const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`] });
  try {
    const ctx = await b.newContext({ ...PHONE, baseURL: BASE, permissions: ['camera'], ...(storageState ? { storageState } : {}) });
    const page = await ctx.newPage();
    const out = await fn(page, ctx);
    await ctx.close();
    return out;
  } finally {
    await b.close();
  }
}

async function adminPage(browser: Browser, path: string) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: BASE });
  const page = await ctx.newPage();
  expect((await page.request.post('/api/admin/session', { data: { pin: '2468' } })).ok()).toBeTruthy();
  await page.goto(path);
  return { ctx, page };
}

async function settle(page: Page, ms = 500) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
}

let kavyaState: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;

test.describe.serial('student-ID login', () => {
  test('console: import a made-up roster in the participants panel', async ({ browser }) => {
    const { ctx, page } = await adminPage(browser, '/admin/participants');
    await expect(page.getByRole('heading', { name: 'participants', exact: true })).toBeVisible();
    await page.getByLabel('paste name, year, section, roll, phone, email').fill(ROSTER);
    await page.getByRole('button', { name: 'import', exact: true }).click();
    const report = page.getByTestId('import-report');
    await expect(report).toContainText('6 added from 8 rows');
    await expect(report).toContainText('kept "Kavya Iyer", also given by "K Iyer"');
    await expect(report).toContainText('probable test entry');
    await expect(page.getByTestId('participant-26BD1A0581')).toContainText('roll also given by');
    await settle(page, 5000); // let the confetti and the toast clear
    await page.screenshot({ path: `${SHOTS}/idlogin-console-participants.png`, fullPage: true });
    await ctx.close();
  });

  test('phone: the sign-in screen leads with "scan your student ID"', async ({ browser }) => {
    const ctx = await browser.newContext({ ...PHONE, baseURL: BASE });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.getByTestId('scan-id')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'have an entry kit instead?' })).toBeVisible();
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/idlogin-signin-390.png` });
    await ctx.close();
  });

  test('phone: the scanner frame, with a card that has no QR in view', async () => {
    await withCamera('blank', null, async (page) => {
      await page.goto('/');
      await page.getByTestId('scan-id').click();
      await expect(page.locator('[data-testid="id-scanner"][data-phase="scanning"]')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("hold your college ID's QR inside the frame")).toBeVisible();
      await settle(page, 900);
      await page.screenshot({ path: `${SHOTS}/idlogin-scanner-390.png` });
    });
  });

  test('phone: scan the ID through the fake camera, "that\'s you?", profile, home', async () => {
    kavyaState = await withCamera('kavya', CARD_KAVYA, async (page, ctx) => {
      await page.goto('/');
      await page.getByTestId('scan-id').click();
      const confirm = page.getByTestId('id-confirm');
      await expect(confirm).toBeVisible({ timeout: 20_000 });
      await expect(confirm).toContainText("hi Kavya! that's you?");
      await expect(confirm).toContainText('1st, CSE-A');
      await expect(confirm).not.toContainText('BD1A');
      await settle(page);
      await page.screenshot({ path: `${SHOTS}/idlogin-thats-you-390.png` });
      await page.getByRole('button', { name: "yes, that's me" }).click();
      await expect(page.getByRole('heading', { name: 'who are you?' })).toBeVisible();
      await expect(page.getByLabel('your name')).toHaveValue('Kavya Iyer');
      await expect(page.getByLabel('roll number')).toHaveValue('26BD1A0581');
      await page.getByRole('button', { name: 'stick it in' }).click({ timeout: 8000 }).catch(() => undefined);
      await page.getByLabel('nickname (shows on the leaderboard)').fill('kavz');
      await page.getByRole('button', { name: "that's me" }).click();
      await expect(page.getByRole('heading', { name: 'kavz' })).toBeVisible();
      return ctx.storageState();
    });
    const admin = await chromium.launch();
    try {
      const { ctx, page } = await adminPage(admin, '/admin/participants');
      await expect(page.getByTestId('participant-26BD1A0581')).toContainText('kavz');
      await ctx.close();
    } finally {
      await admin.close();
    }
  });

  test('phone: a shared last four shows the "who are you?" picker, a bound person disabled', async ({ playwright }) => {
    // Asha (25BD1A0563) is already in on another phone: typed fallback from a throwaway client
    const other = await playwright.request.newContext({ baseURL: BASE });
    expect((await other.post('/api/auth/roll/signin', { data: { roll: '25BD1A0563', phone4: '0063' } })).ok()).toBeTruthy();
    await other.dispose();
    await withCamera('rao', CARD_RAO, async (page) => {
      await page.goto('/');
      await page.getByTestId('scan-id').click();
      const picker = page.getByTestId('id-picker');
      await expect(picker).toBeVisible({ timeout: 20_000 });
      await expect(picker.getByRole('heading', { name: 'who are you?' })).toBeVisible();
      const asha = picker.getByRole('button', { name: /Asha Rao/ });
      const anil = picker.getByRole('button', { name: /Anil Rao/ });
      await expect(asha).toBeDisabled();
      await expect(asha).toContainText('already signed in on another phone, ask the desk');
      await expect(anil).toBeEnabled();
      await expect(anil).toContainText('1st, CSE-C');
      await expect(picker).not.toContainText('BD1A'); // never a roll
      await expect(picker).not.toContainText('9000000');
      await settle(page);
      await page.screenshot({ path: `${SHOTS}/idlogin-picker-390.png` });
      await anil.click();
      await expect(page.getByTestId('id-confirm')).toContainText("hi Anil! that's you?");
      await page.getByRole('button', { name: "yes, that's me" }).click();
      await expect(page.getByRole('heading', { name: 'who are you?' })).toBeVisible();
      await expect(page.getByLabel('roll number')).toHaveValue('26BD1A0563');
    });
  });

  test('phone: a card not on the list says so kindly', async () => {
    await withCamera('nobody', CARD_NOBODY, async (page) => {
      await page.goto('/');
      await page.getByTestId('scan-id').click();
      const p = page.getByTestId('id-problem-not_registered');
      await expect(p).toBeVisible({ timeout: 20_000 });
      await expect(p).toContainText("you're not on the list");
      await expect(p).toContainText('card 0999');
      await settle(page);
      await page.screenshot({ path: `${SHOTS}/idlogin-not-registered-390.png` });
    });
  });

  test('phone: typed fallback with roll + last 4 phone digits', async ({ browser }) => {
    const ctx = await browser.newContext({ ...PHONE, baseURL: BASE });
    const page = await ctx.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: /type your roll number/ }).click();
    await page.getByLabel('roll number').fill('26BD1A0582');
    await page.getByLabel('last 4 digits of your phone').fill('1234');
    await page.getByRole('button', { name: 'let me in' }).click();
    await expect(page.getByRole('alert').first()).toContainText("don't match our list");
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/idlogin-typed-wrong-390.png` });
    await page.getByLabel('last 4 digits of your phone').fill('0082');
    await settle(page, 200);
    await page.screenshot({ path: `${SHOTS}/idlogin-typed-390.png` });
    await page.getByRole('button', { name: 'let me in' }).click();
    await expect(page.getByRole('heading', { name: 'who are you?' })).toBeVisible();
    await expect(page.getByLabel('your name')).toHaveValue('Rohan Mehta');
    await ctx.close();
    void CARD_ROHAN;
  });

  test('a second phone is refused; the desk unbinds it; then it gets in', async ({ browser }) => {
    await withCamera('kavya-2', CARD_KAVYA, async (page) => {
      await page.goto('/');
      await page.getByTestId('scan-id').click();
      const p = page.getByTestId('id-problem-id_bound');
      await expect(p).toBeVisible({ timeout: 20_000 });
      await expect(p).toContainText('already signed in on another phone');
      await settle(page);
      await page.screenshot({ path: `${SHOTS}/idlogin-already-bound-390.png` });
    });

    const { ctx, page } = await adminPage(browser, '/admin/desk');
    await page.getByTestId('desk-query').fill('26bd1a0581');
    await page.getByRole('button', { name: 'look up' }).click();
    const person = page.getByTestId('desk-person-26BD1A0581');
    await expect(person).toContainText('signed in');
    await expect(person).toContainText('kavz');
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/idlogin-desk.png` });
    await person.getByRole('button', { name: 'unbind phone' }).click();
    await page.getByRole('button', { name: 'unbind the phone' }).click();
    await expect(page.getByText('can sign in on a new phone now')).toBeVisible();
    // someone not on the list: the desk adds them in place
    await page.getByTestId('desk-query').fill('26BD1A0599');
    await page.getByRole('button', { name: 'look up' }).click();
    await expect(page.getByTestId('desk-not-found')).toBeVisible();
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/idlogin-desk-walkin.png` });
    await page.getByTestId('desk-not-found').getByLabel('name').fill('Walk In');
    await page.getByRole('button', { name: 'add to the list' }).click();
    await expect(page.getByTestId('desk-person-26BD1A0599')).toContainText('on the list, not signed in yet');
    await ctx.close();

    // the old phone was signed out; the new phone now gets in as the same person
    await withCamera('kavya-3', CARD_KAVYA, async (page) => {
      await page.goto('/');
      await page.getByTestId('scan-id').click();
      await expect(page.getByTestId('id-confirm')).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: "yes, that's me" }).click();
      await expect(page.getByRole('heading', { name: 'kavz' })).toBeVisible();
    });
    const old = await browser.newContext({ ...PHONE, baseURL: BASE, storageState: kavyaState });
    expect((await old.request.get('/api/me')).status()).toBe(401);
    await old.close();
  });

  test('camera denied: kind words and the typed way in', async () => {
    const b = await chromium.launch();
    try {
      const ctx = await b.newContext({ ...PHONE, baseURL: BASE });
      const page = await ctx.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'mediaDevices', {
          value: { getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) },
        });
      });
      await page.goto('/');
      await page.getByTestId('scan-id').click();
      await expect(page.locator('[data-testid="id-scanner"][data-phase="denied"]')).toContainText('the camera said no');
      await settle(page);
      await page.screenshot({ path: `${SHOTS}/idlogin-camera-denied-390.png` });
      await page.getByRole('button', { name: 'type my roll instead' }).click();
      await expect(page.getByTestId('id-typed')).toBeVisible();
      await ctx.close();
    } finally {
      await b.close();
    }
  });

  test('kits still work beside it', async ({ browser }) => {
    const { ctx, page } = await adminPage(browser, '/admin/kits');
    const kit = (await (await page.request.post('/api/admin/kits', { data: { mode: 'blank', count: 1 } })).json()) as { kits: { kitId: string; password: string }[] };
    await ctx.close();
    const phone = await browser.newContext({ ...PHONE, baseURL: BASE });
    const p = await phone.newPage();
    await p.goto(`/?kit=${kit.kits[0]!.kitId}`);
    await p.getByLabel('password').fill(kit.kits[0]!.password);
    await p.getByRole('button', { name: 'let me in' }).click();
    await expect(p.getByRole('heading', { name: 'who are you?' })).toBeVisible();
    await phone.close();
  });
});
