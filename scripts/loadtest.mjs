// Load test: N simulated phones against a running server (default 300).
//   node scripts/loadtest.mjs http://127.0.0.1:4500 [count]
// Needs the admin PIN (ADMIN_PIN env, default 2468) and a server started with a high
// LOGIN_IP_PER_MIN, because every bot signs in from the same IP.
// Each bot: signs in, saves a profile, holds an SSE stream open, votes in the live poll,
// checks in with the projector code, starts the hunt and stamps its first stop, plays a full
// Lag Spike arcade run. Reports errors and latency per step.
const BASE = (process.argv[2] ?? 'http://127.0.0.1:4500').replace(/\/$/, '');
const N = Number(process.argv[3] ?? 300);
const PIN = process.env.ADMIN_PIN ?? '2468';

const stats = new Map();
const errors = [];
function record(step, ms, ok, detail) {
  const s = stats.get(step) ?? { n: 0, fail: 0, ms: [] };
  s.n++;
  if (!ok) {
    s.fail++;
    if (errors.length < 30) errors.push(`${step}: ${detail}`);
  }
  s.ms.push(ms);
  stats.set(step, s);
}

class Client {
  constructor() {
    this.cookies = {};
  }
  header() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  keep(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      this.cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
  }
  async call(step, method, path, body) {
    const t0 = performance.now();
    try {
      const res = await fetch(BASE + path, {
        method,
        headers: { cookie: this.header(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      this.keep(res);
      const text = await res.text();
      const ms = performance.now() - t0;
      record(step, ms, res.ok, `${res.status} ${text.slice(0, 120)}`);
      return { ok: res.ok, status: res.status, json: text ? JSON.parse(text) : null };
    } catch (e) {
      record(step, performance.now() - t0, false, String(e));
      return { ok: false, status: 0, json: null };
    }
  }
  /** Open the live stream and resolve once the hello frame arrives. Returns a closer. */
  async stream() {
    const t0 = performance.now();
    const ctrl = new AbortController();
    try {
      const res = await fetch(BASE + '/api/live', { headers: { cookie: this.header(), accept: 'text/event-stream' }, signal: ctrl.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let frames = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
        if (buf.includes('event: hello')) {
          record('sse hello', performance.now() - t0, true);
          break;
        }
      }
      // keep draining in the background so the server never blocks on us
      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            frames += (dec.decode(value).match(/\n\n/g) ?? []).length;
          }
        } catch {
          /* aborted */
        }
      })();
      return { close: () => ctrl.abort(), frames: () => frames };
    } catch (e) {
      record('sse hello', performance.now() - t0, false, String(e));
      return { close: () => ctrl.abort(), frames: () => 0 };
    }
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const admin = new Client();
  if (!(await admin.call('admin pin', 'POST', '/api/admin/session', { pin: PIN })).ok) throw new Error('admin PIN refused');
  const kits = (await admin.call('make kits', 'POST', '/api/admin/kits', { mode: 'blank', count: N })).json.kits;
  const now = Date.now();
  const st = (await admin.call('schedule', 'POST', '/api/schedule', { title: 'load test talk', startAt: now - 60_000, endAt: now + 3_600_000 })).json;
  const activityId = String(st.activities.find((a) => a.title === 'load test talk').id);
  await admin.call('checkin open', 'POST', '/api/attendance/admin/open', { activityId });
  const poll = (await admin.call('poll', 'POST', '/api/polls/admin', { kind: 'single', question: 'load test: best editor?', options: [{ label: 'vim' }, { label: 'vs code' }, { label: 'nano' }] })).json;
  await admin.call('poll launch', 'POST', `/api/polls/admin/${poll.poll.id}/launch`, { closeCurrent: true });
  const existing = (await admin.call('hunt admin', 'GET', '/api/hunt/admin')).json;
  if (existing.stops.length < 2) {
    await admin.call('hunt stop', 'POST', '/api/hunt/admin/stops', { title: 'lt one', clue: 'c', answers: ['one'] });
    await admin.call('hunt stop', 'POST', '/api/hunt/admin/stops', { title: 'lt two', clue: 'c', answers: ['two'] });
  }
  if (existing.status !== 'open') await admin.call('hunt open', 'PUT', '/api/hunt/admin/state', { status: 'open' });
  const hunt = (await admin.call('hunt admin', 'GET', '/api/hunt/admin')).json;
  await admin.call('arcade on', 'POST', '/api/arcade/admin/settings', { enabled: true, games: { reaction: true } });
  return { admin, kits, activityId, pollId: poll.poll.id, tokens: new Map(hunt.stops.map((s) => [s.id, s.token])) };
}

async function bot(i, env) {
  const c = new Client();
  const kit = env.kits[i];
  if (!(await c.call('sign in', 'POST', '/api/auth/signin', { kitId: kit.kitId, password: kit.password })).ok) return null;
  await c.call('profile', 'PUT', '/api/me/profile', {
    name: `Bot ${i}`,
    roll: `B${i}`,
    nickname: `bot${i}`,
    avatar: { shape: 'blob', color: 'lime', eyes: 'wide', mouth: 'grin', top: 'none', extra: 'none' },
  });
  const live = await c.stream();
  await c.call('home: me', 'GET', '/api/me');
  await c.call('home: schedule', 'GET', '/api/schedule');
  await c.call('home: poll', 'GET', '/api/polls/current');
  await c.call('vote', 'POST', `/api/polls/${env.pollId}/vote`, { kind: 'single', choice: i % 3 });
  const code = (await env.admin.call('projector code', 'GET', '/api/attendance/screen')).json?.open.find((o) => o.activityId === env.activityId)?.code;
  if (code) await c.call('check in', 'POST', '/api/attendance/checkin', { code, activityId: env.activityId });
  const me = (await c.call('hunt start', 'POST', '/api/hunt/start', {})).json;
  const token = me?.current ? env.tokens.get(me.current.stopId) : null;
  if (token) await c.call('hunt scan', 'POST', '/api/hunt/scan', { code: token });
  const started = await c.call('arcade run', 'POST', '/api/arcade/runs', { game: 'reaction' });
  const run = started.ok ? started.json : null;
  if (run?.spec?.delaysMs) {
    const reactions = run.spec.delaysMs.map(() => 220 + Math.floor(Math.random() * 120));
    await wait(run.spec.delaysMs.reduce((a, b) => a + b, 0) + reactions.reduce((a, b) => a + b, 0) + 800);
    await c.call('arcade submit', 'POST', `/api/arcade/runs/${run.runId}/submit`, { reactions });
  }
  return live;
}

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};

const t0 = performance.now();
const env = await setup();
console.log(`setup done: ${env.kits.length} kits`);
// phones arrive over ~20 s, like a queue at the door, not all in one millisecond
const lives = await Promise.all(Array.from({ length: N }, (_, i) => wait((i / N) * 20_000).then(() => bot(i, env))));
// one broadcast to everyone, then count it arrived
await env.admin.call('announce', 'POST', '/api/alerts/announce', { title: 'load test', body: 'hello 300 phones', push: false });
await wait(3000);
const got = lives.filter((l) => l && l.frames() > 0).length;
for (const l of lives) l?.close();
console.log(`\n${N} bots in ${((performance.now() - t0) / 1000).toFixed(1)} s; ${got}/${N} streams received live frames\n`);
console.log('step'.padEnd(18), 'n'.padStart(5), 'fail'.padStart(5), 'p50'.padStart(7), 'p95'.padStart(7), 'max'.padStart(7));
for (const [step, s] of stats) {
  console.log(step.padEnd(18), String(s.n).padStart(5), String(s.fail).padStart(5), `${pct(s.ms, 50).toFixed(0)}ms`.padStart(7), `${pct(s.ms, 95).toFixed(0)}ms`.padStart(7), `${Math.max(...s.ms).toFixed(0)}ms`.padStart(7));
}
const fails = [...stats.values()].reduce((a, s) => a + s.fail, 0);
console.log(`\nerrors: ${fails}`);
for (const e of errors) console.log('  ', e);
process.exit(fails ? 1 : 0);
