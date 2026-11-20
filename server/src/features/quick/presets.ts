// Starter presets for a tech-club afternoon. Inserted once (when there are none) at boot.
import { type Common, CommonSchema, type QuickSpecInput, QuickSpecSchema } from '@afterhours/shared/features/quick';
import { type FeatureContext, one } from '../../core';
import { addPreset } from './service';

const common = (over: Partial<Common> = {}): Common => CommonSchema.parse(over);

export const STARTERS: { name: string; spec: QuickSpecInput }[] = [
  {
    name: 'favourite language',
    spec: { template: 'poll', style: 'choice', question: 'your favourite language right now?', options: ['Python', 'JavaScript', 'TypeScript', 'Rust', 'C++', 'Java'] },
  },
  { name: 'tabs vs spaces', spec: { template: 'poll', style: 'this_or_that', question: 'tabs or spaces?', options: ['tabs', 'spaces'] } },
  { name: 'rate this talk', spec: { template: 'poll', style: 'rating', question: 'how was this talk?', options: [], ratingMax: 5 } },
  { name: 'one word for this talk', spec: { template: 'wordcloud', question: 'one word for this talk', maxWords: 1 } },
  {
    name: '3-question recap quiz',
    spec: {
      template: 'quiz',
      secondsPerQuestion: 20,
      questions: [
        { question: 'What does HTTP status 404 mean?', options: ['not found', 'forbidden', 'server on fire', 'teapot'], correct: 0 },
        { question: 'Which git command records your staged changes?', options: ['git push', 'git commit', 'git fetch', 'git stash'], correct: 1 },
        { question: 'What is 1010 in binary, in decimal?', options: ['8', '10', '12', '20'], correct: 1 },
      ],
    },
  },
  { name: 'first to type the code', spec: { template: 'code', code: '', winners: 7, windowSec: 60 } },
  { name: 'decode this word', spec: { template: 'morse', mode: 'decode', level: 1, durationSec: 180 } },
  { name: 'everyone react \u{1F525}', spec: { template: 'room', title: 'everyone react \u{1F525}', goal: 43, windowSec: 45, points: 5 } },
  { name: 'check-in for this session', spec: { template: 'checkin', activityId: null, closeAfterMin: 15 } },
];

export function seedPresets(ctx: FeatureContext): void {
  if ((one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM quick_presets')?.n ?? 0) > 0) return;
  STARTERS.forEach((p, i) => addPreset(ctx, p.name, QuickSpecSchema.parse(p.spec), common(), true, i));
}
