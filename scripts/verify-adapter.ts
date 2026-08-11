/**
 * Dev-only smoke check of the Domino's adapter against the live API.
 *
 * Takes an address on the command line so it can run without 1Password, which
 * makes it useful for verifying the adapter on a fresh machine before secrets
 * are configured. It calls validate and price only — there is no code path here
 * that can place an order or read a card.
 *
 *   npx tsx scripts/verify-adapter.ts "2 Portola Plaza, Monterey, CA, 93940" "large cheese pizza"
 */
import { findStore, loadMenu, buildAndPrice } from '../src/dominos.js';
import { resolveItem } from '../src/resolve.js';
import { fmt, percentOf } from '../src/money.js';
import { config } from '../src/config.js';

const [, , rawAddress, ...queries] = process.argv;

if (!rawAddress) {
  console.error('Usage: npx tsx scripts/verify-adapter.ts "<street, city, ST, zip>" [item query...]');
  process.exit(1);
}

const parts = rawAddress.split(',').map(s => s.trim());
if (parts.length < 4) {
  console.error('Address must be "street, city, ST, zip".');
  process.exit(1);
}

const address = {
  address1: parts[0],
  city: parts[1],
  state: parts[2],
  zip: parts[3],
  phone: process.env.VERIFY_PHONE ?? '941-555-2368'
};

const wanted = queries.length ? queries : ['large cheese pizza'];

console.log('▸ Resolving store…');
const store = await findStore(address);
console.log(`  store ${store.storeId} — ${store.address}${store.estimatedWaitMinutes !== null ? ` (~${store.estimatedWaitMinutes} min)` : ''}`);

console.log('▸ Loading menu…');
const menu = await loadMenu(store.storeId);
console.log(`  ${menu.variants.length} orderable variants`);

const items = [];
for (const q of wanted) {
  const r = resolveItem(menu, q, 1);
  if (!r) {
    console.error(`  ✖ no match for "${q}"`);
    process.exit(1);
  }
  console.log(`  "${q}" → ${r.code} ${r.name} (${fmt(r.priceCents)})`);
  console.log(`      why: ${r.reason}`);
  if (r.options) console.log(`      options: ${JSON.stringify(r.options)}`);
  for (const alt of r.alternatives) console.log(`      alt: ${alt.code} ${alt.name} (${fmt(alt.priceCents)})`);
  items.push({ code: r.code, name: r.name, qty: 1, options: r.options, toppingNames: r.toppings });
}

console.log('▸ Validating and pricing (no charge)…');
const priced = await buildAndPrice({ address, storeId: store.storeId, items });

const tipBase = priced.breakdown.foodAndBeverage ?? priced.subtotalCents;
const tip = percentOf(tipBase, config.tipPercent);

console.log('');
for (const i of priced.items) console.log(`  ${i.qty}x ${i.name}  ${fmt(i.priceCents)}`);
console.log(`  Food:     ${fmt(priced.breakdown.foodAndBeverage ?? 0)}`);
console.log(`  Delivery: ${fmt(priced.breakdown.deliveryFee ?? 0)}`);
console.log(`  Tax:      ${fmt(priced.breakdown.tax ?? 0)}`);
console.log(`  Tip:      ${fmt(tip)} (${config.tipPercent}%)`);
console.log(`  TOTAL:    ${fmt(priced.subtotalCents + tip)}`);
console.log('');
console.log(`✅ Adapter works end to end. Nothing was charged. Max allowed total is ${fmt(config.policy.maxOrderTotalCents)}.`);
