// npm run seed — demo event state so anyone can try the app in two minutes.
//   npm run seed               seed an empty database
//   npm run seed -- --fresh    delete the database file first (stop the server first on Windows)
import { existsSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { avatarFromSeed, formatPassword } from '@afterhours/shared';
import Fastify from 'fastify';
import { createContext } from './app';
import { loadConfig } from './config';
import { generateKits } from './core/auth/kits';
import { one, run } from './core/db';
import { loadDotEnv } from './env';
import { features } from './features/registry';
import { seedOrder } from './core/seedOrder';

loadDotEnv();
const config = loadConfig();
const srcRoot = dirname(fileURLToPath(import.meta.url));
const fresh = process.argv.includes('--fresh');

if (fresh) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = config.databasePath + suffix;
    if (existsSync(f)) rmSync(f);
  }
  console.log(`wiped ${config.databasePath}`);
}

const log = Fastify({ logger: { level: 'warn' } }).log;
const ctx = createContext({ config, srcRoot, features, timers: false }, log);

const existing = one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM kits')?.n ?? 0;
if (existing > 0) {
  console.error(`\n${config.databasePath} already has ${existing} kits. Not touching it.`);
  console.error('Run `npm run seed -- --fresh` to wipe and reseed (stop the dev server first).\n');
  process.exit(1);
}

// Kits you sign in with. AH-001..005 are fresh (full first-sign-in flow);
// AH-006 already has a profile so you land straight on home.
const DEMO_PASSWORDS = ['BYTE42', 'PARTY2', 'MAGNET', 'ZEBRA7', 'QUEST5', 'RAVENS'];
const demo = await generateKits(
  ctx,
  [
    { name: 'Aarav Reddy', roll: '23BD1A0501' },
    { name: 'Diya Sharma', roll: '23BD1A0502' },
    { name: null, roll: null },
    { name: null, roll: null },
    { name: null, roll: null },
    { name: 'Sana Qureshi', roll: '23BD1A0506' },
  ],
  DEMO_PASSWORDS,
);

// A crowd so presence counters and the leaderboard look alive.
const CROWD = [
  ['Rohan Varma', 'byte_bandit'], ['Meghana Rao', 'meg'], ['Karthik N', 'kx'], ['Ishita Jain', 'ishh'],
  ['Vikram Singh', 'vik.exe'], ['Ananya Iyer', 'nanu'], ['Harsha Vardhan', 'harshaa'], ['Pooja Kulkarni', 'pooj'],
  ['Arjun Das', 'arjun_d'], ['Sneha Patel', 'snehaaa'], ['Rahul Menon', 'rm -rf'], ['Tanvi Goud', 'tanvi'],
  ['Nikhil Rao', 'nik'], ['Fatima Khan', 'fatz'], ['Siddharth M', 'sid'], ['Keerthi S', 'keerthi'],
  ['Aditya P', 'adi404'], ['Lavanya T', 'lavs'], ['Manish Kumar', 'mk'], ['Divya Reddy', 'divvy'],
] as const;
const crowd = await generateKits(
  ctx,
  CROWD.map(([name], i) => ({ name, roll: `23BD1A05${String(40 + i).padStart(2, '0')}` })),
);

const now = ctx.now();
function seedAttendee(kitId: string, name: string, roll: string, nickname: string, avatarSeed: number, minutesAgo: number) {
  const at = now - minutesAgo * 60_000;
  const r = run(
    ctx.db,
    `INSERT INTO attendees (kit_id, name, roll, nickname, avatar, profile_complete, first_signin_at, profile_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    kitId,
    name,
    roll,
    nickname,
    JSON.stringify(avatarFromSeed(avatarSeed)),
    at,
    at + 60_000,
  );
  const id = r.lastId;
  ctx.points.award({ attendeeId: id, source: 'core', ref: 'signin', points: 10, label: 'showed up' });
  ctx.points.award({ attendeeId: id, source: 'core', ref: 'profile', points: 10, label: 'made a face' });
  ctx.stickers.unlock(id, 'showed-up');
  ctx.stickers.unlock(id, 'new-face');
  return id;
}

crowd.forEach((k, i) => {
  const [, nickname] = CROWD[i] ?? ['', 'someone'];
  const id = seedAttendee(k.kitId, k.name ?? 'Someone', k.roll ?? 'X', nickname, i * 7 + 3, 40 - i);
  const bonus = (i * 37) % 90;
  if (bonus > 0) ctx.points.award({ attendeeId: id, source: 'demo', ref: 'warmup', points: bonus, label: 'demo points' });
});

const sana = demo[5];
if (sana) {
  const id = seedAttendee(sana.kitId, sana.name ?? 'Sana', sana.roll ?? 'X', 'sana', 11, 5);
  ctx.points.award({ attendeeId: id, source: 'demo', ref: 'warmup', points: 35, label: 'demo points' });
}

for (const f of seedOrder(features)) {
  if (f.seed) {
    await f.seed(ctx);
    console.log(`seeded feature: ${f.name}`);
  }
}
ctx.points.close();
ctx.live.close();
ctx.db.close();

const pad = (s: string, n: number) => s.padEnd(n);
console.log('\n  After Hours demo is seeded.\n');
console.log(`  ${pad('kit', 8)}${pad('password', 10)}state`);
demo.forEach((k, i) => {
  const state = i === 5 ? 'profile done, lands on home' : k.name ? `fresh, prefilled as ${k.name}` : 'fresh, blank';
  console.log(`  ${pad(k.kitId, 8)}${pad(formatPassword(k.password), 10)}${state}`);
});
console.log(`\n  + ${crowd.length} demo attendees with points (random passwords, not printed)`);
console.log(`  console PIN: ${config.adminPin}   projector PIN: ${config.screenPin}   gate PIN: ${config.gatePin}`);
console.log(`  app: ${config.appUrl}/   console: ${config.appUrl}/admin   projector: ${config.appUrl}/screen   gate: ${config.appUrl}/gate\n`);
