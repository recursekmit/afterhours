// Demo content. Trail 1: a campus treasure hunt with a believable crowd mid-hunt. Trail 2: a Morse trail
// (objects around the venue carrying Morse). Trail 3: a Morse slip trail (kit slips whose four orientations
// branch). Trail 4: a slip hunt where your kit slip's orientation picks your first location.
// Trails 2, 3 and 4 are drafts (never shown). Trail 5: "the morse slip", the Morse challenge: ONE unique slip per kit
// (80 copies, own words, all four ticket designs), no venue locations. The treasure hunt (trail 1) runs on
// stickers and riddles only. Both player-visibility switches start off.
// Stickers go where `location` says; adjust the places to the real venue before printing.
import type { HuntStopInput } from '@afterhours/shared/features/hunt';
import { type FeatureContext, all, one, run } from '../../core';
import { slipMorseKey } from '@afterhours/shared/features/hunt';
import { bump, getTrail, loadStops, newCode, newSeed, newToken, orderFor, solveStop } from './engine';
import { syncCopies } from './unique';
import { createMorseSlip } from './morseSlip';

/** Unique copies printed for each seeded slip set: one per kit, plus spares. */
export const SEED_SLIP_COPIES = 80;

export const DEMO_STOPS: HuntStopInput[] = [
  {
    title: 'the semicolon',
    clue: "I'm half a comma and half a full stop. Forget me and a compiler writes you twelve pages of tears. Which little key sits just right of the L?",
    answers: ['semicolon', 'semi colon'],
    hints: ['Ends a statement in C, Java and JavaScript.', 'Fun fact: in Greek, this is the question mark.'],
    reveal: 'In Greek, a semicolon is a question mark. Somewhere a student is very confused.',
    location: 'Notice board outside the club room',
    glyph: 'spark',
    color: 'lime',
    points: 10,
  },
  {
    title: 'the keyboard',
    clue: "I have keys but open no locks. I have a space but no room. You can enter but never leave. Find where a hundred of my cousins sit in rows.",
    answers: ['keyboard', 'a keyboard'],
    hints: ['You are probably not holding one right now.', 'Escape, Enter, Space. It has all three.'],
    reveal: 'QWERTY was laid out in 1873 partly so typewriter arms would jam less. Nobody changed it since.',
    location: 'Computer lab door',
    glyph: 'key',
    color: 'sky',
    points: 10,
  },
  {
    title: 'the cache',
    clue: "I remember what you asked for last so you never wait twice. I'm tiny, fast and forgetful. Go where people queue for chai, they reuse the same order all day.",
    answers: ['cache', 'cash'],
    hints: ['A computer keeps hot data close in one of these.', 'Spelled like money, means memory.'],
    reveal: 'Your CPU has caches in three levels. The chai counter has one level: the same four orders.',
    location: 'Canteen chai counter',
    glyph: 'bolt',
    color: 'tangerine',
    points: 10,
  },
  {
    title: 'the answer to everything',
    clue: 'A supercomputer once spent 7.5 million years on the Ultimate Question and answered with this number. Written in binary it is 101010. What is it in plain decimal?',
    answers: ['42', 'forty two', 'forty-two'],
    hints: ['A hitchhiker knows the answer.', 'Four tens and a couple more.'],
    reveal: '101010 in binary is 32 + 8 + 2. The universe was just doing arithmetic.',
    location: 'Staircase landing, first floor',
    glyph: 'robot',
    color: 'grape',
    points: 10,
  },
  {
    title: 'the first bug',
    clue: 'In 1947 engineers found the first literal computer bug stuck in a Harvard Mark II relay. Which insect was it?',
    answers: ['moth', 'a moth'],
    hints: ['It loves lamps.', 'Four letters, starts with M.'],
    reveal: 'They taped it into the logbook with the note: first actual case of bug being found.',
    location: 'Library entrance',
    glyph: 'ghost',
    color: 'pink',
    points: 10,
  },
  {
    title: 'the recursion',
    clue: "To understand me you must first understand me. Our club is named after what I do. What's the word?",
    answers: ['recursion', 'recurse', 'recursive'],
    hints: ['A function that calls itself is doing it.', 'Google it, and see what it suggests next.'],
    reveal: 'Recurse. Recurse. Recurse. Okay we will stop, a stack overflow is a bad look at our own event.',
    location: 'Recurse banner at the club room',
    glyph: 'wave',
    color: 'sun',
    points: 10,
  },
  {
    title: 'the cloud',
    clue: "There is no me, really. I'm just someone else's computer with better marketing. Find the humming box in the corridor that blinks all day, my physical cousin.",
    answers: ['cloud', 'the cloud'],
    hints: ['Your photos live here, apparently.', 'It rains data, not water.'],
    reveal: 'The cloud is a few million computers in a cold warehouse, hoping you keep paying.',
    location: 'Wifi router box, ground floor corridor',
    glyph: 'wave',
    color: 'sky',
    points: 10,
  },
  {
    title: 'hello, world',
    clue: 'Final stop. Every programmer starts with the same two word program. Say it, and then find the main stage to claim your finish.',
    answers: ['hello world', 'hello, world!'],
    hints: ['Two words, the second is where we all live.', 'Comma optional. Enthusiasm mandatory.'],
    reveal: 'Brian Kernighan wrote the first hello world in 1972. You just wrote your own ending.',
    location: 'Main stage next to the projector',
    glyph: 'flag',
    color: 'tangerine',
    points: 15,
  },
];

export function seedHunt(ctx: FeatureContext): void {
  if ((one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM hunt_stops')?.n ?? 0) > 0) return;
  DEMO_STOPS.forEach((raw) => addStop(ctx, 1, raw));
  const now = ctx.now();
  run(ctx.db, "UPDATE hunt_trails SET status = 'open', opened_at = ?, title = ? WHERE id = 1", now - 45 * 60_000, 'the after hours hunt');

  // A crowd part way through, so the board and counters look alive. Demo kits AH-001..006 stay untouched.
  const crowd = all<{ id: number }>(ctx.db, "SELECT id FROM attendees WHERE profile_complete = 1 AND kit_id > 'AH-006' ORDER BY id");
  const stops = loadStops(ctx, 1);
  const trail = getTrail(ctx, 1);
  crowd.forEach((a, i) => {
    if (i >= 18) return;
    // 3 finish, the rest are spread over the route.
    const progress = i < 3 ? stops.length : (i * 5) % stops.length;
    const startedMin = 40 - i;
    const startedAt = now - startedMin * 60_000;
    run(ctx.db, 'INSERT INTO hunt_players (trail_id, attendee_id, started_at, last_at) VALUES (1, ?, ?, ?)', a.id, startedAt, startedAt);
    const order = orderFor(trail, a.id, stops.map((s) => s.id));
    const per = i < 3 ? (14 + i * 5) / stops.length : 4;
    for (let k = 0; k < progress; k++) {
      const stop = stops.find((s) => s.id === order[k]);
      if (stop) solveStop(ctx, a.id, stop, k % 3 === 0 ? 'qr' : 'answer', startedAt + Math.round((k + 1) * per * 60_000));
    }
  });
  seedMorseTrail(ctx);
  seedSlipTrail(ctx);
  seedSlipHunt(ctx);
  createMorseSlip(ctx); // the Morse challenge: one unique slip per kit
  bump(ctx);
}

interface SeedStop extends Partial<HuntStopInput> {
  title: string;
  clue: string;
}

function addTrail(ctx: FeatureContext, kind: 'hunt' | 'morse' | 'other', title: string, orderMode: 'shuffled' | 'fixed' | 'graph', status: 'draft' | 'open' = 'open'): number {
  const pos = (one<{ m: number | null }>(ctx.db, 'SELECT MAX(position) AS m FROM hunt_trails')?.m ?? 0) + 1;
  return run(
    ctx.db,
    'INSERT INTO hunt_trails (position, kind, title, status, order_mode, hints_on, cooldown_on, shuffle_seed, opened_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)',
    pos,
    kind,
    title,
    status,
    orderMode,
    newSeed(),
    status === 'open' ? ctx.now() : null,
  ).lastId;
}

function addStop(ctx: FeatureContext, trailId: number, raw: SeedStop): number {
  const pos = (one<{ m: number | null }>(ctx.db, 'SELECT MAX(position) AS m FROM hunt_stops WHERE trail_id = ?', trailId)?.m ?? 0) + 1;
  const answers = raw.answers ?? [];
  const challenge = raw.challenge ?? (raw.slipId ? 'slip' : answers.length ? 'riddle' : 'scan');
  return run(
    ctx.db,
    `INSERT INTO hunt_stops (trail_id, position, title, clue, clue_image, challenge, require_scan, online_fallback, slip_id, next_stop_id, is_finale,
                             answers, hints, points, glyph, color, reveal, location, token, code)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    trailId,
    pos,
    raw.title,
    raw.clue,
    challenge,
    raw.requireScan ? 1 : 0,
    raw.onlineFallback ? 1 : 0,
    raw.slipId ?? null,
    raw.nextStopId ?? null,
    raw.finale ? 1 : 0,
    JSON.stringify(answers),
    JSON.stringify(raw.hints ?? []),
    raw.points ?? 10,
    raw.glyph ?? 'star',
    raw.color ?? 'tangerine',
    raw.reveal ?? '',
    raw.location ?? '',
    newToken(),
    newCode(ctx),
  ).lastId;
}

const setNext = (ctx: FeatureContext, stopId: number, nextId: number | null) => run(ctx.db, 'UPDATE hunt_stops SET next_stop_id = ? WHERE id = ?', nextId, stopId);

interface SeedReading {
  orientation: 'bottom' | 'right' | 'top' | 'left' | 'extra';
  word?: string;
  morse?: string;
  outcome: 'next' | 'branch' | 'clue' | 'bonus' | 'decoy';
  target?: number;
  clue?: string;
  bonus?: number;
  message?: string;
}

function addSlip(ctx: FeatureContext, setId: number, slipNo: number, label: string, readings: SeedReading[]): number {
  const id = run(ctx.db, 'INSERT INTO hunt_slips (set_id, slip_no, label) VALUES (?, ?, ?)', setId, slipNo, label).lastId;
  for (const r of readings) {
    run(
      ctx.db,
      `INSERT INTO hunt_slip_readings (slip_id, orientation, word, morse, outcome, target_stop_id, clue, bonus_points, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      r.orientation,
      r.word ?? null,
      r.morse ? slipMorseKey(r.morse) : null,
      r.outcome,
      r.target ?? null,
      r.clue ?? '',
      r.bonus ?? 0,
      r.message ?? '',
    );
  }
  return id;
}

/** Trail 2: Morse messages on objects around the venue. Two need their QR scanned first, one can play online. */
function seedMorseTrail(ctx: FeatureContext): void {
  const t = addTrail(ctx, 'morse', 'the morse trail', 'shuffled', 'draft'); // needs cards on venue objects: draft unless the organisers place them
  const stops: SeedStop[] = [
    { title: 'the notice board', clue: 'Something on the club notice board is tapping out a word. Decode the card and type it.', answers: ['BYTE'], challenge: 'morse', location: 'Club notice board', glyph: 'wave', color: 'sky', reveal: 'Eight bits, one byte, one very old joke about nibbles.' },
    { title: 'the lab door', clue: 'The computer lab door has a card on it. Scan its QR to prove you found it, then decode the dots.', answers: ['CODE'], challenge: 'morse', requireScan: true, location: 'Computer lab door', glyph: 'key', color: 'lime', reveal: 'Morse is a code too. You just compiled it by hand.' },
    { title: 'the canteen', clue: 'Near the chai counter, a card loops forever. Find it, scan it, decode it.', answers: ['LOOP'], challenge: 'morse', requireScan: true, location: 'Canteen chai counter', glyph: 'bolt', color: 'tangerine', reveal: 'while (chai) { talk(); }' },
    { title: 'the big screen', clue: 'No card for this one: tap "play it" and listen (or watch the flash). What does it say?', answers: ['PIXEL'], challenge: 'morse', onlineFallback: true, location: 'Projector (online stop)', glyph: 'star', color: 'pink', reveal: 'The projector has about two million of these.' },
    { title: 'the club room', clue: 'Last one. The Recurse banner hides our favourite word in Morse. Decode it to finish.', answers: ['RECURSE'], challenge: 'morse', location: 'Recurse banner, club room', glyph: 'crown', color: 'sun', points: 15, reveal: 'Recurse: a function calling itself, and a club calling you back.' },
  ];
  stops.forEach((st) => addStop(ctx, t, { hints: ['Use the chart: dots are short, dashes are long.'], ...st }));
}

/**
 * Trail 3: a Morse slip trail (graph). Three slips come in every kit, as unique copies: each copy's
 * edges carry their own words, but every copy's edges DO the same thing. Slip 1's edges send you to
 * different stops, its top edge is a decoy and so is that strip read upside down; slip 2 has a bonus.
 */
function seedSlipTrail(ctx: FeatureContext): void {
  const t = addTrail(ctx, 'morse', 'the slip trail', 'graph', 'draft'); // kept as an example; never shown
  const set = run(ctx.db, "INSERT INTO hunt_slip_sets (trail_id, title, mode, word_pool, copies) VALUES (?, 'kit slips', 'unique', '[]', ?)", t, SEED_SLIP_COPIES).lastId;
  // stops first (slip ids patched in after the slips exist)
  const start = addStop(ctx, t, { title: 'slip 1: the start', clue: 'Take slip 1 from your kit. Scan it. Then turn it: each edge says something different.', challenge: 'slip', glyph: 'flag', color: 'lime' });
  const lab = addStop(ctx, t, { title: 'slip 2: the lab path', clue: 'You took the lab path. Grab slip 2 and find the edge that sends you on.', challenge: 'slip', glyph: 'key', color: 'sky', location: 'Computer lab' });
  const stage = addStop(ctx, t, { title: 'slip 2: the stage path', clue: 'You took the stage path. Scan slip 2. One edge is worth more than it looks.', challenge: 'slip', glyph: 'star', color: 'pink', location: 'Main stage' });
  const meet = addStop(ctx, t, { title: 'slip 3: where paths meet', clue: 'Both paths meet here. Scan slip 3 and find the edge that ends it.', challenge: 'slip', glyph: 'wave', color: 'sun' });
  const finale = addStop(ctx, t, { title: 'the last word', clue: 'Type the word that ties it all together: the name of our club.', answers: ['recurse'], finale: true, glyph: 'crown', color: 'grape', points: 20 });
  // No words: each of the 80 printed copies gets its own (unique.ts). Messages never name a word.
  const s1 = addSlip(ctx, set, 1, 'start', [
    { orientation: 'bottom', outcome: 'next', target: lab, message: 'The bottom edge sends you down the lab path. Head to the computer lab.' },
    { orientation: 'left', outcome: 'branch', target: stage, message: 'The left edge is a different path: off to the main stage.' },
    { orientation: 'right', outcome: 'clue', clue: 'Every edge of every slip says something different, and your slips are yours alone. Turn them all.' },
    { orientation: 'top', outcome: 'decoy', message: 'That edge is a decoy. Turn it again.' },
    // this copy's top strip read upside down (its sequence reversed) is a planted decoy too
    { orientation: 'extra', outcome: 'decoy', message: 'Upside down! Clever, but that is not a way forward.' },
  ]);
  const s2 = addSlip(ctx, set, 2, 'paths', [
    { orientation: 'bottom', outcome: 'next', target: meet, message: 'Go to where the paths meet.' },
    { orientation: 'right', outcome: 'bonus', bonus: 10, message: 'A hidden gift: +10 points.' },
    { orientation: 'left', outcome: 'decoy', message: 'No going back. Try another edge.' },
  ]);
  const s3 = addSlip(ctx, set, 3, 'meet', [
    { orientation: 'bottom', outcome: 'next', target: finale, message: 'The finale is open.' },
    { orientation: 'top', outcome: 'clue', clue: 'Round and round: the finale word is the name of a club that calls itself.' },
  ]);
  run(ctx.db, 'UPDATE hunt_stops SET slip_id = ? WHERE id = ?', s1, start);
  run(ctx.db, 'UPDATE hunt_stops SET slip_id = ? WHERE id IN (?, ?)', s2, lab, stage);
  run(ctx.db, 'UPDATE hunt_stops SET slip_id = ? WHERE id = ?', s3, meet);
  syncCopies(ctx, set);
}

/** Trail 4: a treasure hunt variant. Your kit slip's orientation decides which venue location you go to first (unique copies). */
function seedSlipHunt(ctx: FeatureContext): void {
  const t = addTrail(ctx, 'other', 'the slip hunt', 'graph', 'draft'); // the treasure hunt must not depend on a kit slip: unused draft
  const set = run(ctx.db, "INSERT INTO hunt_slip_sets (trail_id, title, mode, word_pool, copies) VALUES (?, 'kit slip: first location', 'unique', '[]', ?)", t, SEED_SLIP_COPIES).lastId;
  const start = addStop(ctx, t, { title: 'your kit slip', clue: 'Hold your kit slip any way up and scan it. The edge at the bottom decides where you start.', challenge: 'slip', glyph: 'map', color: 'sun' });
  const lib = addStop(ctx, t, { title: 'the library', clue: 'Find the sticker by the library entrance and scan it.', challenge: 'scan', location: 'Library entrance', glyph: 'note', color: 'sky' });
  const canteen = addStop(ctx, t, { title: 'the canteen', clue: 'Find the sticker at the chai counter and scan it.', challenge: 'scan', location: 'Canteen chai counter', glyph: 'bolt', color: 'tangerine' });
  const lab = addStop(ctx, t, { title: 'the lab', clue: 'Find the sticker on the lab door and scan it.', challenge: 'scan', location: 'Computer lab door', glyph: 'key', color: 'lime' });
  const finale = addStop(ctx, t, { title: 'hello, world', clue: 'Everyone ends here. Two words every programmer typed first.', answers: ['hello world'], finale: true, glyph: 'flag', color: 'pink', points: 15, location: 'Main stage' });
  for (const id of [lib, canteen, lab]) setNext(ctx, id, finale);
  const slip = addSlip(ctx, set, 1, 'first location', [
    { orientation: 'bottom', outcome: 'next', target: lib, message: 'Start at the library.' },
    { orientation: 'right', outcome: 'next', target: canteen, message: 'Start at the canteen.' },
    { orientation: 'left', outcome: 'next', target: lab, message: 'Start at the lab.' },
  ]);
  run(ctx.db, 'UPDATE hunt_stops SET slip_id = ? WHERE id = ?', slip, start);
  syncCopies(ctx, set);
}
