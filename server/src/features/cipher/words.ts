// Word pools for the whisper (3-4 letters, one per printed copy) and the last signal (4-5 letters).
// Plain, friendly words a student can recognise once decoded. Codes take over if a pool runs dry.
import { randomInt } from 'node:crypto';

export const WHISPER_WORDS: readonly string[] = [
  // three letters
  'ACE', 'ARC', 'ASH', 'AXE', 'BAY', 'BEE', 'BOW', 'BOX', 'CAP', 'COG', 'COW', 'CUB', 'DEW', 'DOT', 'EAR', 'ELK',
  'ELM', 'EMU', 'FAN', 'FIG', 'FIN', 'FOG', 'FOX', 'GEM', 'GUM', 'HAT', 'HAY', 'HEN', 'HUB', 'ICE', 'INK', 'IVY',
  'JAM', 'JET', 'JOY', 'KEG', 'KIT', 'LID', 'MAP', 'MUD', 'NAP', 'NUT', 'OAK', 'OAR', 'ORE', 'OWL', 'PAN', 'PEA',
  'PEN', 'PIE', 'POD', 'RAY', 'RIM', 'RYE', 'SAP', 'SKY', 'SUN', 'TEA', 'TOY', 'URN', 'VAN', 'WAX', 'WEB', 'YAK',
  'YAM', 'ZAP', 'ZEN', 'ZIP',
  // four letters
  'BARN', 'BEAM', 'BELL', 'BIRD', 'BOAT', 'BOLT', 'BOOK', 'CAKE', 'CAVE', 'CLAY', 'COIN', 'CORN', 'CROW',
  'DART', 'DAWN', 'DECK', 'DESK', 'DOME', 'DOVE', 'DRUM', 'DUNE', 'DUSK', 'FERN', 'FIRE', 'FISH', 'FLAG', 'FOAM',
  'FORK', 'GATE', 'GLOW', 'GOLD', 'HARP', 'HAWK', 'HILL', 'HIVE', 'HORN', 'IRIS', 'JADE', 'KITE', 'KNOT', 'LAMP',
  'LARK', 'LEAF', 'LIME', 'LION', 'LOOM', 'LUTE', 'MAST', 'MILK', 'MINT', 'MIST', 'MOON', 'MOSS', 'MOTH', 'NEST',
  'OPAL', 'OVEN', 'PALM', 'PEAR', 'PINE', 'PLUM', 'POND', 'RAFT', 'RAIN', 'REED', 'RING', 'ROBE', 'ROOF', 'ROPE',
  'ROSE', 'RUBY', 'SAGE', 'SAIL', 'SALT', 'SAND', 'SEAL', 'SEED', 'SHIP', 'SILK', 'SNOW', 'SOAP', 'SOUP', 'STAR',
  'SWAN', 'TIDE', 'TOWN', 'TREE', 'TUBA', 'TUNE', 'VASE', 'VINE', 'WAND', 'WELL', 'WING', 'WOLF',
  'WOOL', 'YARN', 'YETI', 'ZINC',
];

export const SIGNAL_WORDS: readonly string[] = [
  'ARISE', 'BLAZE', 'BRAVE', 'CLOCK', 'COMET', 'CROWN', 'DREAM', 'EMBER', 'FLAME', 'FROST', 'GLORY', 'GUILD', 'HEART',
  'LIGHT', 'LUNAR', 'MAGIC', 'NIGHT', 'NOVA', 'ORBIT', 'QUEST', 'RAVEN', 'SPARK', 'STORM', 'TORCH', 'UNITY', 'VALOR', 'WAKE',
  // more, so that with one word per phone two neighbours rarely share one
  'AMBER', 'ANGEL', 'BEACH', 'BLOOM', 'CANDY', 'CEDAR', 'CHARM', 'CLOUD', 'CORAL', 'DAISY', 'EAGLE', 'FAIRY', 'FEAST',
  'GHOST', 'GIANT', 'GRAPE', 'HONEY', 'IVORY', 'JEWEL', 'KOALA', 'LEMON', 'LOTUS', 'MANGO', 'MAPLE', 'MELON', 'OASIS',
  'OCEAN', 'OLIVE', 'PANDA', 'PEARL', 'PIANO', 'PIXEL', 'PLANT', 'QUILT', 'RADIO', 'RIVER', 'ROBOT', 'SHELL', 'SMILE',
  'SOLAR', 'SPICE', 'STONE', 'SUGAR', 'TIGER', 'TOAST', 'TULIP', 'VIOLA', 'WHALE', 'ZEBRA', 'BISON', 'CABIN', 'DELTA',
].filter((w) => w.length >= 4 && w.length <= 5);

const CONS = 'BCDFGHJKLMNPRSTVWZ';
const VOW = 'AEIOU';
const pick = (s: string) => s[randomInt(s.length)] as string;

/** A pronounceable code of n letters (CVC, CVCV...), when the word pool is used up. */
export function codeWord(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += i % 2 === 0 ? pick(CONS) : pick(VOW);
  return out;
}

/** Shuffled candidates within a length range (fresh order every call). */
export function candidates(pool: readonly string[], min: number, max: number): string[] {
  const xs = pool.filter((w) => w.length >= min && w.length <= max);
  for (let i = xs.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [xs[i], xs[j]] = [xs[j] as string, xs[i] as string];
  }
  return xs;
}
