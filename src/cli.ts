#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { fmt, percentOf } from './money.js';
import { clearSecrets, error as logError, redact } from './log.js';
import { getDeliveryAddress, getPaymentCard } from './onepassword.js';
import { buildAndPrice, findStore, loadMenu, placeOrder, trackByPhone, type RequestedItem } from './dominos.js';
import { resolveItem, searchVariants } from './resolve.js';
import {
  PolicyError,
  assertItemsAllowed,
  assertPlacementAllowed,
  assertProposalAllowed,
  assertStoreAllowed,
  assertTotalAllowed,
  fingerprint,
  mintToken,
  placedInLastDay
} from './policy.js';
import { acquirePlacementLock, appendHistory, mutateState, readState, type OrderItem } from './state.js';

/**
 * Agent-facing CLI. Every command supports --json so OpenClaw parses structured
 * output instead of scraping prose.
 *
 * The command split is the safety model: `propose` is free and repeatable and
 * never reads card data; `confirm` is the single irreversible command and
 * requires a token that only a prior `propose` can mint.
 */

type Flags = { json: boolean; rest: string[] };

function parseFlags(argv: string[]): Flags {
  const rest: string[] = [];
  let json = false;
  for (const a of argv) {
    if (a === '--json') json = true;
    else rest.push(a);
  }
  return { json, rest };
}

function out(flags: Flags, human: string, data: Record<string, unknown>): void {
  if (flags.json) console.log(JSON.stringify({ ok: true, ...data }, null, 2));
  else console.log(human);
}

function fail(flags: Flags, code: string, message: string, extra: Record<string, unknown> = {}): never {
  if (flags.json) console.log(JSON.stringify({ ok: false, code, error: message, ...extra }, null, 2));
  else logError(`✖ ${message}`);
  process.exit(1);
}

/** "2x large pepperoni" -> { qty: 2, query: "large pepperoni" } */
function parseItemArg(arg: string): { qty: number; query: string } {
  const m = /^(\d+)\s*x\s+(.*)$/i.exec(arg.trim());
  if (m) return { qty: Number(m[1]), query: m[2].trim() };
  return { qty: 1, query: arg.trim() };
}

async function cmdStores(flags: Flags): Promise<void> {
  const address = await getDeliveryAddress();
  const store = await findStore(address);
  out(
    flags,
    `Store ${store.storeId} — ${store.address}` +
      (store.estimatedWaitMinutes !== null ? ` (~${store.estimatedWaitMinutes} min)` : ''),
    { store }
  );
}

async function cmdMenu(flags: Flags): Promise<void> {
  const query = flags.rest.join(' ').trim();
  if (!query) fail(flags, 'usage', 'Usage: pizza menu <search terms>');

  const address = await getDeliveryAddress();
  const store = await findStore(address);
  const menu = await loadMenu(store.storeId);
  const matches = searchVariants(menu, query, 10);

  if (matches.length === 0) fail(flags, 'no_match', `Nothing on store ${store.storeId}'s menu matches "${query}".`);

  out(
    flags,
    matches.map(m => `${m.code.padEnd(12)} ${fmt(m.priceCents).padStart(8)}  ${m.name}`).join('\n'),
    { storeId: store.storeId, matches }
  );
}

async function cmdPropose(flags: Flags): Promise<void> {
  if (flags.rest.length === 0) fail(flags, 'usage', 'Usage: pizza propose "large pepperoni pizza" ["2x garlic bread"]');

  const now = Date.now();
  const state = await readState();

  try {
    assertProposalAllowed(state, now);
  } catch (e) {
    if (e instanceof PolicyError) fail(flags, e.code, e.message);
    throw e;
  }

  const address = await getDeliveryAddress();
  const store = await findStore(address);

  try {
    assertStoreAllowed(store.storeId);
  } catch (e) {
    if (e instanceof PolicyError) fail(flags, e.code, e.message);
    throw e;
  }

  const menu = await loadMenu(store.storeId);
  const requested: RequestedItem[] = [];
  const alternatives: Record<string, unknown> = {};

  for (const arg of flags.rest) {
    const { qty, query } = parseItemArg(arg);
    const resolved = resolveItem(menu, query, qty);
    if (!resolved) {
      fail(flags, 'no_match', `Nothing on store ${store.storeId}'s menu matches "${query}". Try \`pizza menu ${query}\`.`);
    }
    requested.push({ code: resolved.code, name: resolved.name, qty, options: resolved.options, toppingNames: resolved.toppings });
    if (resolved.alternatives.length > 0) {
      alternatives[query] = resolved.alternatives.map(m => ({ code: m.code, name: m.name, price: fmt(m.priceCents) }));
    }
  }

  try {
    assertItemsAllowed(requested.map(r => ({ code: r.code, name: r.name, qty: r.qty, priceCents: 0 })));
  } catch (e) {
    if (e instanceof PolicyError) fail(flags, e.code, e.message);
    throw e;
  }

  const priced = await buildAndPrice({ address, storeId: store.storeId, items: requested });

  // Tip is calculated on food only, not on tax and fees.
  const tipBase = priced.breakdown.foodAndBeverage ?? priced.subtotalCents;
  const tipCents = percentOf(tipBase, config.tipPercent);
  const chargeCents = priced.subtotalCents + tipCents;

  try {
    assertTotalAllowed(chargeCents);
  } catch (e) {
    if (e instanceof PolicyError) fail(flags, e.code, e.message, { total: fmt(chargeCents) });
    throw e;
  }

  const { token, tokenHash } = mintToken();
  const id = randomUUID();
  const fp = fingerprint({
    storeId: store.storeId,
    serviceMethod: config.serviceMethod,
    items: priced.items,
    totalCents: chargeCents
  });

  await mutateState(s => {
    s.pending = {
      id,
      createdAt: now,
      expiresAt: now + config.policy.approvalTtlSeconds * 1000,
      tokenHash,
      fingerprint: fp,
      storeId: store.storeId,
      serviceMethod: config.serviceMethod,
      items: priced.items,
      totalCents: chargeCents,
      tipCents,
      breakdown: priced.breakdown,
      addressSummary: `${address.address1}, ${address.city}, ${address.state} ${address.zip}`
    };
  });

  const lines = [
    '🍕 Quote — nothing has been charged.',
    `Store:    ${store.storeId} (${store.address})`,
    `Deliver:  ${address.address1}, ${address.city}, ${address.state} ${address.zip}`,
    '',
    ...priced.items.map(i => `  ${i.qty}x ${i.name}  ${fmt(i.priceCents)}`),
    '',
    `Food:     ${fmt(priced.breakdown.foodAndBeverage ?? 0)}`,
    `Delivery: ${fmt(priced.breakdown.deliveryFee ?? 0)}`,
    `Tax:      ${fmt(priced.breakdown.tax ?? 0)}`,
    `Tip:      ${fmt(tipCents)}${config.tipPercent === 0 ? ' (tipping disabled)' : ` (${config.tipPercent}%)`}`,
    `TOTAL:    ${fmt(chargeCents)}`,
    '',
    config.dryRun ? '⚠ DRY_RUN is on — confirm will simulate, not charge.' : '⚠ DRY_RUN is off — confirm WILL charge this card.',
    `Expires in ${Math.round(config.policy.approvalTtlSeconds / 60)} min.`,
    '',
    `To place it:  pizza confirm ${token}`
  ];

  out(flags, lines.join('\n'), {
    orderId: id,
    confirmToken: token,
    store: { id: store.storeId, address: store.address, etaMinutes: store.estimatedWaitMinutes },
    items: priced.items.map(i => ({ ...i, price: fmt(i.priceCents) })),
    breakdown: Object.fromEntries(Object.entries(priced.breakdown).map(([k, v]) => [k, fmt(v)])),
    tip: fmt(tipCents),
    total: fmt(chargeCents),
    totalCents: chargeCents,
    dryRun: config.dryRun,
    expiresAt: new Date(now + config.policy.approvalTtlSeconds * 1000).toISOString(),
    alternatives
  });
}

async function cmdConfirm(flags: Flags): Promise<void> {
  const token = flags.rest[0];
  if (!token) fail(flags, 'usage', 'Usage: pizza confirm <token>');

  const state = await readState();
  const pending = state.pending;
  if (!pending) fail(flags, 'no_pending', 'No pending order. Run `pizza propose ...` first.');

  const release = await acquirePlacementLock().catch((e: Error) => fail(flags, 'locked', e.message));

  try {
    // Re-price from scratch. This is what catches a price change, a store
    // closing, or an item going unavailable between quote and charge.
    const address = await getDeliveryAddress();
    const fresh = await buildAndPrice({
      address,
      storeId: pending.storeId,
      items: pending.items.map(i => ({ code: i.code, name: i.name, qty: i.qty, options: i.options }))
    });

    const tipBase = fresh.breakdown.foodAndBeverage ?? fresh.subtotalCents;
    const freshTip = percentOf(tipBase, config.tipPercent);
    const freshCharge = fresh.subtotalCents + freshTip;
    const freshFp = fingerprint({
      storeId: pending.storeId,
      serviceMethod: pending.serviceMethod,
      items: fresh.items,
      totalCents: freshCharge
    });

    try {
      assertPlacementAllowed({
        state,
        pending,
        token,
        freshTotalCents: freshCharge,
        freshFingerprint: freshFp,
        now: Date.now()
      });
    } catch (e) {
      if (e instanceof PolicyError) fail(flags, e.code, e.message, { quoted: fmt(pending.totalCents), current: fmt(freshCharge) });
      throw e;
    }

    if (config.dryRun) {
      await appendHistory({
        id: pending.id,
        placedAt: Date.now(),
        storeId: pending.storeId,
        items: pending.items,
        totalCents: freshCharge,
        outcome: 'dry-run'
      });
      await mutateState(s => {
        s.pending = null;
      });
      out(flags, `✅ DRY RUN passed every check. ${fmt(freshCharge)} was NOT charged. Set DRY_RUN=false to order for real.`, {
        dryRun: true,
        total: fmt(freshCharge),
        orderId: pending.id
      });
      return;
    }

    // Mark in-flight BEFORE the irreversible call. If we crash after this, the
    // next run refuses to act until a human confirms what happened.
    await mutateState(s => {
      if (s.pending) s.pending.placementStartedAt = Date.now();
    });

    const card = await getPaymentCard();
    try {
      const result = await placeOrder({ order: fresh.order, card, chargeCents: freshCharge, tipCents: freshTip });

      await appendHistory({
        id: pending.id,
        placedAt: Date.now(),
        storeId: pending.storeId,
        items: pending.items,
        totalCents: freshCharge,
        outcome: 'placed',
        confirmation: result.confirmation
      });
      await mutateState(s => {
        s.pending = null;
      });

      out(flags, `✅ Ordered. ${fmt(freshCharge)} charged. Confirmation ${result.confirmation}.`, {
        placed: true,
        confirmation: result.confirmation,
        total: fmt(freshCharge)
      });
    } catch (e: any) {
      // The order may or may not have landed. Record it as unknown and keep the
      // pending marker so the next invocation stops and asks for a human.
      await appendHistory({
        id: pending.id,
        placedAt: Date.now(),
        storeId: pending.storeId,
        items: pending.items,
        totalCents: freshCharge,
        outcome: 'failed',
        error: redact(e?.message ?? String(e))
      });
      fail(flags, 'place_failed', `Placement failed: ${redact(e?.message ?? String(e))}. Verify with the store before retrying.`);
    } finally {
      clearSecrets();
    }
  } finally {
    await release();
  }
}

async function cmdStatus(flags: Flags): Promise<void> {
  const state = await readState();
  const now = Date.now();
  const recent = placedInLastDay(state.history, now);

  let tracking: unknown = null;
  if (state.history.some(h => h.outcome === 'placed')) {
    try {
      const address = await getDeliveryAddress();
      tracking = await trackByPhone(address.phone);
    } catch {
      tracking = null;
    }
  }

  const pending = state.pending;
  const human = pending
    ? `Pending: ${pending.items.map(i => `${i.qty}x ${i.name}`).join(', ')} — ${fmt(pending.totalCents)}` +
      (now > pending.expiresAt ? ' (EXPIRED)' : ` (expires in ${Math.round((pending.expiresAt - now) / 60000)} min)`)
    : `No pending order. ${recent.length}/${config.policy.maxOrdersPerDay} placed in the last 24h.`;

  out(flags, human, {
    pending: pending
      ? { ...pending, total: fmt(pending.totalCents), expired: now > pending.expiresAt, tokenHash: undefined }
      : null,
    ordersLast24h: recent.length,
    maxOrdersPerDay: config.policy.maxOrdersPerDay,
    dryRun: config.dryRun,
    tracking
  });
}

async function cmdHistory(flags: Flags): Promise<void> {
  const state = await readState();
  const rows = state.history.slice(-20).reverse();
  out(
    flags,
    rows.length
      ? rows
          .map(h => `${new Date(h.placedAt).toISOString()}  ${h.outcome.padEnd(14)} ${fmt(h.totalCents).padStart(8)}  ${h.items.map(i => `${i.qty}x ${i.name}`).join(', ')}`)
          .join('\n')
      : 'No orders yet.',
    { history: rows }
  );
}

async function cmdCancel(flags: Flags): Promise<void> {
  const cleared = await mutateState(s => {
    const had = s.pending !== null;
    if (s.pending?.placementStartedAt) throw new PolicyError('crashed_placement', 'Cannot cancel: a placement is in flight. Use `pizza reset --i-have-verified`.');
    s.pending = null;
    return had;
  });
  out(flags, cleared ? 'Pending order discarded.' : 'Nothing pending.', { cleared });
}

async function cmdReset(flags: Flags): Promise<void> {
  if (!flags.rest.includes('--i-have-verified')) {
    fail(
      flags,
      'usage',
      'This clears a stuck in-flight placement. Verify with Domino\'s whether the order went through FIRST, then rerun with --i-have-verified.'
    );
  }
  await mutateState(s => {
    if (s.pending) {
      s.history.push({
        id: s.pending.id,
        placedAt: Date.now(),
        storeId: s.pending.storeId,
        items: s.pending.items,
        totalCents: s.pending.totalCents,
        outcome: 'unknown-crashed'
      });
    }
    s.pending = null;
  });
  out(flags, 'Cleared. The stuck order was recorded as unknown-crashed in history.', { reset: true });
}

const COMMANDS: Record<string, (f: Flags) => Promise<void>> = {
  stores: cmdStores,
  menu: cmdMenu,
  propose: cmdPropose,
  confirm: cmdConfirm,
  status: cmdStatus,
  history: cmdHistory,
  cancel: cmdCancel,
  reset: cmdReset
};

async function main(): Promise<void> {
  // Piping into `head` or a closed reader must exit quietly, not crash.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });

  const [, , command, ...argv] = process.argv;
  const flags = parseFlags(argv);

  if (!command || command === 'help' || command === '--help') {
    console.log(
      [
        'pizza <command>',
        '',
        '  stores                    Show the store that would fulfil the order',
        '  menu <terms>              Search the live store menu',
        '  propose <item> [item...]  Price an order and mint a confirm token (no charge)',
        '  confirm <token>           Place the pending order (the only irreversible command)',
        '  status                    Pending order, daily budget, delivery tracking',
        '  history                   Recent orders',
        '  cancel                    Discard the pending order',
        '  reset --i-have-verified   Clear a stuck in-flight placement',
        '',
        '  --json                    Machine-readable output'
      ].join('\n')
    );
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) fail(flags, 'unknown_command', `Unknown command "${command}". Try \`pizza help\`.`);
  await handler(flags);
}

main().catch(e => {
  clearSecrets();
  if (e instanceof PolicyError) {
    logError(`✖ ${e.message}`);
    process.exit(1);
  }
  logError(`✖ ${redact(e?.message ?? String(e))}`);
  process.exit(1);
});
