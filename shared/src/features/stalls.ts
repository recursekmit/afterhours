// Stalls and rewards: spend points at the food/merch stalls, free mocktails, a shopkeeper surface at /stall.
// Contract for server/src/features/stalls and web/src/features/stalls (+ web/src/surfaces/stall).
//
// Money model: balance = points earned (core ledger) - points spent at stalls (stalls_txn). Spending never
// touches the ledger, so the leaderboard keeps ranking lifetime earned points.
import { z } from 'zod';
import { AvatarConfigSchema } from '../avatar';

/** The QR on the phone rotates every window; the server accepts the current and the previous one. */
export const QR_WINDOW_MS = 30_000;
export const STALL_CODE_LEN = 6;
/** The short typed code under the QR. */
export const TYPED_CODE_LEN = 6;
export const MAX_IMAGE_BYTES = 300 * 1024;
export const MAX_QTY = 20;
export const MAX_ALLOWANCE = 20;
/** How long a scanned person stays "on the counter" before the shopkeeper has to scan again. */
export const TICKET_MS = 5 * 60_000;

const id = z.number().int().positive();
const points = z.number().int().min(0).max(100_000);
const qty = z.number().int().min(1).max(MAX_QTY);
const text = (max: number) => z.string().trim().min(1).max(max);

/* ------------------------------------------------------------------ cart + pure plan */

export const CartLineSchema = z.object({ itemId: id, qty });
export type CartLine = z.infer<typeof CartLineSchema>;
export const CartSchema = z.object({ lines: z.array(CartLineSchema).max(40) });
export type Cart = z.infer<typeof CartSchema>;

export interface PlanItem {
  id: number;
  name: string;
  price: number;
  freeDrink: boolean;
  /** null = unlimited */
  stockLeft: number | null;
  /** how many more this person may take; null = no limit */
  limitLeft: number | null;
}
export interface PlanLine {
  itemId: number;
  name: string;
  qty: number;
  /** units covered by the free-drink allowance */
  freeQty: number;
  /** units paid with points */
  paidQty: number;
  price: number;
  points: number;
}
export interface Plan {
  lines: PlanLine[];
  freeUsed: number;
  points: number;
  problems: string[];
  /** points missing, 0 when affordable */
  shortBy: number;
  ok: boolean;
}

/**
 * The one place money and allowance are worked out. The server runs it inside the transaction (that run is
 * the authority); the shopkeeper and attendee screens run it for an instant preview.
 */
export function planCart(input: { items: PlanItem[]; lines: CartLine[]; freeLeft: number; balance: number }): Plan {
  const byId = new Map(input.items.map((i) => [i.id, i]));
  const merged = new Map<number, number>();
  for (const l of input.lines) merged.set(l.itemId, (merged.get(l.itemId) ?? 0) + l.qty);
  const problems: string[] = [];
  const lines: PlanLine[] = [];
  let free = Math.max(0, input.freeLeft);
  let freeUsed = 0;
  let total = 0;
  for (const [itemId, q] of merged) {
    const it = byId.get(itemId);
    if (!it) {
      problems.push('Something in the basket is not on this menu any more.');
      continue;
    }
    if (it.stockLeft !== null && q > it.stockLeft) {
      problems.push(it.stockLeft <= 0 ? `${it.name} is sold out.` : `Only ${it.stockLeft} ${it.name} left.`);
    }
    if (it.limitLeft !== null && q > it.limitLeft) {
      problems.push(it.limitLeft <= 0 ? `They already had their limit of ${it.name}.` : `Only ${it.limitLeft} more ${it.name} allowed for them.`);
    }
    let freeQty = 0;
    if (it.freeDrink) {
      freeQty = Math.min(q, free);
      free -= freeQty;
      freeUsed += freeQty;
    }
    const paidQty = q - freeQty;
    if (it.freeDrink && paidQty > 0 && it.price === 0) problems.push(`No free drinks left for ${it.name}.`);
    const pts = paidQty * it.price;
    total += pts;
    lines.push({ itemId, name: it.name, qty: q, freeQty, paidQty, price: it.price, points: pts });
  }
  if (lines.length === 0 && problems.length === 0) problems.push('The basket is empty.');
  const shortBy = Math.max(0, total - Math.max(0, input.balance));
  if (shortBy > 0) problems.push(`${shortBy} points short.`);
  return { lines, freeUsed, points: total, problems, shortBy, ok: problems.length === 0 };
}

/* ------------------------------------------------------------------ shared views */

export const StallBriefSchema = z.object({
  id,
  name: z.string(),
  /** An emoji, or "doodle:<icon name>". */
  emoji: z.string(),
  location: z.string(),
});
export type StallBrief = z.infer<typeof StallBriefSchema>;

export const ItemViewSchema = z.object({
  id,
  stallId: id,
  name: z.string(),
  price: z.number().int(),
  /** URL under /api/stalls/img/, or null */
  image: z.string().nullable(),
  /** units left, null = unlimited */
  stockLeft: z.number().int().nullable(),
  /** per person, null = no limit */
  limit: z.number().int().nullable(),
  /** how many this person already took */
  bought: z.number().int(),
  freeDrink: z.boolean(),
});
export type ItemView = z.infer<typeof ItemViewSchema>;

export const AllowanceSchema = z.object({ total: z.number().int(), used: z.number().int(), left: z.number().int() });
export type Allowance = z.infer<typeof AllowanceSchema>;

/** Puzzle-hour tokens (arcade). Read only: staff claim those in the console. */
export const PuzzleTokensSchema = z.object({ tokens: z.number().int(), cost: z.number().int() });
export type PuzzleTokens = z.infer<typeof PuzzleTokensSchema>;

export const ReceiptLineSchema = z.object({ name: z.string(), qty: z.number().int(), freeQty: z.number().int(), points: z.number().int() });
export const ReceiptSchema = z.object({
  id,
  stallId: id,
  stallName: z.string(),
  at: z.number(),
  status: z.enum(['ok', 'void']),
  totalPoints: z.number().int(),
  freeUsed: z.number().int(),
  lines: z.array(ReceiptLineSchema),
});
export type Receipt = z.infer<typeof ReceiptSchema>;

export const StallMenuSchema = StallBriefSchema.extend({ items: z.array(ItemViewSchema) });
export type StallMenu = z.infer<typeof StallMenuSchema>;

/* ------------------------------------------------------------------ attendee */

/** GET /api/stalls/wallet */
/** The cheapest mocktail you can buy with points: drives the "N more points to your next mocktail" bar. */
export const NextMocktailSchema = z.object({ name: z.string(), price: z.number().int(), stallName: z.string() });
export type NextMocktail = z.infer<typeof NextMocktailSchema>;

export const WalletSchema = z.object({
  nextMocktail: NextMocktailSchema.nullable(),
  earned: z.number().int(),
  spent: z.number().int(),
  balance: z.number().int(),
  allowance: AllowanceSchema,
  puzzle: PuzzleTokensSchema.nullable(),
  receipts: z.array(ReceiptSchema),
});
export type Wallet = z.infer<typeof WalletSchema>;

/** GET /api/stalls/menu */
export const MenuResponseSchema = z.object({ stalls: z.array(StallMenuSchema) });
export type MenuResponse = z.infer<typeof MenuResponseSchema>;

/** GET /api/stalls/qr */
export const QrResponseSchema = z.object({
  token: z.string(),
  /** short typed fallback, same lifetime */
  code: z.string(),
  /** what the QR encodes: ${APP_URL}/stall/r/<token> */
  url: z.string(),
  expiresAt: z.number(),
  windowMs: z.number().int(),
  serverNow: z.number(),
});
export type QrResponse = z.infer<typeof QrResponseSchema>;

/* ------------------------------------------------------------------ shopkeeper */

export const ShopSignInRequestSchema = z.object({ code: z.string().trim().min(3).max(12) });

export const TallySchema = z.object({
  txns: z.number().int(),
  units: z.number().int(),
  freeUnits: z.number().int(),
  points: z.number().int(),
  byItem: z.array(z.object({ itemId: id, name: z.string(), qty: z.number().int() })),
});
export type Tally = z.infer<typeof TallySchema>;

export const ShopMeSchema = z.object({ stall: StallBriefSchema, tally: TallySchema });
export type ShopMe = z.infer<typeof ShopMeSchema>;

/** POST /api/stalls/shop/scan: the token from the QR (or the whole URL), or the short typed code. */
export const ScanRequestSchema = z.object({ input: z.string().trim().min(3).max(300) });

export const ScanResponseSchema = z.object({
  /** signed, bound to this person and this stall, valid for TICKET_MS */
  ticket: z.string(),
  ticketExpiresAt: z.number(),
  attendee: z.object({ nickname: z.string(), avatar: AvatarConfigSchema }),
  allowance: AllowanceSchema,
  balance: z.number().int(),
  puzzle: PuzzleTokensSchema.nullable(),
  /** their basket, limited to this stall's items */
  cart: z.array(CartLineSchema),
  menu: z.array(ItemViewSchema),
});
export type ScanResponse = z.infer<typeof ScanResponseSchema>;

/** POST /api/stalls/shop/commit */
export const CommitRequestSchema = z.object({
  ticket: z.string().min(10).max(400),
  /** idempotency key: a double tap or a retry commits once */
  key: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  lines: z.array(CartLineSchema).min(1).max(40),
});
export type CommitRequest = z.infer<typeof CommitRequestSchema>;

export const CommitResponseSchema = z.object({
  duplicate: z.boolean(),
  txnId: id,
  stallName: z.string(),
  lines: z.array(ReceiptLineSchema),
  freeUsed: z.number().int(),
  freeLeft: z.number().int(),
  pointsSpent: z.number().int(),
  balance: z.number().int(),
  nickname: z.string(),
  tally: TallySchema,
});
export type CommitResponse = z.infer<typeof CommitResponseSchema>;

/* ------------------------------------------------------------------ console */

export const StallInputSchema = z.object({
  name: text(40),
  emoji: z.string().trim().max(24).default('🍹'),
  location: z.string().trim().max(60).default(''),
});
export const StallPatchSchema = z.object({
  name: text(40).optional(),
  emoji: z.string().trim().max(24).optional(),
  location: z.string().trim().max(60).optional(),
  active: z.boolean().optional(),
});

const itemFields = {
  name: text(60),
  price: points,
  /** null/omitted = unlimited */
  stock: z.number().int().min(0).max(100_000).nullable().optional(),
  limit: z.number().int().min(1).max(MAX_QTY * 5).nullable().optional(),
  freeDrink: z.boolean().optional(),
};
export const ItemInputSchema = z.object({ stallId: id, ...itemFields });
export const ItemPatchSchema = z.object({
  name: text(60).optional(),
  price: points.optional(),
  stock: z.number().int().min(0).max(100_000).nullable().optional(),
  limit: z.number().int().min(1).max(MAX_QTY * 5).nullable().optional(),
  freeDrink: z.boolean().optional(),
  active: z.boolean().optional(),
});

/** POST /api/stalls/admin/items/:id/image. base64 of the raw file, optionally as a data: URL. */
export const ImageUploadSchema = z.object({ data: z.string().min(8).max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 200) });

export const ImportRequestSchema = z.object({ csv: z.string().min(1).max(200_000) });
export const ImportResultSchema = z.object({
  stallsCreated: z.number().int(),
  itemsCreated: z.number().int(),
  itemsUpdated: z.number().int(),
  errors: z.array(z.object({ line: z.number().int(), message: z.string() })),
});
export type ImportResult = z.infer<typeof ImportResultSchema>;

export const StallSettingsSchema = z.object({
  /** free mocktails per attendee */
  allowance: z.number().int().min(0).max(MAX_ALLOWANCE),
  /** If true, spending should lower leaderboard rank. Stored here; the leaderboard does not read it yet. */
  spendLowersBoard: z.boolean(),
});
export type StallSettings = z.infer<typeof StallSettingsSchema>;
export const StallSettingsPatchSchema = StallSettingsSchema.partial();

export const AdminItemSchema = ItemViewSchema.omit({ bought: true }).extend({
  stock: z.number().int().nullable(),
  sold: z.number().int(),
  active: z.boolean(),
});
export type AdminItem = z.infer<typeof AdminItemSchema>;

export const AdminStallSchema = StallBriefSchema.extend({
  code: z.string(),
  active: z.boolean(),
  sales: z.object({ txns: z.number().int(), units: z.number().int(), freeUnits: z.number().int(), points: z.number().int() }),
  items: z.array(AdminItemSchema),
});
export type AdminStall = z.infer<typeof AdminStallSchema>;

/** GET /api/stalls/admin/overview */
export const AdminOverviewSchema = z.object({
  settings: StallSettingsSchema,
  stalls: z.array(AdminStallSchema),
  totals: z.object({ txns: z.number().int(), points: z.number().int(), freeUnits: z.number().int() }),
});
export type AdminOverview = z.infer<typeof AdminOverviewSchema>;

export const AdminTxnSchema = z.object({
  id,
  at: z.number(),
  stallId: id,
  stallName: z.string(),
  kitId: z.string(),
  nickname: z.string(),
  lines: z.array(ReceiptLineSchema),
  totalPoints: z.number().int(),
  freeUsed: z.number().int(),
  status: z.enum(['ok', 'void']),
  voidReason: z.string().nullable(),
});
export type AdminTxn = z.infer<typeof AdminTxnSchema>;
export const AdminTxnsSchema = z.object({ txns: z.array(AdminTxnSchema) });

export const VoidRequestSchema = z.object({ reason: z.string().trim().max(120).optional() });
export const RotateResultSchema = z.object({ code: z.string() });

/* ------------------------------------------------------------------ live */

export const RedeemedEventSchema = z.object({
  txnId: id,
  stallName: z.string(),
  lines: z.array(ReceiptLineSchema),
  freeUsed: z.number().int(),
  freeLeft: z.number().int(),
  pointsSpent: z.number().int(),
  balance: z.number().int(),
});
export type RedeemedEvent = z.infer<typeof RedeemedEventSchema>;

declare module '../live' {
  interface LiveEvents {
    /** To one attendee: a shopkeeper just handed you something. Phone celebrates. */
    'stalls.redeemed': RedeemedEvent;
    /** To one attendee: an organiser voided a purchase; points, drinks and stock are back. */
    'stalls.voided': { txnId: number; stallName: string; freeLeft: number; balance: number };
  }
}
