// Quick screenshots of the built app for design review (not part of the test suite).
//   node scripts/shot.mjs <port> <out.png> <path> [width] [height] [scale] [selector] [as]
//   as: 'attendee' signs in a fresh kit (with a profile) first, 'admin' / 'screen' use the e2e PINs.
// Starts nothing: point it at a running server (e2e/serve.mjs).
import { chromium } from '@playwright/test';

const [port, out, path, w = '1200', h = '800', scale = '1', selector = '', as = ''] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: Number(scale), baseURL: base, isMobile: Number(w) < 600, hasTouch: Number(w) < 600 });
  if (as === 'attendee') {
    const admin = await browser.newContext({ baseURL: base });
    await admin.request.post('/api/admin/session', { data: { pin: '2468' } });
    const kit = (await (await admin.request.post('/api/admin/kits', { data: { mode: 'blank', count: 1 } })).json()).kits[0];
    await admin.close();
    await ctx.request.post('/api/auth/signin', { data: kit });
    await ctx.request.put('/api/me/profile', { data: { name: 'Shot', roll: 'S1', nickname: 'lanternlight', avatar: { shape: 'blob', color: 'sun', eyes: 'wide', mouth: 'grin', top: 'none', extra: 'none' } } });
  } else if (as === 'admin') await ctx.request.post('/api/admin/session', { data: { pin: '2468' } });
  else if (as === 'screen') await ctx.request.post('/api/screen/session', { data: { pin: '1357' } });
  const page = await ctx.newPage();
  await page.goto(path, { timeout: 20_000 });
  await page.waitForTimeout(2500);
  if (selector) await page.locator(selector).first().screenshot({ path: out });
  else await page.screenshot({ path: out, fullPage: Number(h) > 2000 });
} finally {
  await browser.close();
}
