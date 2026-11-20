/*
  Quick session (console): the first panel in the console. Pick a template, fill a minimal form, go live now;
  phones and the projector take over by themselves. `/admin/quick/speaker` is the phone view for a volunteer
  standing next to the speaker. Server side: server/src/features/quick.
*/
import { lazy } from 'react';
import { defineFeature } from '../../core/feature';

export const quick = defineFeature({
  name: 'quick',
  // order -10: ahead of every other feature panel (the shell lists a negative order before its core panels)
  console: { order: -10, label: 'quick session', path: 'quick', icon: 'bolt', Panel: lazy(() => import('./Console')) },
});
