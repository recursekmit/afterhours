// Trial 5, the pact. (M1: not open yet; players who reach it see "next trials open soon".)
import type { CipherSettings, Guild, PactView } from '@afterhours/shared/features/cipher';
import type { SlipEdge } from '@afterhours/shared/morse-slip';
import { type FeatureContext, conflict } from '../../core';
import type { PlayerRow } from './service';

export function pactView(_ctx: FeatureContext, _p: PlayerRow | null | undefined, _s: CipherSettings): PactView {
  return { status: 'locked', partner: null, scanEdge: null, showEdge: null, iScanned: false, theyScanned: false, since: null, canRepair: false, waiting: 0 };
}

export function enterPool(_ctx: FeatureContext, _attendeeId: number): void {}

export function pactScan(_ctx: FeatureContext, _p: PlayerRow, _keys: Set<string>, _mySlip: number | null): { outcome: 'pact_half' | 'pact_sealed' | 'again' | 'not_yours'; message: string; edge: SlipEdge | null; points: number } | null {
  return null;
}

export function adminPacts(_ctx: FeatureContext) {
  return { list: [] as { id: number; a: string; b: string | null; oracle: boolean; status: 'open' | 'sealed' | 'broken'; aScanned: boolean; bScanned: boolean; createdAt: number }[], partnerOf: new Map<number, string>() };
}

export function waitingList(_ctx: FeatureContext): { attendeeId: number; nickname: string; guild: Guild; since: number }[] {
  return [];
}

export function recentPacts(_ctx: FeatureContext): { a: string; b: string; ga: Guild; gb: Guild | null; at: number }[] {
  return [];
}

export function pactsSealed(_ctx: FeatureContext): number {
  return 0;
}

export function repair(_ctx: FeatureContext, _attendeeId: number): never {
  throw conflict('The pact opens soon.');
}
export function goOracle(_ctx: FeatureContext, _attendeeId: number): never {
  throw conflict('The pact opens soon.');
}
export function breakPact(_ctx: FeatureContext, _id: number): never {
  throw conflict('The pact opens soon.');
}
