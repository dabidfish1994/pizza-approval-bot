import './env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic: these read config, which env.ts must populate first.
const {
  PolicyError,
  assertItemsAllowed,
  assertNoCrashedPlacement,
  assertPlacementAllowed,
  assertProposalAllowed,
  assertStoreAllowed,
  assertTotalAllowed,
  fingerprint,
  hashToken,
  lastPlacement,
  mintToken,
  placedInLastDay,
  tokenMatches
} = await import('../src/policy.ts');
const { config } = await import('../src/config.ts');

type AnyState = Parameters<typeof assertProposalAllowed>[0];

const ITEM = { code: 'P14IRECZ', name: 'Large Cheese', qty: 1, priceCents: 2549 };

/** assert.throws() does not return the error, and we need to assert on .code. */
function policyError(fn: () => void): InstanceType<typeof PolicyError> {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof PolicyError, `expected PolicyError, got ${String(e)}`);
    return e as InstanceType<typeof PolicyError>;
  }
  throw new assert.AssertionError({ message: 'expected a PolicyError, but nothing was thrown' });
}

function state(over: Partial<AnyState> = {}): AnyState {
  return { version: 1, pending: null, history: [], ...over } as AnyState;
}

function placed(atMsAgo: number, totalCents = 3423) {
  return {
    id: 'h1',
    placedAt: Date.now() - atMsAgo,
    storeId: '8278',
    items: [ITEM],
    totalCents,
    outcome: 'placed' as const
  };
}

function pendingOrder(over: Record<string, unknown> = {}) {
  const now = Date.now();
  const items = [ITEM];
  const totalCents = 3423;
  return {
    id: 'o1',
    createdAt: now,
    expiresAt: now + 600_000,
    tokenHash: hashToken('TESTTOKEN'),
    fingerprint: fingerprint({ storeId: '8278', serviceMethod: 'Delivery', items, totalCents }),
    storeId: '8278',
    serviceMethod: 'Delivery' as const,
    items,
    totalCents,
    tipCents: 0,
    breakdown: {},
    addressSummary: '1 Main St',
    ...over
  };
}

// ── fingerprint ──────────────────────────────────────────────────────────────

test('fingerprint ignores item ordering but not item content', () => {
  const a = { code: 'A', name: 'A', qty: 1, priceCents: 100 };
  const b = { code: 'B', name: 'B', qty: 2, priceCents: 200 };
  const base = { storeId: '1', serviceMethod: 'Delivery', totalCents: 300 };

  assert.equal(
    fingerprint({ ...base, items: [a, b] }),
    fingerprint({ ...base, items: [b, a] }),
    'reordering the same items must not invalidate a token'
  );
  assert.notEqual(fingerprint({ ...base, items: [a, b] }), fingerprint({ ...base, items: [a, { ...b, qty: 3 }] }));
  assert.notEqual(fingerprint({ ...base, items: [a] }), fingerprint({ ...base, items: [a, b] }));
});

test('fingerprint changes when store, method, or total changes', () => {
  const items = [ITEM];
  const base = { storeId: '1', serviceMethod: 'Delivery', items, totalCents: 300 };
  assert.notEqual(fingerprint(base), fingerprint({ ...base, storeId: '2' }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, serviceMethod: 'Carryout' }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, totalCents: 301 }));
});

// ── tokens ───────────────────────────────────────────────────────────────────

test('minted tokens use an unambiguous alphabet and verify', () => {
  for (let i = 0; i < 50; i++) {
    const { token, tokenHash } = mintToken();
    assert.match(token, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/, 'no O/0/I/1 confusion');
    assert.ok(tokenMatches(token, tokenHash));
  }
});

test('token verification is case- and whitespace-insensitive but not value-insensitive', () => {
  const { token, tokenHash } = mintToken();
  assert.ok(tokenMatches(token.toLowerCase(), tokenHash));
  assert.ok(tokenMatches(`  ${token}  `, tokenHash));
  assert.ok(!tokenMatches('AAAAAAAA', tokenHash));
  assert.ok(!tokenMatches('', tokenHash));
  assert.ok(!tokenMatches(token.slice(0, 7), tokenHash));
});

// ── rate limiting ────────────────────────────────────────────────────────────

test('only real placements count against the daily budget', () => {
  const history = [
    { ...placed(1000), outcome: 'dry-run' as const },
    { ...placed(2000), outcome: 'failed' as const },
    { ...placed(3000), outcome: 'unknown-crashed' as const },
    placed(4000)
  ];
  assert.equal(placedInLastDay(history, Date.now()).length, 1, 'dry runs and failures must not consume the budget');
});

test('placements older than 24h fall out of the window', () => {
  const history = [placed(25 * 60 * 60 * 1000), placed(1000)];
  assert.equal(placedInLastDay(history, Date.now()).length, 1);
});

test('lastPlacement finds the most recent real order', () => {
  const older = placed(10 * 60_000);
  const newer = placed(60_000);
  assert.equal(lastPlacement([older, newer])?.placedAt, newer.placedAt);
  assert.equal(lastPlacement([newer, older])?.placedAt, newer.placedAt);
  assert.equal(lastPlacement([{ ...placed(1000), outcome: 'dry-run' as const }]), null);
});

// ── proposal gates ───────────────────────────────────────────────────────────

test('a clean slate allows a proposal', () => {
  assert.doesNotThrow(() => assertProposalAllowed(state(), Date.now()));
});

test('daily limit blocks a proposal', () => {
  const err = policyError(() => assertProposalAllowed(state({ history: [placed(60_000)] }), Date.now()));
  // 1 order/day and a 30-min cooldown both apply; the daily cap is checked first.
  assert.equal(err.code, 'daily_limit');
});

test('cooldown blocks a proposal even when the daily cap allows it', () => {
  const original = config.policy.maxOrdersPerDay;
  config.policy.maxOrdersPerDay = 5;
  try {
    const err = policyError(() => assertProposalAllowed(state({ history: [placed(5 * 60_000)] }), Date.now()));
    assert.equal(err.code, 'cooldown');
  } finally {
    config.policy.maxOrdersPerDay = original;
  }
});

test('an unresolved in-flight placement blocks everything', () => {
  const s = state({ pending: pendingOrder({ placementStartedAt: Date.now() - 1000 }) });
  assert.throws(() => assertNoCrashedPlacement(s), /never completed/);
  assert.throws(() => assertProposalAllowed(s, Date.now()), PolicyError);
});

// ── amount and item gates ────────────────────────────────────────────────────

test('total gate rejects over-max, zero, negative, and non-integer values', () => {
  assert.doesNotThrow(() => assertTotalAllowed(7500));
  assert.throws(() => assertTotalAllowed(7501), /exceeds the hard maximum/);
  assert.throws(() => assertTotalAllowed(0), /not a plausible order/);
  assert.throws(() => assertTotalAllowed(-100), /not a plausible order/);
  assert.throws(() => assertTotalAllowed(34.23), /not an integer cent/); // dollars mistaken for cents
});

test('item gate enforces count and quantity sanity', () => {
  assert.doesNotThrow(() => assertItemsAllowed([ITEM]));
  assert.throws(() => assertItemsAllowed([]), /no items/);
  assert.throws(() => assertItemsAllowed([{ ...ITEM, qty: 7 }]), /over the limit/);
  assert.throws(() => assertItemsAllowed([{ ...ITEM, qty: 0 }]), /positive integer/);
  assert.throws(() => assertItemsAllowed([{ ...ITEM, qty: 1.5 }]), /positive integer/);
});

test('store allowlist is enforced when set', () => {
  assert.doesNotThrow(() => assertStoreAllowed('9999'), 'null allowlist permits any store');
  config.policy.allowedStoreIds = ['8278'];
  try {
    assert.doesNotThrow(() => assertStoreAllowed('8278'));
    assert.doesNotThrow(() => assertStoreAllowed(8278 as unknown as string), 'numeric store ids must still match');
    assert.throws(() => assertStoreAllowed('9999'), /not in ALLOWED_STORE_IDS/);
  } finally {
    config.policy.allowedStoreIds = null;
  }
});

// ── the final gate ───────────────────────────────────────────────────────────

function placementArgs(over: Record<string, unknown> = {}) {
  const pending = pendingOrder();
  return {
    state: state({ pending }),
    pending,
    token: 'TESTTOKEN',
    freshTotalCents: pending.totalCents,
    freshFingerprint: pending.fingerprint,
    now: Date.now(),
    ...over
  } as Parameters<typeof assertPlacementAllowed>[0];
}

test('placement succeeds when the fresh quote matches exactly', () => {
  assert.doesNotThrow(() => assertPlacementAllowed(placementArgs()));
});

test('an expired quote cannot be redeemed', () => {
  const pending = pendingOrder({ expiresAt: Date.now() - 1 });
  const err = policyError(() => assertPlacementAllowed(placementArgs({ pending, state: state({ pending }) })));
  assert.equal(err.code, 'expired');
});

test('a wrong token cannot be redeemed', () => {
  const err = policyError(() => assertPlacementAllowed(placementArgs({ token: 'WRONGONE' })));
  assert.equal(err.code, 'bad_token');
});

test('a price increase between quote and charge is refused', () => {
  const err = policyError(() => assertPlacementAllowed(placementArgs({ freshTotalCents: 3424, freshFingerprint: 'different' })));
  assert.equal(err.code, 'order_changed');
});

test('a price change that somehow keeps the fingerprint is still refused', () => {
  // Defence in depth: the fingerprint covers the total, so this should be
  // unreachable — but the explicit total comparison must not rely on that.
  const err = policyError(() => assertPlacementAllowed(placementArgs({ freshTotalCents: 9999 })));
  assert.equal(err.code, 'price_changed');
});

test('a quote for more than the max cannot be redeemed even if it was minted', () => {
  const items = [ITEM];
  const totalCents = 999_00;
  const pending = pendingOrder({
    totalCents,
    fingerprint: fingerprint({ storeId: '8278', serviceMethod: 'Delivery', items, totalCents })
  });
  const err = policyError(() =>
      assertPlacementAllowed(
        placementArgs({
          pending,
          state: state({ pending }),
          freshTotalCents: totalCents,
          freshFingerprint: pending.fingerprint
        })
      ));
  assert.equal(err.code, 'over_max_total');
});

test('limits are re-checked at charge time, not just at quote time', () => {
  // A token minted while under the cap must not stay redeemable after another
  // order lands. This is the replay window that a naive TTL check would miss.
  const pending = pendingOrder();
  const err = policyError(() =>
      assertPlacementAllowed(
        placementArgs({ pending, state: state({ pending, history: [placed(60_000)] }) })
      ));
  assert.equal(err.code, 'daily_limit');
});
