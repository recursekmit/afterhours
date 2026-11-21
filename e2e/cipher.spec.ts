/*
  The Cipher Ticket, end to end (E2E_PORT=4907).
  1. The console creates the morse slip (slips I-IV x 80, a design per copy) and shows the morse challenge.
  2. Phone A's slip I (printed by the real renderer in its own design) is seen by the fake camera: the
     scan claims set A, the oath names slip I's guild. Phone B claims a set of another guild by typing a
     slip III word.
  3. Both do the four winds (B reads slip I's top upside down: cursed), the echo (decode slip II's named
     edge, tap it on the brass key), the whisper and the riddle (slip III), then see "next trials open soon"
     (M1, the pact closed).
  4. Screenshots: every trial on the phone at 390, the guild race on the projector at 1920, the console at 1280.
  Run: npm run build && E2E_PORT=4907 npx playwright test e2e/cipher.spec.ts
*/
import { type APIRequestContext, type BrowserContext, chromium, expect, type Page, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { decodePng } from '../web/src/lib/slips/scanner/testing/png';
import { cameraScene, type FloatImage, rgbaToFloat } from '../web/src/lib/slips/scanner/testing/synth';

const SHOTS = 'docs/screens';
const TMP = join('.playwright', 'cipher');
mkdirSync(TMP, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 4310);
const BASE = `http://127.0.0.1:${PORT}`;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } as const;
const MORSE: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-', '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
};

type Edge = 'bottom' | 'right' | 'top' | 'left';
type Edges = Record<Edge, { word: string; morse: string } | null>;
type State = Awaited<ReturnType<BrowserContext['storageState']>>;
interface Slip {
  serial: number;
  slipNo: number;
  ticket: string;
  edges: Edges;
}

let admin: APIRequestContext;
let setId = 0;
const slips = new Map<string, Slip>(); // `${serial}:${slipNo}`
const sets: Record<'a' | 'b', number> = { a: 0, b: 0 };
let print: FloatImage | null = null;
const phones: Record<'a' | 'b', State | null> = { a: null, b: null };
const key: Map<number, Record<string, string>> = new Map();

const slip = (serial: number, n: number) => slips.get(`${serial}:${n}`)!;
const word = (serial: number, n: number, e: Edge) => slip(serial, n).edges[e]!.word;

async function api<T = unknown>(method: 'GET' | 'POST' | 'PUT', path: string, data?: unknown): Promise<T> {
  const r = await admin.fetch(path, { method, data: data as object | undefined });
  expect(r.ok(), `${method} ${path}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()) as T;
}

function writeY4m(path: string, frames: { width: number; height: number; data: Uint8Array }[]) {
  const { width, height } = frames[0]!;
  const parts: Buffer[] = [Buffer.from(`YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420jpeg\n`)];
  const chroma = Buffer.alloc((width / 2) * (height / 2), 128);
  for (const f of frames) parts.push(Buffer.from('FRAME\n'), Buffer.from(f.data), chroma, chroma);
  writeFileSync(path, Buffer.concat(parts));
}

/** A phone; with `roll`, its camera sees phone A's printed slip I turned that many degrees. */
async function phone(who: 'a' | 'b', fn: (page: Page) => Promise<void>, roll?: number) {
  const args = ['--use-fake-ui-for-media-stream'];
  if (roll !== undefined && print) {
    const y4m = join(TMP, `slip-${roll}.y4m`);
    writeY4m(
      y4m,
      [0, 1, 2].map((k) => cameraScene(print!, { slipMm: { w: 146 + 12, h: 66 + 12 }, width: 1080, height: 1920, pxPerMm: 5.6, blur: 0.8, noise: 0.012, rollDeg: roll + 4 + k * 0.4, pitchDeg: 8, seed: 300 + k + roll })),
    );
    args.push('--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`);
  }
  const b = await chromium.launch({ args });
  try {
    const ctx = await b.newContext({ ...PHONE, baseURL: BASE, permissions: ['camera'], storageState: phones[who] ?? undefined });
    const page = await ctx.newPage();
    // a sealed trial unlocks a sticker: its celebration pops over everything; stick it in
    await page.addLocatorHandler(
      page.getByRole('button', { name: 'stick it in' }).first(),
      async (b) => {
        await b.click().catch(() => undefined);
      },
      { noWaitAfter: true },
    );
    await fn(page);
    phones[who] = await ctx.storageState();
    await ctx.close();
  } finally {
    await b.close();
  }
}

async function typeReading(page: Page, text: string, outcome = true) {
  await page.getByTestId('cipher-type').fill(text);
  await page.getByRole('button', { name: 'read it' }).click();
  if (outcome) await expect(page.getByTestId('cipher-outcome')).toContainText(/./);
}

async function waitSealed(page: Page, trial: string) {
  await expect(page.getByTestId(`star-${trial}`)).toHaveAttribute('data-sealed', 'yes', { timeout: 10_000 });
  await page.getByTestId('seal-overlay').click({ timeout: 4000 }).catch(() => undefined);
  await page.getByRole('button', { name: 'stick it in' }).click({ timeout: 4000 }).catch(() => undefined);
}

/** Tap a word on the brass key: unit 150 ms, real pointer presses. */
async function tapWord(page: Page, w: string) {
  const keyEl = page.getByRole('button', { name: 'tap and hold' });
  await keyEl.scrollIntoViewIfNeeded();
  const box = (await keyEl.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const u = 200;
  const letters = [...w.toUpperCase()].map((c) => MORSE[c]!);
  for (const [li, code] of letters.entries()) {
    if (li > 0) await page.waitForTimeout(3 * u);
    for (const [si, el] of [...code].entries()) {
      if (si > 0) await page.waitForTimeout(u);
      await page.mouse.down();
      await page.waitForTimeout(el === '.' ? u : 3 * u);
      await page.mouse.up();
    }
  }
}

function parseCsv(text: string): Record<string, string>[] {
  const [head, ...rows] = text.trim().split('\n');
  const cols = head!.split(',');
  return rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [cols[i]!, v])));
}

test.describe.serial('the cipher: two phones, two guilds, all seven trials', () => {
  test.describe.configure({ timeout: 180_000 });
  test.beforeAll(async ({ playwright }) => {
    admin = await playwright.request.newContext({ baseURL: BASE });
    expect((await admin.post('/api/admin/session', { data: { pin: '2468' } })).ok()).toBeTruthy();
  });

  test('set up: the morse slip, the challenge shown, two phones, slip I of set A printed', async ({ browser }) => {
    ({ setId } = await api<{ setId: number }>('POST', '/api/hunt/admin/morse-slip'));
    await api('PUT', '/api/hunt/admin/visibility', { morse: true });
    const sheet = await api<{ slips: Slip[] }>('GET', `/api/hunt/admin/slip-print?set=${setId}`);
    for (const s of sheet.slips) slips.set(`${s.serial}:${s.slipNo}`, s);
    sets.a = 1;
    sets.b = [...Array(80).keys()].map((i) => i + 1).find((n) => slip(n, 1).ticket !== slip(1, 1).ticket)!;
    expect(slip(sets.b, 1).ticket).not.toBe(slip(sets.a, 1).ticket);

    const ctx = await browser.newContext({ viewport: { width: 900, height: 500 }, deviceScaleFactor: 3 });
    const page = await ctx.newPage();
    const e = slip(1, 1).edges;
    await page.goto(`${BASE}/dev/slips?size=quad&ticket=${slip(1, 1).ticket}&b=${e.bottom!.word}&r=${e.right!.word}&t=${e.top!.word}&l=${e.left!.word}&n=1&serial=1&print=1`);
    const el = page.getByTestId('slip-print');
    await expect(el.locator('svg').first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const png = await el.screenshot();
    const img = await decodePng(new Uint8Array(png), (d) => inflateSync(d));
    print = rgbaToFloat(img.rgba, img.width, img.height);
    await ctx.close();

    const kits = (await api<{ kits: { kitId: string; password: string }[] }>('POST', '/api/admin/kits', { mode: 'blank', count: 2 })).kits;
    for (const [i, who] of (['a', 'b'] as const).entries()) {
      const pctx = await browser.newContext({ ...PHONE, baseURL: BASE });
      expect((await pctx.request.post('/api/auth/signin', { data: kits[i] })).ok()).toBeTruthy();
      const avatar = { shape: 'blob', color: i ? 'pink' : 'sky', eyes: 'wide', mouth: 'grin', top: 'none', extra: 'none' };
      expect((await pctx.request.put('/api/me/profile', { data: { name: `Cipher ${who}`, roll: `C${i}`, nickname: `cipher ${who}`, avatar } })).ok()).toBeTruthy();
      phones[who] = await pctx.storageState();
      await pctx.close();
    }
  });

  test('the oath: A claims by camera, B by typing a slip III word; each sworn into its own guild', async () => {
    await phone('a', async (page) => {
      await page.goto('/morse');
      await expect(page.getByTestId('cipher-card')).toBeVisible();
      await page.getByTestId('cipher-open').click();
      await expect(page.getByTestId('trial-oath')).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/cipher-claim-390.png`, fullPage: true });
    });
    await phone(
      'a',
      async (page) => {
        await page.goto('/morse/cipher');
        await page.getByTestId('slip-scan-open').click();
        await expect(page.getByTestId('oath-guild')).toBeVisible({ timeout: 20_000 });
        await expect(page.getByTestId('rune-bottom')).toHaveCount(0);
      },
      0,
    );
    await phone('b', async (page) => {
      await page.goto('/morse/cipher');
      await typeReading(page, word(sets.b, 3, 'left'), false);
      await expect(page.getByTestId('oath-guild')).toBeVisible();
    });
    for (const who of ['a', 'b'] as const) {
      await phone(who, async (page) => {
        await page.goto('/morse/cipher');
        const guild = slip(sets[who], 1).ticket;
        await expect(page.getByTestId('oath-guild')).toContainText(guild, { ignoreCase: true });
        await page.waitForTimeout(500);
        if (who === 'a') await page.screenshot({ path: `${SHOTS}/cipher-oath-390.png`, fullPage: true });
        await page.getByTestId('swear').click();
        await waitSealed(page, 'oath');
        await expect(page.getByTestId('trial-winds')).toBeVisible();
      });
    }
  });

  test('the four winds on slip I; B reads the top upside down: cursed, still counts', async () => {
    for (const who of ['a', 'b'] as const) {
      await phone(who, async (page) => {
        await page.goto('/morse/cipher');
        const s = sets[who];
        const edges: Edge[] = who === 'a' ? ['right', 'top', 'left'] : ['bottom', 'right'];
        for (const [i, e] of edges.entries()) await typeReading(page, word(s, 1, e), who === 'b' || i < edges.length - 1);
        if (who === 'b') {
          await page.screenshot({ path: `${SHOTS}/cipher-winds-390.png`, fullPage: true });
          // the top strip read as seen, upside down: the symbol sequence reversed
          const up = [...slip(s, 1).edges.top!.morse].reverse().join('');
          const r = await page.request.post('/api/cipher/scan', { data: { morse: up } });
          expect(((await r.json()) as { outcome: string }).outcome).toBe('cursed');
          await page.reload();
          await expect(page.getByTestId('rune-top')).toHaveAttribute('data-lit', 'yes');
          await page.screenshot({ path: `${SHOTS}/cipher-winds-cursed-390.png`, fullPage: true });
          await typeReading(page, word(s, 1, 'left'), false);
        }
        await waitSealed(page, 'winds');
        await expect(page.getByTestId('trial-echo')).toBeVisible();
      });
    }
  });

  test('the echo: decode the named edge of slip II, tap it on the brass key', async () => {
    for (const who of ['a', 'b'] as const) {
      await phone(who, async (page) => {
        await page.goto('/morse/cipher');
        const me = (await (await page.request.get('/api/cipher/me')).json()) as { echo: { edge: Edge; word: string | null } };
        expect(me.echo.word).toBeNull();
        await tapWord(page, word(sets[who], 2, me.echo.edge));
        if (who === 'a') await page.screenshot({ path: `${SHOTS}/cipher-echo-390.png`, fullPage: true });
        const sent = page.waitForResponse((r) => r.url().endsWith('/api/cipher/echo'));
        await page.getByTestId('echo-send').click();
        const echo = (await (await sent).json()) as { passed: boolean; verdict: string; decoded: string; message: string };
        expect(echo.passed, `${echo.verdict} ${echo.decoded} ${echo.message}`).toBe(true);
        await waitSealed(page, 'echo');
        await expect(page.getByTestId('trial-whisper')).toBeVisible();
      });
    }
    const csv = await admin.get('/api/cipher/admin/answer-key.csv');
    for (const r of parseCsv(await csv.text())) key.set(Number(r.serial), r);
  });

  test('the whisper: a word on no slip, played as light, sound and buzz; then the riddle on slip III', async () => {
    for (const who of ['a', 'b'] as const) {
      await phone(who, async (page) => {
        await page.goto('/morse/cipher');
        await page.getByTestId('whisper-play').click();
        await expect(page.getByTestId('whisper-flash')).toBeVisible();
        if (who === 'a') {
          await page.waitForTimeout(900);
          await page.screenshot({ path: `${SHOTS}/cipher-whisper-390.png`, fullPage: true });
        }
        const k = key.get(sets[who])!;
        await page.getByTestId('whisper-guess').fill(k.whisper_word!);
        await page.getByRole('button', { name: 'answer' }).click();
        await waitSealed(page, 'whisper');
        await expect(page.getByTestId('trial-riddle')).toBeVisible();
        await expect(page.getByTestId('riddle-text')).toContainText(k.riddle_rule === 'first' ? 'first' : 'last');
        if (who === 'a') await page.screenshot({ path: `${SHOTS}/cipher-riddle-390.png`, fullPage: true });
        // a slip III word that is not the answer is named as such
        const other = (['bottom', 'right', 'top', 'left'] as Edge[]).map((e) => word(sets[who], 3, e)).find((w) => w !== k.riddle_answer)!;
        await page.getByTestId('riddle-guess').fill(other);
        await page.getByRole('button', { name: 'answer' }).click();
        await expect(page.getByTestId('cipher-outcome')).toContainText('not the one the riddle asks for');
        await page.getByTestId('riddle-guess').fill(k.riddle_answer!);
        await page.getByRole('button', { name: 'answer' }).click();
        await waitSealed(page, 'riddle');
      });
    }
  });

  test('M1: with the pact closed, both see "next trials open soon"', async () => {
    const adm = await api<{ settings: Record<string, unknown> }>('GET', '/api/cipher/admin');
    await api('PUT', '/api/cipher/admin/settings', { ...adm.settings, pactOpen: false });
    await phone('a', async (page) => {
      await page.goto('/morse/cipher');
      await expect(page.getByTestId('next-soon')).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/cipher-soon-390.png`, fullPage: true });
    });
    await api('PUT', '/api/cipher/admin/settings', { ...adm.settings, pactOpen: true });
  });

  test('the pact: paired across guilds, each scans the other’s slip IV at the named edge', async () => {
    for (const [who, other] of [['a', 'b'], ['b', 'a']] as const) {
      await phone(who, async (page) => {
        await page.goto('/morse/cipher');
        await expect(page.getByTestId('pact-partner')).toContainText(`cipher ${other}`, { timeout: 10_000 });
        const me = (await (await page.request.get('/api/cipher/me')).json()) as { pact: { scanEdge: Edge; partner: { guild: string } } };
        expect(me.pact.partner.guild).toBe(slip(sets[other], 1).ticket);
        if (who === 'a') await page.screenshot({ path: `${SHOTS}/cipher-pact-390.png`, fullPage: true });
        await typeReading(page, word(sets[other], 4, me.pact.scanEdge), who === 'a');
        if (who === 'a') {
          await expect(page.getByTestId('pact-you')).toBeVisible();
          await page.screenshot({ path: `${SHOTS}/cipher-pact-half-390.png`, fullPage: true });
        } else {
          await waitSealed(page, 'pact');
        }
      });
    }
    await phone('a', async (page) => {
      await page.goto('/morse/cipher');
      await expect(page.getByTestId('star-pact')).toHaveAttribute('data-sealed', 'yes');
    });
  });

  test('the last signal: warn, fire, the projector flashes it, both phones answer, the guild is proclaimed, reveal', async ({ browser }) => {
    // console: announce it 5 minutes ahead
    const cctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: BASE });
    const con = await cctx.newPage();
    await con.request.post('/api/admin/session', { data: { pin: '2468' } });
    await con.goto('/admin/cipher');
    await con.getByTestId('signal-warn').click();
    await expect(con.getByTestId('signal-fire')).toBeVisible();
    await con.getByTestId('signal-fire').scrollIntoViewIfNeeded();
    await con.screenshot({ path: `${SHOTS}/cipher-console-signal-1280.png` });

    const pctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, baseURL: BASE });
    const proj = await pctx.newPage();
    await proj.request.post('/api/screen/session', { data: { pin: '1357' } });
    await api('POST', '/api/admin/screen/pin', { sceneId: null });
    await proj.goto('/screen');
    await expect(proj.getByTestId('signal-scene')).toBeVisible({ timeout: 15_000 });
    await proj.waitForTimeout(800);
    await proj.screenshot({ path: `${SHOTS}/cipher-signal-warned-1920.png` });

    await phone('a', async (page) => {
      await page.goto('/morse/cipher');
      await expect(page.getByTestId('signal-warned')).toBeVisible();
    });

    // fire it from the console
    await con.getByTestId('signal-fire').click();
    await expect(con.getByTestId('signal-close')).toBeVisible();
    await expect(proj.getByTestId('signal-lamp')).toBeVisible({ timeout: 15_000 });
    await expect(proj.getByTestId('signal-lamp')).toHaveClass(/lampOn/, { timeout: 8000 });
    await proj.screenshot({ path: `${SHOTS}/cipher-signal-live-1920.png` });

    const word = (await api<{ signalWord: string }>('GET', '/api/cipher/admin')).signalWord;
    for (const who of ['a', 'b'] as const) {
      await phone(who, async (page) => {
        await page.goto('/morse/cipher');
        await expect(page.getByTestId('signal-live')).toBeVisible();
        await page.getByTestId('signal-guess').fill(word);
        if (who === 'a') await page.screenshot({ path: `${SHOTS}/cipher-signal-390.png`, fullPage: true });
        const sent = page.waitForResponse((r) => r.url().endsWith('/api/cipher/signal'));
        await page.getByRole('button', { name: 'send' }).click();
        const res = (await (await sent).json()) as { correct: boolean; message: string };
        expect(res.correct).toBe(true);
        expect(res.message).toContain(who === 'a' ? '#1' : '#2');
        await waitSealed(page, 'signal');
      });
    }

    // close: the proclamation; then reveal the word everywhere
    await con.getByTestId('signal-close').click();
    await expect(proj.getByTestId('signal-proclamation')).toBeVisible({ timeout: 15_000 });
    await con.getByTestId('signal-reveal').click();
    await expect(proj.getByTestId('signal-proclamation')).toContainText(word, { timeout: 15_000 });
    await proj.waitForTimeout(1500);
    await proj.screenshot({ path: `${SHOTS}/cipher-signal-proclaim-1920.png` });
    await pctx.close();
    await cctx.close();
    await phone('a', async (page) => {
      await page.goto('/morse/cipher');
      await expect(page.getByTestId('cipher-done')).toContainText('#1 on the last signal');
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/cipher-done-390.png`, fullPage: true });
    });
  });

  test('projector: the guild race; console: progress and difficulty', async ({ browser }) => {
    const pctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, baseURL: BASE });
    const page = await pctx.newPage();
    await page.request.post('/api/screen/session', { data: { pin: '1357' } });
    await api('POST', '/api/admin/screen/pin', { sceneId: 'cipher-morse' });
    await page.goto('/screen');
    await expect(page.getByTestId('cipher-scene')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`race-${slip(sets.a, 1).ticket}`)).toBeVisible();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${SHOTS}/cipher-race-1920.png` });
    await api('POST', '/api/admin/screen/pin', { sceneId: null });
    await pctx.close();

    const cctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: BASE });
    const con = await cctx.newPage();
    await con.request.post('/api/admin/session', { data: { pin: '2468' } });
    await con.goto('/admin/cipher');
    await expect(con.getByTestId('cipher-players')).toContainText('cipher a');
    await expect(con.getByTestId('cipher-players')).toContainText('cipher b');
    await con.waitForTimeout(400);
    await con.screenshot({ path: `${SHOTS}/cipher-console-1280.png`, fullPage: true });
    await cctx.close();
  });
});
