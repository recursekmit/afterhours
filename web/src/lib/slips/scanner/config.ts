/*
  Configures the pipeline in this thread with the shared slip proportions and the
  shared Morse table (shared/src). The worker gets the same values in its init
  message, so the worker bundle stays free of the shared package and zod.
*/
import { MORSE_TABLE } from '@afterhours/shared/features/morse';
import { SLIP_SPEC } from '@afterhours/shared/morse-slip';
import { configurePipeline } from './pipeline';

export const PIPELINE_CONFIG = { spec: SLIP_SPEC, table: MORSE_TABLE } as const;
configurePipeline(PIPELINE_CONFIG.spec, PIPELINE_CONFIG.table);
