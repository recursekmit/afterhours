// "Still here?": a phone taps "I'm here" on the home screen; the console's prize board lists them.
import { expect, test } from '@playwright/test';

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } as const;

test('phone taps "I am here", console prize board shows them', async ({ browser, playwright }, info) => {
  const baseURL = String(info.project.use.baseURL);
  const admin = await playwright.request.newContext({ baseURL });
  expect((await admin.post('/api/admin/session', { data: { pin: '2468' } })).ok()).toBeTruthy();
  expect((await admin.post('/api/leaderboard/admin/here/clear', { data: { confirm: 'CLEAR' } })).ok()).toBeTruthy();
  const { kits } = (await (await admin.post('/api/admin/kits', { data: { mode: 'blank', count: 1 } })).json()) as { kits: { kitId: string; password: string }[] };

  const ctx = await browser.newContext({ ...PHONE, baseURL });
  const page = await ctx.newPage();
  expect((await page.request.post('/api/auth/signin', { data: kits[0] })).ok()).toBeTruthy();
  expect(
    (await page.request.put('/api/me/profile', { data: { name: 'still here e2e', roll: 'SH1', avatar: { shape: 'blob', color: 'pink', eyes: 'wide', mouth: 'grin', top: 'none', extra: 'none' } } })).ok(),
  ).toBeTruthy();
  await page.goto('/');
  await page.getByTestId('here-tap').first().click();
  await expect(page.getByTestId('here-card').first()).toContainText("you're marked as here");
  await page.screenshot({ path: 'docs/screens/still-here-phone-390.png' });

  const con = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL });
  const cp = await con.newPage();
  expect((await cp.request.post('/api/admin/session', { data: { pin: '2468' } })).ok()).toBeTruthy();
  await cp.goto('/admin/leaderboard');
  await expect(cp.getByTestId('here-board')).toContainText('still here e2e');
  await cp.screenshot({ path: 'docs/screens/still-here-console-1280.png' });
  await ctx.close();
  await con.close();
  await admin.dispose();
});
