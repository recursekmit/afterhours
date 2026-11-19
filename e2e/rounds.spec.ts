// Arcade rounds (the puzzle hour), end to end on the built app: the console releases a round, a phone
// loses and wins each game through its normal entry point, the win pays once, the house total moves, and a
// mocktail claim at the bar spends tokens without touching scores or standings.
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';

const PHONE = { viewport: { width: 360, height: 800 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true } as const;

let admin: APIRequestContext;
let baseURL = '';

async function api<T = unknown>(method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
  const r = await admin.fetch(path, { method, data: data as object | undefined });
  expect(r.ok(), `${method} ${path}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()) as T;
}

async function attendee(browser: Browser, kit: { kitId: string; password: string }, nickname: string): Promise<Page> {
  const ctx = await browser.newContext({ ...PHONE, baseURL });
  const page = await ctx.newPage();
  expect((await page.request.post('/api/auth/signin', { data: kit })).ok()).toBeTruthy();
  const prof = await page.request.put('/api/me/profile', {
    data: { name: nickname, roll: 'R1', nickname, avatar: { shape: 'blob', color: 'lime', eyes: 'wide', mouth: 'grin', top: 'none', extra: 'none' } },
  });
  expect(prof.ok()).toBeTruthy();
  return page;
}

async function dismissSticker(page: Page) {
  const b = page.getByRole('button', { name: 'stick it in' });
  if (await b.isVisible().catch(() => false)) await b.click();
}

test.describe.serial('arcade rounds', () => {
  let kit: { kitId: string; password: string };
  test.beforeAll(async ({ playwright }, info) => {
    baseURL = String(info.project.use.baseURL);
    admin = await playwright.request.newContext({ baseURL });
    expect((await admin.post('/api/admin/session', { data: { pin: '2468' } })).ok()).toBeTruthy();
    kit = (await api<{ kits: { kitId: string; password: string }[] }>('POST', '/api/admin/kits', { mode: 'blank', count: 1 })).kits[0]!;
  });

  test('console releases a round, a phone loses then wins all three games, house and tokens update, a claim leaves standings alone', async ({ browser }) => {
    const page = await attendee(browser, kit, 'puzzler');
    await api('POST', '/api/arcade/rounds/admin/houses/assign', { houseId: 2, kitIds: [kit.kitId] });
    await page.goto('/arcade');
    await expect(page.getByRole('heading', { name: 'puzzle hour' })).toBeVisible();
    await expect(page.getByText('puzzle hour soon')).toBeVisible();

    // release from the console UI; the phone hears about it live
    const con = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL })).newPage();
    expect((await con.request.post('/api/admin/session', { data: { pin: '2468' } })).ok()).toBeTruthy();
    await con.goto('/admin/arcade');
    await con.getByRole('button', { name: 'release round 1' }).click();
    await expect(con.getByRole('button', { name: 'release round 2' })).toBeVisible();
    await expect(page.getByText('round 1 is out')).toBeVisible({ timeout: 8000 });
    await expect(page.getByText('round 1 is live')).toBeVisible();

    // packet panic: blind send gets stuck with a reason, then point the arrow
    await page.getByRole('link', { name: /packet panic/ }).click();
    await page.getByRole('button', { name: 'send' }).click();
    await expect(page.getByText(/no arrow set for A at J1/)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /turn the arrow at J1/ }).click();
    await page.getByRole('button', { name: 'send' }).click();
    await expect(page.getByText('cracked', { exact: true })).toBeVisible({ timeout: 10_000 });
    await dismissSticker(page);

    // patch the bot: wrong card crashes, the right one reaches the goal
    await page.goto('/arcade/patch');
    await page.getByRole('button', { name: /^card 1:/ }).click();
    await page.getByRole('button', { name: /^turn left$/ }).click();
    await page.getByRole('button', { name: 'run tests' }).click();
    await expect(page.getByText(/bumped the wall|battery went flat/)).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'undo patch' }).click();
    await page.getByRole('button', { name: /^card 3:/ }).click();
    await page.getByRole('button', { name: /^turn right$/ }).click();
    await page.getByRole('button', { name: 'run tests' }).click();
    await expect(page.getByText('cracked', { exact: true })).toBeVisible({ timeout: 15_000 });

    // rebuild the image: wrong pixel fails the check, the right one reveals the picture
    await page.goto('/arcade/pixels');
    await page.getByRole('gridcell', { name: /^A1,/ }).click();
    await page.getByRole('button', { name: 'check the picture' }).click();
    await expect(page.getByText(/still off|were wrong/)).toBeVisible({ timeout: 8000 });
    await page.getByRole('gridcell', { name: /^A1,/ }).click();
    await page.getByRole('gridcell', { name: /^B3,/ }).click();
    await page.getByRole('button', { name: 'check the picture' }).click();
    await expect(page.getByText("it's a smiley!")).toBeVisible({ timeout: 8000 });

    // each game: one miss, so 4 - 1 = 3 points each; all three to house 2; one token per clear
    type Hub = { pointsEarned: number; house: { id: number; points: number }; rewards: { balance: number; mocktailCost: number } };
    const hub = (await (await page.request.get('/api/arcade/rounds')).json()) as Hub;
    expect(hub.pointsEarned).toBe(9);
    expect(hub.house).toMatchObject({ id: 2, points: 9 });
    expect(hub.rewards).toMatchObject({ balance: 3, mocktailCost: 3 });

    // the bar: look up the kit, double-press the claim; one mocktail, standings untouched
    const houses = async () => ((await api<{ houses: { points: number }[] }>('GET', '/api/arcade/rounds/houses')).houses.map((h) => h.points));
    const total = async () => ((await (await page.request.get('/api/points/me')).json()) as { total: number }).total;
    const [h0, t0] = [await houses(), await total()];
    await con.reload();
    await con.getByLabel('kit ID at the bar').fill(kit.kitId);
    await con.getByRole('button', { name: 'look up' }).click();
    await con.getByRole('button', { name: /hand over a mocktail/ }).dblclick();
    await expect(con.getByRole('button', { name: /needs 3 tokens/ })).toBeVisible({ timeout: 5000 });
    const person = await api<{ claims: unknown[]; rewards: { balance: number } }>('GET', `/api/arcade/rounds/admin/person?kit=${kit.kitId}`);
    expect(person.claims).toHaveLength(1);
    expect(person.rewards.balance).toBe(0);
    expect(await houses()).toEqual(h0);
    expect(await total()).toBe(t0);
    await page.context().close();
    await con.context().close();
  });
});
