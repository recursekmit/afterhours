// Trial 6, the last signal. (M1: not fired yet.)
import type { CipherScreen, SignalFire, SignalView } from '@afterhours/shared/features/cipher';
import { type FeatureContext, conflict } from '../../core';
import { settings } from './service';

const IDLE = (firstN: number): SignalView => ({ id: null, status: 'idle', warnAt: null, fireAt: null, closesAt: null, letters: null, eligible: false, answered: null, firstN, correct: 0, word: null, winner: null });

export function signalView(ctx: FeatureContext, _attendeeId: number | null, _trial: number): SignalView {
  return IDLE(settings(ctx).signalFirstN);
}

export function screenSignal(ctx: FeatureContext): { view: SignalView; play: CipherScreen['signalPlay']; first: CipherScreen['firstAnswers'] } {
  return { view: IDLE(settings(ctx).signalFirstN), play: null, first: [] };
}

export function adminSignal(ctx: FeatureContext): { view: SignalView; word: string | null } {
  return { view: IDLE(settings(ctx).signalFirstN), word: null };
}

export function signalTick(_ctx: FeatureContext): void {}
export function signalAction(_ctx: FeatureContext, _a: SignalFire): never {
  throw conflict('The last signal is not built into this version yet.');
}
export function answerSignal(_ctx: FeatureContext, _attendeeId: number, _guess: string): never {
  throw conflict('The last signal has not been sent yet.');
}
