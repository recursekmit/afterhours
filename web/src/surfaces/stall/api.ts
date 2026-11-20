// Calls the shopkeeper's surface makes. Everything goes through the typed client; the stall cookie does the auth.
import {
  type CartLine,
  type CommitResponse,
  CommitResponseSchema,
  ScanResponseSchema,
  type ScanResponse,
  ShopMeSchema,
} from '@afterhours/shared/features/stalls';
import { OkSchema } from '@afterhours/shared';
import { api, isApiError } from '../../core/api';

export const shopMeKey = ['stall', 'me'] as const;

export async function fetchShopMe() {
  try {
    return await api.get('/api/stalls/shop/me', ShopMeSchema);
  } catch (e) {
    if (isApiError(e) && e.status === 401) return null;
    throw e;
  }
}

export const shopSignIn = (code: string) => api.post('/api/stalls/shop/signin', { code }, ShopMeSchema);
export const shopSignOut = () => api.post('/api/stalls/shop/signout', {}, OkSchema);
export const shopScan = (input: string): Promise<ScanResponse> => api.post('/api/stalls/shop/scan', { input }, ScanResponseSchema);
export const shopCommit = (ticket: string, key: string, lines: CartLine[]): Promise<CommitResponse> => api.post('/api/stalls/shop/commit', { ticket, key, lines }, CommitResponseSchema);

/** A fresh random id; the commit key is this plus what is in the basket, so a retry of the same basket commits once. */
export function newSheetId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '');
  return Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

export function commitKey(sheetId: string, lines: CartLine[]): string {
  const sig = [...lines].sort((a, b) => a.itemId - b.itemId).map((l) => `${l.itemId}x${l.qty}`).join('-');
  return `${sheetId}-${sig}`.slice(0, 64);
}
