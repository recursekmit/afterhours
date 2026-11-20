import { describe, expect, it } from 'vitest';
import {
  QuickSpecSchema,
  formatQuizPaste,
  defaultDurationMin,
  parseHuntPaste,
  parseOptionsPaste,
  parseQuizPaste,
  randomCode,
  sessionTitle,
} from './quick';

describe('parseOptionsPaste', () => {
  it('takes one option per line, drops bullets, numbering, blanks and duplicates', () => {
    expect(parseOptionsPaste('- python\n* Rust\n\n3) go\n  4. Python \nzig')).toEqual(['python', 'Rust', 'go', 'zig']);
  });
  it('plain lines pass through', () => {
    expect(parseOptionsPaste('tabs\nspaces')).toEqual(['tabs', 'spaces']);
    expect(parseOptionsPaste('')).toEqual([]);
  });
});

describe('parseQuizPaste', () => {
  it('reads Q?, *right, wrong, wrong', () => {
    const { questions, problems } = parseQuizPaste('What is 2+2?\n*4\n3\n5\n\nCapital of France?\nLondon\n*Paris');
    expect(problems).toEqual([]);
    expect(questions).toEqual([
      { question: 'What is 2+2?', options: ['4', '3', '5'], correct: 0 },
      { question: 'Capital of France?', options: ['London', 'Paris'], correct: 1 },
    ]);
  });
  it('strips question numbers and windows line endings', () => {
    const { questions } = parseQuizPaste('1. first one?\r\n*yes\r\nno\r\n\r\nQ2: second one?\r\nmaybe\r\n*sure');
    expect(questions.map((q) => q.question)).toEqual(['first one?', 'second one?']);
    expect(questions[1]?.correct).toBe(1);
  });
  it('says what is wrong, per question', () => {
    const { problems } = parseQuizPaste('no marker?\na\nb\n\nlonely?\n*only\n\ntwo stars?\n*a\n*b');
    expect(problems).toEqual(['question 1: mark the right answer with a * in front', 'question 2: needs at least 2 options under it', 'question 3: only one answer can be right']);
  });
  it('empty input is a problem', () => {
    expect(parseQuizPaste('  \n ').problems).toEqual(['paste at least one question']);
  });
  it('what it reads passes the quiz schema', () => {
    const { questions } = parseQuizPaste('Which one?\n*right\nwrong\nwrong');
    const r = QuickSpecSchema.safeParse({ template: 'quiz', questions });
    expect(r.success).toBe(true);
  });
});

describe('formatQuizPaste', () => {
  it('round-trips with the parser and can move the star', () => {
    const text = 'one?\na\n*b\n\ntwo?\n*x\ny';
    const { questions } = parseQuizPaste(text);
    expect(formatQuizPaste(questions)).toBe(text);
    questions[0]!.correct = 0;
    expect(formatQuizPaste(questions)).toBe('one?\n*a\nb\n\ntwo?\n*x\ny');
  });
});

describe('parseHuntPaste', () => {
  it('clue => answer is a riddle, a bare clue is a sticker', () => {
    expect(parseHuntPaste('what runs npm start? => node\n- find the lab door sticker\nthird :: three')).toEqual([
      { clue: 'what runs npm start?', answer: 'node' },
      { clue: 'find the lab door sticker', answer: '' },
      { clue: 'third', answer: 'three' },
    ]);
  });
});

describe('spec validation', () => {
  it('a choice poll needs 2 to 6 non-empty options', () => {
    const base = { template: 'poll', style: 'choice', question: 'pick one' } as const;
    expect(QuickSpecSchema.safeParse({ ...base, options: ['a', 'b'] }).success).toBe(true);
    expect(QuickSpecSchema.safeParse({ ...base, options: ['a'] }).success).toBe(false);
    expect(QuickSpecSchema.safeParse({ ...base, options: ['a', ''] }).success).toBe(false);
    expect(QuickSpecSchema.safeParse({ ...base, options: ['1', '2', '3', '4', '5', '6', '7'] }).success).toBe(false);
  });
  it('this or that is exactly two; rating needs no options', () => {
    expect(QuickSpecSchema.safeParse({ template: 'poll', style: 'this_or_that', question: 'tabs?', options: ['a', 'b', 'c'] }).success).toBe(false);
    expect(QuickSpecSchema.safeParse({ template: 'poll', style: 'rating', question: 'rate it' }).success).toBe(true);
  });
  it('a speed question needs a right choice or a typed answer', () => {
    expect(QuickSpecSchema.safeParse({ template: 'speed', question: 'q?? ok', choices: ['a', 'b'], correct: null }).success).toBe(false);
    expect(QuickSpecSchema.safeParse({ template: 'speed', question: 'q?? ok', choices: ['a', 'b'], correct: 1 }).success).toBe(true);
    expect(QuickSpecSchema.safeParse({ template: 'speed', question: 'q?? ok', answers: ['yes'] }).success).toBe(true);
    expect(QuickSpecSchema.safeParse({ template: 'speed', question: 'q?? ok' }).success).toBe(false);
  });
  it('codes are normalised', () => {
    const r = QuickSpecSchema.parse({ template: 'code', code: 'ship-it!' });
    expect(r.template === 'code' && r.code).toBe('SHIPIT');
  });
  it('a hunt needs 2 to 5 stops', () => {
    const stop = { clue: 'find the door' };
    expect(QuickSpecSchema.safeParse({ template: 'hunt', title: 'h', stops: [stop] }).success).toBe(false);
    expect(QuickSpecSchema.safeParse({ template: 'hunt', title: 'h', stops: [stop, stop] }).success).toBe(true);
    expect(QuickSpecSchema.safeParse({ template: 'hunt', title: 'h', stops: Array(6).fill(stop) }).success).toBe(false);
  });
});

describe('helpers', () => {
  it('titles and durations', () => {
    expect(sessionTitle(QuickSpecSchema.parse({ template: 'quiz', questions: [{ question: 'q?? ok', options: ['a', 'b'], correct: 0 }] }), 'Dr Rao')).toBe('Dr Rao: pop quiz');
    expect(sessionTitle(QuickSpecSchema.parse({ template: 'wordcloud', question: 'one word' }), '')).toBe('word cloud');
    expect(defaultDurationMin(QuickSpecSchema.parse({ template: 'morse', durationSec: 300 }))).toBe(5);
  });
  it('random codes use the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) expect(randomCode()).toMatch(/^[ACDEFGHJKMNPQRTUVWXY2346789]{5}$/);
  });
});
