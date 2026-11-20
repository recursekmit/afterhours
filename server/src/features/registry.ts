// THE server feature registry. One import + one array entry per feature,
// both kept alphabetical so parallel branches merge cleanly.
import type { ServerFeature } from '../core';
import { alerts } from './alerts';
import { arcade } from './arcade';
import { attendance } from './attendance';
import { drops } from './drops';
import { hunt } from './hunt';
import { leaderboard } from './leaderboard';
import { morse } from './morse';
import { polls } from './polls';
import { reactions } from './reactions';
import { schedule } from './schedule';

export const features: ServerFeature[] = [
  alerts,
  arcade,
  attendance,
  drops,
  hunt,
  leaderboard,
  morse,
  polls,
  reactions,
  schedule,
];
