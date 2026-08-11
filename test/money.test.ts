import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCents, fmt, dollarsToCents, percentOf } from '../src/money.ts';

/**
 * Domino's returns "25.49" for one field and 34.23 for another in the same
 * object. Every one of these cases is a real shape the API can produce, and a
 * silent mis-parse here would defeat the max-total gate.
 */
test('toCents parses the mixed types Domino\'s actually returns', () => {
  assert.equal(toCents('25.49'), 2549);
  assert.equal(toCents(34.23), 3423);
  assert.equal(toCents('0.00'), 0);
  assert.equal(toCents(0), 0);
  assert.equal(toCents('5'), 500);
  assert.equal(toCents(5), 500);
});

test('toCents rounds cleanly rather than drifting on float error', () => {
  assert.equal(toCents(0.1 + 0.2), 30); // 0.30000000000000004
  assert.equal(toCents(19.995), 2000);
  assert.equal(toCents('1.005'), 101);
});

test('toCents rejects anything ambiguous instead of coercing to a number', () => {
  // Number('') === 0 and Number(null) === 0 — either would silently zero a total.
  for (const bad of ['', '  ', null, undefined, {}, [], NaN, Infinity, '$25.49', '1,000.00', 'abc', '25.49 USD']) {
    assert.throws(() => toCents(bad as unknown), /amount/, `should reject ${JSON.stringify(bad)}`);
  }
});

test('toCents handles negatives (refunds/adjustments) without mangling them', () => {
  assert.equal(toCents('-5.00'), -500);
  assert.equal(toCents(-5), -500);
});

test('fmt renders cents as currency', () => {
  assert.equal(fmt(3423), '$34.23');
  assert.equal(fmt(0), '$0.00');
  assert.equal(fmt(5), '$0.05');
  assert.equal(fmt(100), '$1.00');
  assert.equal(fmt(-250), '-$2.50');
});

test('percentOf computes tips on cent amounts', () => {
  assert.equal(percentOf(2549, 20), 510);
  assert.equal(percentOf(2549, 0), 0);
  assert.equal(percentOf(1000, 15), 150);
  assert.throws(() => percentOf(1000, -5), /invalid percent/);
});

test('dollarsToCents converts env-provided limits', () => {
  assert.equal(dollarsToCents(75), 7500);
  assert.equal(dollarsToCents(0.5), 50);
  assert.throws(() => dollarsToCents(NaN), /finite/);
});
