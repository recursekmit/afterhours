// Quick screenshots of the built app for design review (not part of the test suite).
//   node scripts/shot.mjs <port> <out.png> <path> [width] [height] [scale] [selector]
// Starts nothing: point it at a running server (e2e/serve.mjs or npm start).
import { chromium } from '@playwright/test';

const [port, out, path, w = '1200', h = '800', scale = '1', selector] = process.argv.slice(2);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: Number(scale) });
  await page.goto(`http://127.0.0.1:${port}${path}`, { timeout: 20_000 });
  await page.waitForTimeout(1500);
  if (selector) await page.locator(selector).first().screenshot({ path: out });
  else await page.screenshot({ path: out });
} finally {
  await browser.close();
}
