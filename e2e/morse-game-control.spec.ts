// The console's "morse game" box: start shows the game to players; stop + reset (tap twice) hides it and wipes it.
import { expect, test } from '@playwright/test';

test('console: start the morse game, then stop + reset it', async ({ browser }, info) => {
  const baseURL = String(info.project.use.baseURL);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL });
  const page = await ctx.newPage();
  expect((await page.request.post('/api/admin/session', { data: { pin: '2468' } })).ok()).toBeTruthy();
  const vis = async () => ((await (await page.request.get('/api/hunt/visibility')).json()) as { morse: boolean }).morse;
  await page.request.put('/api/hunt/admin/visibility', { data: { morse: false } });
  await page.goto('/admin/cipher');
  const start = page.getByTestId('morse-game-start');
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByTestId('morse-game-start')).toHaveText(/it is live/);
  expect(await vis()).toBe(true);
  await page.screenshot({ path: 'docs/screens/cipher-console-game-control-1280.png' });
  const stop = page.getByTestId('morse-game-stop-reset');
  await stop.click();
  await expect(stop).toHaveText(/tap again/);
  await stop.click();
  await expect(page.getByTestId('morse-game-start')).toHaveText(/start the game/, { timeout: 15_000 });
  expect(await vis()).toBe(false);
  await ctx.close();
});
