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
import { quick } from './quick';
import { reactions } from './reactions';
import { recap } from './recap';
import { schedule } from './schedule';
import { stalls } from './stalls';

export const features: ServerFeature[] = [
  alerts,
  arcade,
  attendance,
  drops,
  hunt,
  leaderboard,
  morse,
  polls,
  quick,
  reactions,
  recap,
  schedule,
  stalls,
];
