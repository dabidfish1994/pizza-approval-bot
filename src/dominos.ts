import { NearbyStores, Menu, Item, Customer, Order, Payment, Tracking } from 'dominos';
import { config } from './config.js';
import { toCents } from './money.js';
import type { DeliveryAddress, PaymentCard } from './onepassword.js';
import type { OrderItem } from './state.js';

/**
 * Adapter for Domino's ordering API.
 *
 * Two things learned the hard way and encoded here:
 *  1. Product codes are store-specific. `16SCREEN` prices fine at one store and
 *     returns PickAlternateProduct at the next one, so nothing is hardcoded —
 *     every item is resolved against the live menu of the store we will order from.
 *  2. The upstream `Payment` class fails silently on an unrecognized card type,
 *     handing back an object with an empty number and a zero amount. It is
 *     validated after construction rather than trusted.
 */

export type ResolvedStore = {
  storeId: string;
  address: string;
  estimatedWaitMinutes: number | null;
};

export function addressLine(a: DeliveryAddress): string {
  return `${a.address1}, ${a.city}, ${a.state}, ${a.zip}`;
}

export async function findStore(address: DeliveryAddress): Promise<ResolvedStore> {
  const nearby = await new NearbyStores(addressLine(address));
  const stores: any[] = nearby.stores ?? [];
  if (stores.length === 0) throw new Error('No Domino\'s stores found near that address.');

  const wantsDelivery = config.serviceMethod === 'Delivery';
  const usable = stores.filter(s => {
    if (!s.IsOnlineCapable || !s.IsOpen || !s.ServiceIsOpen) return false;
    return wantsDelivery ? s.IsDeliveryStore && s.ServiceIsOpen.Delivery : s.ServiceIsOpen.Carryout;
  });

  if (usable.length === 0) {
    const anyOpen = stores.some(s => s.IsOpen);
    throw new Error(
      anyOpen
        ? `No nearby store is currently open for ${config.serviceMethod}.`
        : 'No nearby Domino\'s store is open right now.'
    );
  }

  // NearbyStores returns nearest-first for delivery.
  const best = usable[0];
  return {
    storeId: String(best.StoreID),
    address: String(best.AddressDescription ?? '').replace(/\s*\n\s*/g, ', ').replace(/[,\s]+$/, '').trim(),
    estimatedWaitMinutes: parseWait(best.ServiceMethodEstimatedWaitMinutes?.Delivery?.Min)
  };
}

function parseWait(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export type MenuVariant = {
  code: string;
  name: string;
  priceCents: number;
  /** S_PIZZA marks a plain base pizza; anything else is a specialty pie. */
  productCode: string;
  sizeCode: string;
};

export type MenuTopping = {
  code: string;
  name: string;
};

export type MenuIndex = {
  storeId: string;
  variants: MenuVariant[];
  toppings: MenuTopping[];
};

export async function loadMenu(storeId: string): Promise<MenuIndex> {
  const menu = await new Menu(storeId);
  const raw = (menu as any).menu?.variants ?? {};
  const variants: MenuVariant[] = [];

  for (const [code, v] of Object.entries<any>(raw)) {
    if (!v?.name) continue;
    let priceCents: number;
    try {
      priceCents = toCents(v.price, `variant ${code} price`);
    } catch {
      continue; // Unpriceable variants cannot be ordered anyway.
    }
    variants.push({
      code,
      name: String(v.name),
      priceCents,
      productCode: String(v.productCode ?? ''),
      sizeCode: String(v.sizeCode ?? '')
    });
  }

  if (variants.length === 0) throw new Error(`Store ${storeId} returned an empty menu.`);

  // Topping groups are keyed lowercase by product type in the v3 payload.
  const rawToppings = (menu as any).menu?.toppings?.pizza ?? {};
  const toppings: MenuTopping[] = Object.entries<any>(rawToppings)
    .filter(([, t]) => t?.name)
    .map(([code, t]) => ({ code, name: String(t.name) }));

  return { storeId, variants, toppings };
}

export type PricedOrder = {
  order: any;
  items: OrderItem[];
  /** Food + fees + tax, as Domino's computes it. Excludes tip. */
  subtotalCents: number;
  breakdown: Record<string, number>;
};

export type RequestedItem = {
  code: string;
  name: string;
  qty: number;
  /** Topping selections, e.g. { P: { '1/1': '1' } }. Omit to use the store's defaults. */
  options?: Record<string, Record<string, string>>;
  /** Display names of chosen toppings; appended so the quote shows what was ordered. */
  toppingNames?: string[];
};

/** Builds and prices an order. Never touches payment data. */
export async function buildAndPrice(args: {
  address: DeliveryAddress;
  storeId: string;
  items: RequestedItem[];
}): Promise<PricedOrder> {
  const customer = new Customer({
    address: addressLine(args.address),
    firstName: config.customer.firstName,
    lastName: config.customer.lastName,
    phone: args.address.phone,
    email: config.customer.email
  });

  const order = new Order(customer);
  order.storeID = args.storeId;
  order.serviceMethod = config.serviceMethod;

  for (const item of args.items) {
    order.addItem(new Item(item.options ? { code: item.code, qty: item.qty, options: item.options } : { code: item.code, qty: item.qty }));
  }

  await order.validate();
  await order.price();

  const ab = order.amountsBreakdown ?? {};
  const subtotalCents = toCents(ab.customer, 'amountsBreakdown.customer');

  const breakdown: Record<string, number> = {};
  for (const key of ['foodAndBeverage', 'deliveryFee', 'tax', 'surcharge', 'adjustment', 'savings'] as const) {
    if (ab[key] !== undefined) {
      try {
        breakdown[key] = toCents(ab[key], `amountsBreakdown.${key}`);
      } catch {
        /* a field we cannot parse is omitted from display, never from the total */
      }
    }
  }

  // Prefer the store's own product names over ours — they are what will appear
  // on the receipt, and they confirm the code resolved to what we expected.
  // Toppings are appended, because Domino's product name omits them and the
  // human approving the quote has to see what is actually on the pizza.
  const priced: OrderItem[] = args.items.map((requested, i) => {
    const p = order.products?.[i] ?? {};
    const storeName = String(p.name ?? requested.name);
    const toppings = requested.toppingNames ?? [];
    return {
      code: requested.code,
      name: toppings.length ? `${storeName} with ${toppings.join(', ')}` : storeName,
      qty: requested.qty,
      priceCents: safeCents(p.amount ?? p.price),
      options: requested.options
    };
  });

  return { order, items: priced, subtotalCents, breakdown };
}

function safeCents(v: unknown): number {
  try {
    return toCents(v);
  } catch {
    return 0;
  }
}

/**
 * Attaches payment and submits. The only irreversible call in the codebase.
 * `chargeCents` is the full amount that will hit the card, tip included.
 */
export async function placeOrder(args: {
  order: any;
  card: PaymentCard;
  chargeCents: number;
  tipCents: number;
}): Promise<{ confirmation: string; raw: any }> {
  const payment = new Payment({
    amount: args.chargeCents / 100,
    number: args.card.number,
    expiration: args.card.expiration,
    securityCode: args.card.securityCode,
    postalCode: args.card.postalCode,
    tipAmount: args.tipCents / 100
  });

  // The upstream constructor swallows unrecognized card types and returns a
  // hollow object. Catch that here rather than sending an empty payment.
  if (!payment.cardType || !payment.number) {
    throw new Error(
      'The Domino\'s client did not recognize this card type, so it produced an empty payment object. ' +
        'Its card regexes are outdated and miss Mastercard 2-series BINs (2221-2720). ' +
        'Use a different card, or patch the library. Refusing to submit an empty payment.'
    );
  }
  if (toCents(payment.amount, 'payment.amount') !== args.chargeCents) {
    throw new Error('Payment amount did not survive construction intact. Refusing to submit.');
  }

  args.order.payments.push(payment);
  await args.order.place();

  const placed = args.order.placeResponse?.Order ?? {};
  return {
    confirmation: String(placed.OrderID ?? args.order.orderID ?? 'unknown'),
    raw: { status: args.order.placeResponse?.Status, orderId: placed.OrderID }
  };
}

export async function trackByPhone(phone: string): Promise<any> {
  const tracking = new Tracking();
  return tracking.byPhone(phone);
}
