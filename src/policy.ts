import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { fmt } from './money.js';
import type { HistoryEntry, OrderItem, PendingOrder, State } from './state.js';

/**
 * The hard gates.
 *
 * Approval for this bot is LLM-mediated: OpenClaw asks "confirm?" in chat and
 * the model decides an answer means yes. That puts the model inside the trust
 * boundary, so the confirmation prompt is NOT a security control. Everything
 * that actually bounds the damage lives in this file, in plain code the model
 * cannot reason its way past.
 *
 * Worst case for a fully confused or prompt-injected agent: one order, under
 * MAX_ORDER_TOTAL_USD, at most MAX_ORDERS_PER_DAY per day, from an allowlisted
 * store, at the address stored in 1Password. It cannot escalate past that.
 */

export class PolicyError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Placements only. Dry runs and failures do not consume the daily budget. */
export function placedInLastDay(history: HistoryEntry[], now: number): HistoryEntry[] {
  return history.filter(h => h.outcome === 'placed' && now - h.placedAt < DAY_MS);
}

export function lastPlacement(history: HistoryEntry[]): HistoryEntry | null {
  const placed = history.filter(h => h.outcome === 'placed');
  if (placed.length === 0) return null;
  return placed.reduce((a, b) => (a.placedAt >= b.placedAt ? a : b));
}

/**
 * A previous run set placementStartedAt and never finished. We cannot know
 * whether Domino's received that order, so we refuse to act until a human
 * clears it. Guessing wrong means either a duplicate charge or a silent
 * no-pizza; both deserve a human.
 */
export function assertNoCrashedPlacement(state: State): void {
  const p = state.pending;
  if (p?.placementStartedAt) {
    throw new PolicyError(
      'crashed_placement',
      `A previous placement for order ${p.id} started at ${new Date(p.placementStartedAt).toISOString()} ` +
        `and never completed. It may or may not have gone through. Check your Domino's account or the ` +
        `store, then run \`pizza reset --i-have-verified\` to clear it.`
    );
  }
}

/** Checks that must pass before we are even willing to build and price a proposal. */
export function assertProposalAllowed(state: State, now: number): void {
  assertNoCrashedPlacement(state);

  const recent = placedInLastDay(state.history, now);
  if (recent.length >= config.policy.maxOrdersPerDay) {
    const next = new Date(Math.min(...recent.map(h => h.placedAt)) + DAY_MS);
    throw new PolicyError(
      'daily_limit',
      `Daily limit reached (${recent.length}/${config.policy.maxOrdersPerDay} orders in the last 24h). ` +
        `Next order allowed after ${next.toLocaleString()}.`
    );
  }

  const last = lastPlacement(state.history);
  if (last) {
    const elapsedMin = (now - last.placedAt) / 60_000;
    if (elapsedMin < config.policy.cooldownMinutes) {
      const wait = Math.ceil(config.policy.cooldownMinutes - elapsedMin);
      throw new PolicyError('cooldown', `Cooldown active — ${wait} more minute(s) before another order can be placed.`);
    }
  }
}

export function assertItemsAllowed(items: OrderItem[]): void {
  if (items.length === 0) throw new PolicyError('empty_order', 'Order contains no items.');
  const totalQty = items.reduce((n, i) => n + i.qty, 0);
  if (totalQty > config.policy.maxItemsPerOrder) {
    throw new PolicyError(
      'too_many_items',
      `Order has ${totalQty} items, over the limit of ${config.policy.maxItemsPerOrder}.`
    );
  }
  if (items.some(i => i.qty < 1 || !Number.isInteger(i.qty))) {
    throw new PolicyError('bad_quantity', 'Every item needs a positive integer quantity.');
  }
}

export function assertStoreAllowed(storeId: string): void {
  const allow = config.policy.allowedStoreIds;
  if (allow && !allow.includes(String(storeId))) {
    throw new PolicyError(
      'store_not_allowed',
      `Store ${storeId} is not in ALLOWED_STORE_IDS (${allow.join(', ')}).`
    );
  }
}

export function assertTotalAllowed(totalCents: number): void {
  if (!Number.isInteger(totalCents)) {
    throw new PolicyError('bad_total', `Total is not an integer cent value (${totalCents}) — refusing to proceed.`);
  }
  if (totalCents <= 0) {
    throw new PolicyError('bad_total', `Total is ${fmt(totalCents)}, which is not a plausible order — refusing.`);
  }
  if (totalCents > config.policy.maxOrderTotalCents) {
    throw new PolicyError(
      'over_max_total',
      `Total ${fmt(totalCents)} exceeds the hard maximum of ${fmt(config.policy.maxOrderTotalCents)}.`
    );
  }
}

/**
 * Binds a confirm token to the exact thing that was quoted. If any of these
 * change between propose and confirm, the token is void and the agent has to
 * start over with a fresh quote the human can see.
 */
export function fingerprint(input: {
  storeId: string;
  serviceMethod: string;
  items: OrderItem[];
  totalCents: number;
}): string {
  const canonical = JSON.stringify({
    storeId: String(input.storeId),
    serviceMethod: input.serviceMethod,
    items: [...input.items]
      .map(i => ({ code: i.code, qty: i.qty, options: canonicalOptions(i.options) }))
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
    totalCents: input.totalCents
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Key order must not affect the hash, so options are sorted before hashing. */
function canonicalOptions(options?: Record<string, Record<string, string>>): Array<[string, Array<[string, string]>]> {
  if (!options) return [];
  return Object.keys(options)
    .sort()
    .map(k => [k, Object.entries(options[k]).sort((a, b) => (a[0] < b[0] ? -1 : 1))] as [string, Array<[string, string]>]);
}

/** Human-typeable, unambiguous alphabet (no O/0/I/1). */
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function mintToken(): { token: string; tokenHash: string } {
  const bytes = randomBytes(8);
  let token = '';
  for (const b of bytes) token += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token.trim().toUpperCase()).digest('hex');
}

export function tokenMatches(provided: string, expectedHash: string): boolean {
  const a = Buffer.from(hashToken(provided), 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Final gate. `freshTotalCents` and `freshFingerprint` must come from a price
 * call made moments ago, not from the stored proposal — that is what catches a
 * price change between quote and charge.
 */
export function assertPlacementAllowed(args: {
  state: State;
  pending: PendingOrder;
  token: string;
  freshTotalCents: number;
  freshFingerprint: string;
  now: number;
}): void {
  const { state, pending, token, freshTotalCents, freshFingerprint, now } = args;

  assertNoCrashedPlacement(state);

  if (now > pending.expiresAt) {
    const ageMin = Math.round((now - pending.createdAt) / 60_000);
    throw new PolicyError(
      'expired',
      `This quote expired (${ageMin} minutes old, TTL is ${Math.round(config.policy.approvalTtlSeconds / 60)} minutes). Get a fresh quote.`
    );
  }

  if (!tokenMatches(token, pending.tokenHash)) {
    throw new PolicyError('bad_token', 'Confirmation token does not match the pending order.');
  }

  if (pending.fingerprint !== freshFingerprint) {
    throw new PolicyError(
      'order_changed',
      'The order changed between the quote and now (store, items, or price differ). Refusing to charge a total you were not shown.'
    );
  }

  if (freshTotalCents !== pending.totalCents) {
    throw new PolicyError(
      'price_changed',
      `Price changed since the quote: you approved ${fmt(pending.totalCents)}, the store now says ${fmt(freshTotalCents)}. Refusing.`
    );
  }

  // Re-check the limits at charge time, not just at quote time. A quote made
  // just under the daily boundary must not be redeemable after it passes.
  assertTotalAllowed(freshTotalCents);
  assertStoreAllowed(pending.storeId);
  assertItemsAllowed(pending.items);

  const recent = placedInLastDay(state.history, now);
  if (recent.length >= config.policy.maxOrdersPerDay) {
    throw new PolicyError('daily_limit', `Daily limit reached (${recent.length}/${config.policy.maxOrdersPerDay}). Refusing.`);
  }

  const last = lastPlacement(state.history);
  if (last && (now - last.placedAt) / 60_000 < config.policy.cooldownMinutes) {
    throw new PolicyError('cooldown', 'Cooldown active since the last order. Refusing.');
  }
}
