import 'dotenv/config';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dollarsToCents } from './money.js';

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v ? v : fallback;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  throw new Error(`${name} must be true or false, got ${JSON.stringify(raw)}`);
}

/** Comma-separated store IDs, or null meaning "any store". */
function storeAllowlist(): string[] | null {
  const raw = process.env.ALLOWED_STORE_IDS?.trim();
  if (!raw) return null;
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  return ids.length ? ids : null;
}

export const config = {
  /** Domino's needs a name and email on the customer record; these are not secrets. */
  customer: {
    firstName: optional('CUSTOMER_FIRST_NAME', 'Customer'),
    lastName: optional('CUSTOMER_LAST_NAME', 'Order'),
    email: required('CUSTOMER_EMAIL')
  },

  serviceMethod: (() => {
    const m = optional('SERVICE_METHOD', 'Delivery');
    if (m !== 'Delivery' && m !== 'Carryout') throw new Error(`SERVICE_METHOD must be Delivery or Carryout, got ${m}`);
    return m as 'Delivery' | 'Carryout';
  })(),

  tipPercent: num('DEFAULT_TIP_PERCENT', 20),

  /**
   * Hard gates. These are enforced in code the LLM cannot argue with. Because
   * approval is LLM-mediated (OpenClaw in-chat confirm), these limits are the
   * real security boundary, not the confirmation prompt.
   */
  policy: {
    maxOrderTotalCents: dollarsToCents(num('MAX_ORDER_TOTAL_USD', 75), 'MAX_ORDER_TOTAL_USD'),
    maxOrdersPerDay: num('MAX_ORDERS_PER_DAY', 1),
    cooldownMinutes: num('ORDER_COOLDOWN_MINUTES', 30),
    approvalTtlSeconds: num('APPROVAL_TTL_SECONDS', 600),
    maxItemsPerOrder: num('MAX_ITEMS_PER_ORDER', 6),
    allowedStoreIds: storeAllowlist()
  },

  /** When true (the default), `confirm` runs every check and stops short of charging. */
  dryRun: bool('DRY_RUN', true),

  /** Where pending orders, history, and the lockfile live. */
  stateDir: optional('PIZZA_STATE_DIR', join(homedir(), '.pizza-bot')),

  refs: {
    address1: required('OP_ADDRESS1_REF'),
    city: required('OP_CITY_REF'),
    state: required('OP_STATE_REF'),
    zip: required('OP_ZIP_REF'),
    phone: required('OP_PHONE_REF'),
    cardNumber: required('OP_CARD_NUMBER_REF'),
    expMonth: required('OP_CARD_EXP_MONTH_REF'),
    expYear: required('OP_CARD_EXP_YEAR_REF'),
    cvv: required('OP_CARD_CVV_REF'),
    cardName: required('OP_CARD_NAME_REF'),
    /** Billing zip for the card. Falls back to the delivery zip, which is usually correct. */
    billingZip: optional('OP_CARD_BILLING_ZIP_REF', required('OP_ZIP_REF'))
  }
};

export type Config = typeof config;
