// Online Morse per student: words are picked per attendee per round, and neighbours playing the same
// level at the same time never share an answer while the pool allows it (pickWord in index.ts).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestApp, adminJar, makeApp, req } from '../../../test/helpers';
import { startRound } from './index';
import { WORDS } from './words';

describe('online morse: words spread over the room', () => {
  let t: TestApp;
  const people: number[] = [];
  beforeEach(async () => {
    t = await makeApp();
    people.length = 0;
    for (let i = 0; i < 140; i++) {
      t.ctx.db.prepare('INSERT INTO kits (id, password_hash, created_at) VALUES (?, ?, ?)').run(`SP-${i}`, 'x', t.clock.now());
      const r = t.ctx.db.prepare("INSERT INTO attendees (kit_id, name, roll, nickname, profile_complete, first_signin_at) VALUES (?, 'n', 'r', ?, 1, ?)").run(`SP-${i}`, `p${i}`, t.clock.now());
      people.push(Number(r.lastInsertRowid));
    }
  });
  afterEach(async () => t.close());
  const wordOf = (id: string) => (t.ctx.db.prepare('SELECT word FROM morse_rounds WHERE id = ?').get(id) as { word: string }).word;

  it('everyone playing level 1 at once gets a different word, as long as the pool lasts', () => {
    const pool = WORDS[1]!;
    const n = pool.length; // 50 words at level 1
    const words = people.slice(0, n).map((id) => wordOf(startRound(t.ctx, id, 'decode', 1, false).id));
    expect(new Set(words).size).toBe(n);
  });

  it('decode and encode share the guard: an encode round on screen never shows a neighbour\'s decode word', () => {
    const half = Math.floor(WORDS[1]!.length / 2);
    const dec = people.slice(0, half).map((id) => wordOf(startRound(t.ctx, id, 'decode', 1, false).id));
    const enc = people.slice(half, 2 * half).map((id) => wordOf(startRound(t.ctx, id, 'encode', 1, false).id));
    expect(new Set([...dec, ...enc]).size).toBe(2 * half);
  });

  it('a whole room in one speed round: beyond the pool, every word is used as evenly as possible', async () => {
    const admin = await adminJar(t.app);
    expect((await req(t.app, admin, 'POST', '/api/morse/admin/sprint', { mode: 'decode', level: 3, durationSec: 300 })).statusCode).toBe(200);
    const words = people.map((id) => wordOf(startRound(t.ctx, id, 'decode', 3, true).id)); // 140 people, 50 words
    const counts = new Map<string, number>();
    for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
    expect(counts.size).toBe(WORDS[3]!.length);
    const c = [...counts.values()];
    expect(Math.max(...c) - Math.min(...c)).toBeLessThanOrEqual(1);
  });

  it('a word frees up when its round closes; my own recent words are still avoided', () => {
    const [me, other] = [people[0]!, people[1]!];
    const first = startRound(t.ctx, other, 'decode', 1, false);
    const held = wordOf(first.id);
    // while other holds it, nobody gets it
    for (let i = 2; i < 30; i++) expect(wordOf(startRound(t.ctx, people[i]!, 'decode', 1, false).id)).not.toBe(held);
    // my next ten rounds never repeat one of my last words
    const mine: string[] = [];
    for (let i = 0; i < 8; i++) {
      mine.push(wordOf(startRound(t.ctx, me, 'decode', 1, false).id));
      t.clock.advance(2500);
    }
    expect(new Set(mine).size).toBe(8);
  });
});
