// Words for unique slips (docs/SLIPS.md, "unique slips"): every printed copy of every slip carries its
// own word on every edge. Pure: no database, no clock. The caller passes the edges it needs words for
// and every Morse key already in use; it gets back one word per edge, in the same order.
//
// Rules, for every word the generator hands out:
//   1. unique: its Morse key is not in use anywhere (this set, or any other unique set);
//   2. far apart: its key differs by at least 2 edits from every other word on copies of the SAME slip
//      (readings are looked up per slip, so a scanner that drops or flips one symbol never lands on
//      someone else's copy: it lands on "nothing there");
//   3. no upside-down twins: its key is not the reversal of a key in use, its reversal is not in use,
//      and it is not its own reversal, so the top strip read upside down is never a real word;
//   4. it fits its edge on the after hours ticket (dots at least 1.6 mm) and on the plain 85 x 55 card
//      (edgeCapacity, the renderer's own limit), so a set can print either way;
//   5. clean: not on the polls profanity list (read only, with leetspeak folding), not on the short
//      blocklist below, and the same for the text its upside-down strip spells.
// Preference: real short tech words, then pronounceable codes (CVC on short edges, CVCV on long
// ones), then letter+digit codes.
import { createHash } from 'node:crypto';
import { slipWordKey } from '@afterhours/shared/features/hunt';
import { type SlipEdge, SLIP_SIZES, decodeMorse, edgeCapacity, encodeWord, reverseReading } from '@afterhours/shared/morse-slip';
import { isProfane } from '../polls/words';

/** Real short tech words. The generator filters them per edge by printed length. */
export const TECH_WORDS: readonly string[] = [
  // two and three letters
  'AI', 'IO', 'OS', 'UI', 'UX', 'VM', 'IP', 'PC', 'GO', 'JS', 'TS', 'PY', 'DB', 'IDE', 'API', 'APP', 'BIT', 'BUG', 'BOT', 'CPU', 'GPU', 'RAM', 'ROM', 'GIT',
  'SQL', 'CSS', 'DNS', 'TCP', 'UDP', 'SSH', 'VIM', 'NPM', 'LAN', 'WAN', 'IOT', 'LED', 'USB', 'HEX', 'BIN', 'OCT', 'XOR', 'NOR', 'AND', 'NOT', 'SYN', 'ACK',
  'LOG', 'MAP', 'ZIP', 'TAR', 'JAR', 'DEV', 'OPS', 'WEB', 'NET', 'KEY', 'TAB', 'RUN', 'FIX', 'PNG', 'GIF', 'SVG', 'URL', 'CLI', 'GUI', 'SDK', 'JVM', 'GCC',
  'CMD', 'EXE', 'DLL', 'ISO', 'MAC', 'PIN', 'RGB', 'FPS', 'BUS', 'NIC', 'SSD', 'HDD', 'VPN', 'WIFI', 'MIT', 'ALU', 'FPU', 'PID', 'TTY', 'ENV', 'ARG', 'VAR',
  'INT', 'NIL', 'NAN', 'REF', 'PTR', 'MUX', 'FET', 'AMP', 'OHM', 'VCC', 'GND', 'PWM', 'ADC', 'DAC', 'SPI', 'CAN', 'RTC', 'EOF', 'LUA', 'ZSH', 'AWK', 'SED',
  'CAT', 'TOP', 'PS', 'LS', 'CD', 'MV', 'CP', 'RM', 'DD', 'DIG', 'NIX', 'RPC', 'JIT', 'TLS', 'SSL', 'MFA', 'OTP', 'DOS', 'ASM', 'COB', 'ADA', 'ELM', 'PHP',
  // four and five letters
  'BYTE', 'CODE', 'LOOP', 'NODE', 'JAVA', 'RUST', 'BASH', 'GREP', 'PING', 'HACK', 'TMUX', 'SUDO', 'NULL', 'VOID', 'REPO', 'FORK', 'PUSH', 'PULL', 'PORT',
  'HASH', 'HEAP', 'TREE', 'ENUM', 'CHAR', 'BOOL', 'HOST', 'ROOT', 'JSON', 'YAML', 'TOML', 'HTML', 'HTTP', 'DIFF', 'LINT', 'TEST', 'MOCK', 'STUB', 'DEMO',
  'DATA', 'DISK', 'CHIP', 'CORE', 'BOOT', 'KERN', 'LINK', 'PIPE', 'FILE', 'PATH', 'MAKE', 'WASM', 'JPEG', 'UNIX', 'RISC', 'CISC', 'BAUD', 'BLOB', 'CRON',
  'DUMP', 'EDGE', 'FLAG', 'GRID', 'ICON', 'JOIN', 'LEAF', 'MAIN', 'MESH', 'OPEN', 'PAGE', 'PROC', 'QUAD', 'READ', 'SEED', 'SPEC', 'SYNC', 'TASK', 'UUID',
  'VIEW', 'WORD', 'ZERO', 'NANO', 'GOLF', 'KMIT', 'CHAI', 'BETA', 'CLOUD', 'STACK', 'QUEUE', 'ARRAY', 'LINUX', 'TOKEN', 'REGEX', 'SHELL', 'PATCH', 'MERGE',
  'PIXEL', 'CACHE', 'ASYNC', 'MACRO', 'PROXY', 'QUERY', 'CLASS', 'DEBUG', 'BUILD', 'LOGIC', 'LAYER', 'MODEM', 'RADIX', 'SHARD', 'TUPLE', 'VIRUS', 'BINARY',
];

/**
 * Short words we never print, checked as substrings of the word and of what its upside-down strip
 * spells (the polls list is checked too, with its own leetspeak folding). Kept short on purpose:
 * generated codes are 2-4 letters, so these are the combinations that can actually come out.
 */
export const SLIP_BLOCKLIST: readonly string[] = [
  'ASS', 'ARSE', 'FUK', 'FUC', 'FCK', 'FUQ', 'SEX', 'XXX', 'KKK', 'CUM', 'TIT', 'DIK', 'DIC', 'COK', 'COC', 'FAG', 'GAY', 'NIG', 'NGR', 'POO', 'PEE',
  'PIS', 'WTF', 'FML', 'STFU', 'KIL', 'DIE', 'DED', 'RAPE', 'RAP', 'HOE', 'HOR', 'SUK', 'SUC', 'JEW', 'NAZ', 'VAG', 'BUM', 'TWAT', 'SLUT',
  'PORN', 'NUDE', 'BOOB', 'BOOBS', 'HELL', 'DAMN', 'GOD', 'ISIS', 'KUNT', 'CUNT', 'PUSY', 'SHIT', 'SHT', 'BICH', 'BTCH', 'WANK', 'JIZ', 'GAND', 'GANDU',
  'LUN', 'LND', 'LOD', 'CHUT', 'CHU', 'RND', 'RANDI', 'BSD', 'MC', 'BC', 'MKC', 'BKL', 'PUK', 'PUKU', 'POOK', 'GUDA', 'MODA', 'LANJ', 'SULI', 'KUTA',
  'KUTI', 'HIJR', 'TATI', 'TATTI', 'MUT', 'SUAR', 'ULLU', 'BHAD', 'DENG', 'DENGA', 'GUD', 'LODA', 'LAVD', 'LAUD', 'JHAT', 'HAG', 'FAT', 'UGLY', 'DUMB',
  'IDIOT', 'LOSER', 'NOOB', 'PIG', 'COW', 'APE', 'DOG', 'FAP', 'JAP', 'WOP', 'SPIC', 'KIKE', 'GOOK', 'COON', 'DYKE', 'HOMO', 'ANAL', 'ANUS', 'PENI',
  'SEMEN', 'PAKI', 'JIHAD', 'BOMB', 'GUN', 'MUTH', 'BUND', 'CHOD', 'BHOS', 'RAND', 'SALA', 'SALI', 'KUTTA', 'TARD', 'NUT', 'BRA', 'POOP', 'TURD',
];

/** Dots on a ticket edge must be at least this big (mm); the renderer's floor is 0.9 mm. */
export const COMFORT_UNIT_MM = 1.6;
/** Pronounceable long-edge codes use 4 letters; short edges 3 (2 for tech words). */
const CONSONANTS = 'BCDFGHJKLMNPRSTVWZ';
const VOWELS = 'AEIOU';
const DIGITS = '23456789';

export type EdgeClass = 'short' | 'long';

/** The printed band of an edge, in Morse units at the comfort size, bounded by the renderer's own capacity. */
function bandUnits(edge: SlipEdge, widthMm: number, heightMm: number): number {
  // edgeCapacity is floor(bandMm / 0.9): back out the band and size it at the comfort dot instead.
  const capacity = edgeCapacity(edge, widthMm, heightMm);
  const bandMm = capacity * 0.9;
  return Math.min(capacity, Math.floor(bandMm / COMFORT_UNIT_MM));
}

/**
 * The most Morse units a generated word may take on this edge: it must fit the ticket at the comfort
 * dot size AND the plain card at the renderer's minimum, so a unique set prints as either.
 */
export function edgeUnitLimit(edge: SlipEdge): number {
  const t = SLIP_SIZES.ticket;
  const c = SLIP_SIZES.card;
  return Math.min(bandUnits(edge, t.widthMm, t.heightMm), edgeCapacity(edge, c.widthMm, c.heightMm), edge === 'bottom' || edge === 'top' ? 45 : 34);
}

export function edgeClass(edge: SlipEdge): EdgeClass {
  return edge === 'bottom' || edge === 'top' ? 'long' : 'short';
}

/** Morse units a word prints as (dot 1, dash 3, gaps 1/3/7). */
export function wordUnits(word: string): number {
  return encodeWord(word).units;
}

/** True when a and b are the same or one insert/delete/substitute apart. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) return a.slice(i + 1) === b.slice(i + 1);
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** Never printed: the polls list (exact/contains, leetspeak) or the short blocklist, on the word or its upside-down reading. */
const blockedMemo = new Map<string, boolean>();
export function isBlockedWord(word: string): boolean {
  const w = word.toUpperCase();
  const hit = blockedMemo.get(w);
  if (hit !== undefined) return hit;
  const upside = decodeMorse(reverseReading(slipWordKey(w)))?.replace(/\s+/g, '') ?? '';
  let blocked = false;
  for (const text of [w, upside]) {
    if (!text) continue;
    if (isProfane(text.toLowerCase()) || SLIP_BLOCKLIST.some((b) => text.includes(b))) blocked = true;
  }
  blockedMemo.set(w, blocked);
  return blocked;
}

/** A small deterministic PRNG (mulberry32) from a string seed, so a set regenerates the same way. */
export function prng(seed: string): () => number {
  let a = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(list: T[], rnd: () => number): T[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [list[i], list[j]] = [list[j] as T, list[i] as T];
  }
  return list;
}

/** Candidate words for an edge class, best first: tech words, pronounceable codes, letter+digit codes (each tier shuffled). */
function candidates(cls: EdgeClass, rnd: () => number): string[] {
  const tech = TECH_WORDS.filter((w) => (cls === 'short' ? w.length <= 3 : w.length >= 4));
  const cvc: string[] = [];
  const cvcv: string[] = [];
  for (const a of CONSONANTS)
    for (const v of VOWELS)
      for (const b of CONSONANTS) {
        cvc.push(a + v + b);
        for (const v2 of VOWELS) cvcv.push(a + v + b + v2);
      }
  const codes: string[] = [];
  for (const a of CONSONANTS + VOWELS)
    for (const d of DIGITS) {
      codes.push(a + d);
      for (const b of CONSONANTS) codes.push(a + d + b);
    }
  // Short edges: CVC first, then the light CVCV words that still fit (TINE, SEMI...). Long edges: CVCV,
  // then CVC. Codes last on both.
  const pron = cls === 'short' ? [...shuffle(cvc, rnd), ...shuffle(cvcv, rnd)] : [...shuffle(cvcv, rnd), ...shuffle(cvc, rnd)];
  return [...shuffle([...tech], rnd), ...pron, ...shuffle(codes, rnd)];
}

/** Every key in use anywhere: rules 1 and 3. */
class GlobalIndex {
  private keys = new Set<string>();
  private reversed = new Set<string>();
  add(key: string): void {
    this.keys.add(key);
    this.reversed.add(reverseReading(key));
  }
  accepts(key: string): boolean {
    const rev = reverseReading(key);
    return rev !== key && !this.keys.has(key) && !this.keys.has(rev) && !this.reversed.has(key);
  }
}

/** Keys on copies of one slip, by length, for the one-edit check (rule 2). */
class NearIndex {
  private byLen = new Map<number, string[]>();
  add(key: string): void {
    const l = this.byLen.get(key.length) ?? [];
    l.push(key);
    this.byLen.set(key.length, l);
  }
  accepts(key: string): boolean {
    for (const len of [key.length - 1, key.length, key.length + 1]) for (const k of this.byLen.get(len) ?? []) if (withinOneEdit(k, key)) return false;
    return true;
  }
}

/** One word to generate: the edge it prints on, and the slip it belongs to (rule 2 is per slip). */
export interface WordSlot {
  edge: SlipEdge;
  group: string | number;
}

export interface GenerateOptions {
  /** Same seed + same input = same words. */
  seed: string;
  /** Morse keys already printed anywhere (other copies, other unique sets, derived upside-down extras). */
  taken?: Iterable<string>;
  /** Keys already on copies of each slip (group), for the one-edit rule. */
  near?: Iterable<readonly [string | number, string]>;
}

/**
 * One word per requested slot, honouring every rule above. Slots are filled in a shuffled order so the
 * tech words spread over all copies instead of all landing on copy 1. Throws if the supply runs dry
 * (it does not for the sizes the console allows: see slipwords.test.ts).
 */
export function generateWords(slots: readonly WordSlot[], opts: GenerateOptions): string[] {
  const rnd = prng(opts.seed);
  const global = new GlobalIndex();
  for (const k of opts.taken ?? []) global.add(k);
  const near = new Map<string, NearIndex>();
  const nearOf = (g: string | number): NearIndex => {
    let n = near.get(String(g));
    if (!n) near.set(String(g), (n = new NearIndex()));
    return n;
  };
  for (const [g, k] of opts.near ?? []) nearOf(g).add(k);
  // Each slip walks its own shuffled stream per edge class: a word one slip had to skip (too close to
  // one of its own) is still fair game for another slip.
  const base: Record<EdgeClass, string[]> = { short: candidates('short', rnd), long: candidates('long', rnd) };
  const streams = new Map<string, { list: string[]; at: number }>();
  const streamOf = (g: string | number, cls: EdgeClass) => {
    const id = `${cls}:${g}`;
    let s = streams.get(id);
    if (!s) {
      // keep the tier order (tech, pronounceable, codes), shuffle within the first tier only
      const list = [...base[cls]];
      const tech = list.findIndex((w) => !TECH_WORDS.includes(w));
      const head = shuffle(list.slice(0, Math.max(0, tech)), rnd);
      streams.set(id, (s = { list: [...head, ...list.slice(Math.max(0, tech))], at: 0 }));
    }
    return s;
  };
  const out: string[] = new Array<string>(slots.length);
  const order = shuffle(
    slots.map((_, i) => i),
    rnd,
  );
  for (const i of order) {
    const slot = slots[i] as WordSlot;
    const limit = edgeUnitLimit(slot.edge);
    const stream = streamOf(slot.group, edgeClass(slot.edge));
    const mine = nearOf(slot.group);
    let word: string | null = null;
    while (stream.at < stream.list.length) {
      const w = stream.list[stream.at++] as string;
      if (wordUnits(w) > limit) continue;
      const key = slipWordKey(w);
      if (!global.accepts(key) || !mine.accepts(key) || isBlockedWord(w)) continue;
      word = w;
      global.add(key);
      mine.add(key);
      break;
    }
    if (word === null) throw new Error(`Ran out of ${edgeClass(slot.edge)}-edge words for slip ${slot.group}. Lower the number of copies.`);
    out[i] = word;
  }
  return out;
}

/**
 * Ticket designs for the copies of one slip: all four, balanced (20 each for 80, never more than one
 * apart for any N), shuffled deterministically from `seed`. Copies that already have a design keep it
 * (a reprint of serial 37 is the same ticket); only the missing ones are filled, least-used designs first.
 */
export function assignDesigns<D extends string>(designs: readonly D[], current: ReadonlyMap<number, D | null>, seed: string): Map<number, D> {
  const out = new Map<number, D>();
  const counts = new Map<D, number>(designs.map((d) => [d, 0]));
  const missing: number[] = [];
  for (const [serial, d] of [...current.entries()].sort((a, b) => a[0] - b[0])) {
    if (d !== null && counts.has(d)) {
      out.set(serial, d);
      counts.set(d, (counts.get(d) ?? 0) + 1);
    } else missing.push(serial);
  }
  if (missing.length === 0) return out;
  const pool: D[] = [];
  for (let i = 0; i < missing.length; i++) {
    const least = designs.reduce((best, d) => ((counts.get(d) ?? 0) < (counts.get(best) ?? 0) ? d : best), designs[0] as D);
    pool.push(least);
    counts.set(least, (counts.get(least) ?? 0) + 1);
  }
  shuffle(pool, prng(`${seed}:${missing[0]}:${missing.length}`));
  missing.forEach((serial, i) => out.set(serial, pool[i] as D));
  return out;
}
