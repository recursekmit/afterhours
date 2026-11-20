// THE web feature registry. One import + one array entry per feature,
// both kept alphabetical so parallel branches merge cleanly.
import type { WebFeature } from '../core/feature';
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
import { stalls } from './stalls';

export const features: WebFeature[] = [
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
  stalls,
];
