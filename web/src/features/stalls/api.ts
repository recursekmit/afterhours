// Queries for the attendee side of stalls. Server state lives in TanStack queries, so a reconnect refetches it.
import {
  type Cart,
  CartSchema,
  type CartLine,
  MenuResponseSchema,
  QrResponseSchema,
  WalletSchema,
} from '@afterhours/shared/features/stalls';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../core/api';

export const sk = {
  wallet: ['stalls', 'wallet'] as const,
  menu: ['stalls', 'menu'] as const,
  cart: ['stalls', 'cart'] as const,
  qr: ['stalls', 'qr'] as const,
};

export const useWallet = () => useQuery({ queryKey: sk.wallet, queryFn: () => api.get('/api/stalls/wallet', WalletSchema), staleTime: 10_000 });
export const useMenu = () => useQuery({ queryKey: sk.menu, queryFn: () => api.get('/api/stalls/menu', MenuResponseSchema), staleTime: 10_000 });
export const useCart = () => useQuery({ queryKey: sk.cart, queryFn: () => api.get('/api/stalls/cart', CartSchema) });
export const useQr = () => useQuery({ queryKey: sk.qr, queryFn: () => api.get('/api/stalls/qr', QrResponseSchema), staleTime: 0, gcTime: 0 });

/** Optimistic basket edits: the screen reacts instantly, the server copy follows. */
export function useSetCart() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (lines: CartLine[]) => api.put('/api/stalls/cart', { lines }, CartSchema),
    onMutate: async (lines) => {
      await qc.cancelQueries({ queryKey: sk.cart });
      const prev = qc.getQueryData<Cart>(sk.cart);
      qc.setQueryData<Cart>(sk.cart, { lines });
      return { prev };
    },
    onError: (_e, _l, ctx) => {
      if (ctx?.prev) qc.setQueryData(sk.cart, ctx.prev);
    },
    onSuccess: (data) => qc.setQueryData(sk.cart, data),
  });
}

export function changeLine(lines: CartLine[], itemId: number, delta: number, max = 20): CartLine[] {
  const cur = lines.find((l) => l.itemId === itemId)?.qty ?? 0;
  const next = Math.max(0, Math.min(max, cur + delta));
  const rest = lines.filter((l) => l.itemId !== itemId);
  return next > 0 ? [...rest, { itemId, qty: next }] : rest;
}
