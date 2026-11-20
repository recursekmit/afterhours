// The template gallery's data and the form <-> spec conversion. A Draft is what the form edits (strings and
// numbers, with the paste boxes as text); draftToSpec turns it into the shared spec the server validates.
import {
  type Common,
  type CommonInput,
  type Overview,
  type QuickSpec,
  type QuickSpecInput,
  QuickSpecSchema,
  type TemplateId,
  formatQuizPaste,
  parseHuntPaste,
  parseOptionsPaste,
  parseQuizPaste,
} from '@afterhours/shared/features/quick';
import type { IconName, Tone } from '../../kit';

export interface TemplateInfo {
  id: TemplateId;
  title: string;
  /** One line: what the room sees. */
  sees: string;
  icon: IconName;
  tone: Tone;
}

export const TEMPLATES: TemplateInfo[] = [
  { id: 'poll', title: 'instant poll', sees: 'a question and 2-6 taps, or this-or-that, or a 1-5 rating. results fill in live.', icon: 'bars', tone: 'sky' },
  { id: 'wordcloud', title: 'word cloud', sees: 'one prompt. every answer floats into a cloud on the big screen.', icon: 'note', tone: 'pink' },
  { id: 'quiz', title: 'pop quiz', sees: 'a countdown, tap your answer fast, points for speed, a scoreboard after.', icon: 'star', tone: 'sun' },
  { id: 'code', title: 'code drop', sees: 'a code on the big screen. the first few to type it win points.', icon: 'key', tone: 'lime' },
  { id: 'speed', title: 'speed question', sees: 'one question. the first right answer wins big.', icon: 'bolt', tone: 'tangerine' },
  { id: 'room', title: 'everyone reacts', sees: 'a goal and a clock: if the room hits it, everyone gets points.', icon: 'flame', tone: 'pink' },
  { id: 'morse', title: 'morse speed round', sees: 'phones race to decode or tap morse. live podium on the projector.', icon: 'morse', tone: 'grape' },
  { id: 'checkin', title: 'check-in', sees: 'a rotating code on the projector for the speaker\'s session.', icon: 'ticket', tone: 'sky' },
  { id: 'hunt', title: 'mini hunt', sees: '2-5 stops typed now: riddles to answer or QR stickers to find.', icon: 'map', tone: 'lime' },
  { id: 'announce', title: 'announcement', sees: 'a banner on every phone and the projector, plus a push.', icon: 'megaphone', tone: 'sun' },
];

export const templateInfo = (id: TemplateId): TemplateInfo => TEMPLATES.find((t) => t.id === id) as TemplateInfo;

export interface Draft {
  template: TemplateId;
  // poll / word cloud / speed / quiz share these
  style: 'choice' | 'this_or_that' | 'rating';
  question: string;
  optionsText: string;
  ratingMax: 5 | 7 | 10;
  maxWords: number;
  quizText: string;
  secondsPerQuestion: number;
  // code drop
  code: string;
  display: 'plain' | 'morse';
  winners: number;
  windowSec: number;
  winPoints: number;
  restPoints: number;
  // speed question
  correct: number | null;
  answersText: string;
  topPoints: number;
  // room
  roomTitle: string;
  goal: number;
  points: number;
  // morse
  morseMode: 'decode' | 'encode';
  level: number;
  durationSec: number;
  // check-in
  activityId: number | null;
  closeAfterMin: number;
  // hunt
  huntTitle: string;
  huntText: string;
  pointsPerStop: number;
  // announcement
  annTitle: string;
  annBody: string;
  push: boolean;
  // common
  label: string;
  addToRunOfShow: boolean;
  durationMin: number | null;
  announce: boolean;
  announceText: string;
}

/** Smart defaults, sized to who is signed in. */
export function blankDraft(template: TemplateId, ov: Pick<Overview, 'present' | 'sizing'> | undefined): Draft {
  const winners = ov?.sizing.codeWinners ?? 7;
  const goal = ov?.sizing.roomGoal ?? 43;
  return {
    template,
    style: 'choice',
    question: '',
    optionsText: '',
    ratingMax: 5,
    maxWords: 1,
    quizText: '',
    secondsPerQuestion: 20,
    code: '',
    display: 'plain',
    winners,
    windowSec: template === 'room' ? 45 : template === 'speed' ? 45 : 60,
    winPoints: 15,
    restPoints: 3,
    correct: null,
    answersText: '',
    topPoints: 30,
    roomTitle: 'everyone react',
    goal: template === 'room' ? Math.max(10, Math.round((goal * 45) / 60)) : goal,
    points: 5,
    morseMode: 'decode',
    level: 1,
    durationSec: 180,
    activityId: null,
    closeAfterMin: 15,
    huntTitle: '',
    huntText: '',
    pointsPerStop: 10,
    annTitle: 'heads up',
    annBody: '',
    push: true,
    label: '',
    addToRunOfShow: false,
    durationMin: null,
    announce: false,
    announceText: '',
  };
}

export function draftToSpec(d: Draft): QuickSpecInput {
  switch (d.template) {
    case 'poll': {
      const options = d.style === 'rating' ? [] : parseOptionsPaste(d.optionsText);
      return { template: 'poll', style: d.style, question: d.question, options, ratingMax: d.ratingMax };
    }
    case 'wordcloud':
      return { template: 'wordcloud', question: d.question, maxWords: d.maxWords };
    case 'quiz': {
      const { questions } = parseQuizPaste(d.quizText);
      return { template: 'quiz', questions: questions.map((q) => ({ ...q, correct: Math.max(0, q.correct) })), secondsPerQuestion: d.secondsPerQuestion };
    }
    case 'code':
      return { template: 'code', code: d.code, display: d.display, winners: d.winners, windowSec: d.windowSec, winPoints: d.winPoints, restPoints: d.restPoints };
    case 'speed': {
      const choices = parseOptionsPaste(d.optionsText);
      return { template: 'speed', question: d.question, choices: choices.length ? choices : [], correct: choices.length ? d.correct : null, answers: choices.length ? [] : d.answersText.split(',').map((s) => s.trim()).filter(Boolean), windowSec: d.windowSec, topPoints: d.topPoints };
    }
    case 'room':
      return { template: 'room', title: d.roomTitle, goal: d.goal, windowSec: d.windowSec, points: d.points };
    case 'morse':
      return { template: 'morse', mode: d.morseMode, level: d.level, durationSec: d.durationSec };
    case 'checkin':
      return { template: 'checkin', activityId: d.activityId, closeAfterMin: d.closeAfterMin };
    case 'hunt':
      return { template: 'hunt', title: d.huntTitle, stops: parseHuntPaste(d.huntText), pointsPerStop: d.pointsPerStop };
    case 'announce':
      return { template: 'announce', title: d.annTitle, body: d.annBody, push: d.push };
  }
}

export function draftToCommon(d: Draft): CommonInput {
  return { label: d.label, addToRunOfShow: d.addToRunOfShow, durationMin: d.durationMin, announce: d.announce, announceText: d.announceText, push: d.push };
}

/** Everything wrong with the form, in the organiser's words (empty: ready). */
export function problemsOf(d: Draft): string[] {
  const out: string[] = [];
  if (d.template === 'quiz') {
    const { problems } = parseQuizPaste(d.quizText);
    out.push(...problems);
    if (problems.length === 0) {
      const r = QuickSpecSchema.safeParse(draftToSpec(d));
      if (!r.success) out.push(...r.error.issues.map((i) => i.message));
    }
    return [...new Set(out)];
  }
  const r = QuickSpecSchema.safeParse(draftToSpec(d));
  if (!r.success) out.push(...r.error.issues.map((i) => i.message));
  if (d.template === 'poll' && d.style === 'choice' && d.optionsText.split(/\r?\n/).filter((l) => l.trim()).length > parseOptionsPaste(d.optionsText).length) out.push('Two options are the same. Change or remove one.');
  return [...new Set(out)];
}

/** Fill a form from a saved spec (re-run, duplicate, edit a preset). */
export function specToDraft(spec: QuickSpec, common: Common, ov: Pick<Overview, 'present' | 'sizing'> | undefined): Draft {
  const d: Draft = { ...blankDraft(spec.template, ov), label: common.label, addToRunOfShow: common.addToRunOfShow, durationMin: common.durationMin, announce: common.announce, announceText: common.announceText, push: common.push };
  switch (spec.template) {
    case 'poll':
      return { ...d, style: spec.style, question: spec.question, optionsText: spec.options.join('\n'), ratingMax: spec.ratingMax };
    case 'wordcloud':
      return { ...d, question: spec.question, maxWords: spec.maxWords };
    case 'quiz':
      return { ...d, quizText: formatQuizPaste(spec.questions), secondsPerQuestion: spec.secondsPerQuestion };
    case 'code':
      return { ...d, code: spec.code, display: spec.display, winners: spec.winners, windowSec: spec.windowSec, winPoints: spec.winPoints, restPoints: spec.restPoints };
    case 'speed':
      return { ...d, question: spec.question, optionsText: spec.choices.join('\n'), correct: spec.correct, answersText: spec.answers.join(', '), windowSec: spec.windowSec, topPoints: spec.topPoints };
    case 'room':
      return { ...d, roomTitle: spec.title, goal: spec.goal, windowSec: spec.windowSec, points: spec.points };
    case 'morse':
      return { ...d, morseMode: spec.mode, level: spec.level, durationSec: spec.durationSec };
    case 'checkin':
      return { ...d, activityId: spec.activityId, closeAfterMin: spec.closeAfterMin };
    case 'hunt':
      return { ...d, huntTitle: spec.title, huntText: spec.stops.map((s) => (s.answer ? `${s.clue} => ${s.answer}` : s.clue)).join('\n'), pointsPerStop: spec.pointsPerStop };
    case 'announce':
      return { ...d, annTitle: spec.title, annBody: spec.body, push: spec.push };
  }
}
