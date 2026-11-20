// Ready-made drops: fun tech/club content an organiser can fire in two taps.
// Numbers here are designed for a hall of 300; scaleInput() sizes first-N winners and room goals to the
// people actually signed in when the drop fires, and fills {winners} / {goal} in the blurbs.
import { type DropInput, DropInputSchema, type LibraryDrop, scaleGoal, scaleWinners } from '@afterhours/shared/features/drops';

type Raw = { id: string; tag: string; input: unknown };

const RAW: Raw[] = [
  {
    id: 'code-sudo',
    tag: 'code',
    input: { title: 'flash drop: say the magic word', blurb: 'the word is on the big screen. first {winners} type it, quick.', durationSec: 45, config: { kind: 'code', code: 'SUDO', display: 'plain', winners: 20, winPoints: 15, restPoints: 3 } },
  },
  {
    id: 'code-404',
    tag: 'code',
    input: { title: 'code drop: page not found', blurb: 'look up, type what you see. first {winners} win.', durationSec: 40, config: { kind: 'code', code: 'ERR404', display: 'plain', winners: 15, winPoints: 15, restPoints: 3 } },
  },
  {
    id: 'morse-ping',
    tag: 'morse',
    input: { title: 'morse drop: decode it', blurb: 'dots and dashes on the big screen. decode the word, type it in.', durationSec: 90, config: { kind: 'code', code: 'PING', display: 'morse', winners: 10, winPoints: 25, restPoints: 5 } },
  },
  {
    id: 'morse-byte',
    tag: 'morse',
    input: { title: 'morse drop: one byte', blurb: 'four letters of morse. the chart is in the morse tab.', durationSec: 90, config: { kind: 'code', code: 'BYTE', display: 'morse', winners: 10, winPoints: 25, restPoints: 5 } },
  },
  {
    id: 'speed-418',
    tag: 'speed',
    input: {
      title: 'speed round: http 418',
      blurb: 'first right answer takes the big points.',
      durationSec: 30,
      config: { kind: 'speed', question: 'what does http status 418 mean?', choices: ["i'm a teapot", 'not found', 'too many requests', 'gone'], correct: 0, topPoints: 30, floorPoints: 5 },
    },
  },
  {
    id: 'speed-hex',
    tag: 'speed',
    input: { title: 'speed round: hex it', blurb: 'type the number. fastest fingers win.', durationSec: 30, config: { kind: 'speed', question: 'what is 0x2A in decimal?', choices: [], answers: ['42'], topPoints: 30, floorPoints: 5 } },
  },
  {
    id: 'speed-git',
    tag: 'speed',
    input: {
      title: 'speed round: oops, committed',
      blurb: 'undo the last commit, keep your changes. which one?',
      durationSec: 30,
      config: { kind: 'speed', question: 'undo your last commit but keep the changes:', choices: ['git reset --soft HEAD~1', 'git push --force', 'git revert --hard', 'rm -rf .git'], correct: 0, topPoints: 30, floorPoints: 5 },
    },
  },
  {
    id: 'speed-oldest',
    tag: 'speed',
    input: {
      title: 'speed round: elder language',
      blurb: 'which one is the oldest?',
      durationSec: 25,
      config: { kind: 'speed', question: 'which language came first?', choices: ['python', 'java', 'c', 'javascript'], correct: 2, topPoints: 30, floorPoints: 5 },
    },
  },
  {
    id: 'speed-bits',
    tag: 'speed',
    input: { title: 'speed round: tiny one', blurb: 'type it. no googling, we can see you.', durationSec: 20, config: { kind: 'speed', question: 'how many bits in a nibble?', choices: [], answers: ['4', 'four'], topPoints: 25, floorPoints: 5 } },
  },
  {
    id: 'golden-byte',
    tag: 'golden',
    input: {
      title: 'a golden slip is loose',
      blurb: 'a golden slip is hidden somewhere in the venue. first to find it takes the bonus.',
      durationSec: 900,
      config: { kind: 'golden', token: 'GOLDENBYTE', hint: 'somewhere you would wait for chai', bonus: 50 },
    },
  },
  {
    id: 'room-200',
    tag: 'room',
    input: { title: 'the room did it', blurb: '{goal} reactions in 60 seconds and everyone gets +5. mash it.', durationSec: 60, config: { kind: 'room', goal: 200, points: 5 } },
  },
  {
    id: 'room-500',
    tag: 'room',
    input: { title: 'make it rain', blurb: '{goal} reactions in 90 seconds, everyone gets +10. all hands.', durationSec: 90, config: { kind: 'room', goal: 500, points: 10 } },
  },
];

export const LIBRARY: LibraryDrop[] = RAW.map((r) => ({ id: r.id, tag: r.tag, input: DropInputSchema.parse(r.input) }));

export function libraryDrop(id: string): DropInput | undefined {
  return LIBRARY.find((l) => l.id === id)?.input;
}

/** Size a drop designed for 300 to `present` people: code winners and room goals, and the blurb's numbers. */
export function scaleInput(input: DropInput, present: number): DropInput {
  const c = input.config;
  const config = c.kind === 'code' ? { ...c, winners: scaleWinners(c.winners, present) } : c.kind === 'room' ? { ...c, goal: scaleGoal(c.goal, present) } : c;
  const blurb = input.blurb.replace('{winners}', String(config.kind === 'code' ? config.winners : '')).replace('{goal}', String(config.kind === 'room' ? config.goal : ''));
  return { ...input, blurb, config };
}

export function scaledLibrary(present: number): LibraryDrop[] {
  return LIBRARY.map((l) => ({ ...l, input: scaleInput(l.input, present) }));
}

/** What the hype meter fires by itself when the room maxes out. */
export const AUTO_ROOM: DropInput = DropInputSchema.parse({
  title: 'the room is on fire',
  blurb: 'you lot maxed the meter. {goal} more reactions in 45 seconds and everyone gets +5.',
  durationSec: 45,
  config: { kind: 'room', goal: 150, points: 5 },
});
