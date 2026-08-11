import './env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { normalizeExpiration } = await import('../src/onepassword.ts');
const { redact, registerSecret, clearSecrets } = await import('../src/log.ts');

const NOW = new Date('2026-08-10T00:00:00Z');

test('expiration normalizes the shapes 1Password actually stores', () => {
  // Month with and without a leading zero, year as 2 or 4 digits.
  assert.equal(normalizeExpiration('03', '2030', NOW), '0330');
  assert.equal(normalizeExpiration('3', '2030', NOW), '0330');
  assert.equal(normalizeExpiration('3', '30', NOW), '0330');
  assert.equal(normalizeExpiration('12', '2027', NOW), '1227');
  assert.equal(normalizeExpiration(' 07 ', ' 2029 ', NOW), '0729');
});

test('a card valid through the current month is still accepted', () => {
  // Cards are valid through the LAST day of their expiration month.
  assert.equal(normalizeExpiration('08', '2026', NOW), '0826');
});

test('an expired card is refused rather than sent to the store', () => {
  assert.throws(() => normalizeExpiration('07', '2026', NOW), /expired/);
  assert.throws(() => normalizeExpiration('01', '2020', NOW), /expired/);
});

test('a nonsense expiration is refused with a pointer to the right env var', () => {
  assert.throws(() => normalizeExpiration('13', '2030', NOW), /OP_CARD_EXP_MONTH_REF/);
  assert.throws(() => normalizeExpiration('0', '2030', NOW), /OP_CARD_EXP_MONTH_REF/);
  assert.throws(() => normalizeExpiration('abc', '2030', NOW), /OP_CARD_EXP_MONTH_REF/);
  assert.throws(() => normalizeExpiration('06', '203', NOW), /OP_CARD_EXP_YEAR_REF/);
});

test('registered secrets are scrubbed from any output', () => {
  clearSecrets();
  registerSecret('123-secret-value');
  assert.equal(redact('token is 123-secret-value here'), 'token is [REDACTED] here');
  clearSecrets();
  assert.equal(redact('token is 123-secret-value here'), 'token is 123-secret-value here');
});

test('card numbers are scrubbed even when never registered', () => {
  clearSecrets();
  // A dependency could reformat or echo a PAN we never handed to the redactor.
  assert.match(redact('charging 4111111111111111 now'), /\[REDACTED-PAN\]/);
  assert.match(redact('charging 4111-1111-1111-1111 now'), /\[REDACTED-PAN\]/);
  assert.match(redact('charging 4111 1111 1111 1111 now'), /\[REDACTED-PAN\]/);
});

test('redaction does not mangle ordinary numbers', () => {
  clearSecrets();
  // Store IDs, totals, phone numbers and order IDs must survive intact —
  // an over-eager redactor makes the audit log useless.
  assert.equal(redact('store 8278 total $34.23'), 'store 8278 total $34.23');
  assert.equal(redact('order 1234567890'), 'order 1234567890');
  assert.equal(redact('phone 941-555-2368'), 'phone 941-555-2368');
});

test('secret-bearing JSON keys are scrubbed whatever the value', () => {
  clearSecrets();
  const payload = JSON.stringify({ securityCode: '867', number: '4111111111111111', amount: 34.23 });
  const out = redact(payload);
  assert.ok(!out.includes('867'), 'CVV must not survive');
  assert.ok(!out.includes('4111111111111111'), 'PAN must not survive');
  assert.ok(out.includes('34.23'), 'the amount is not a secret and stays readable');
});

test('errors are redacted, including their stack', () => {
  clearSecrets();
  registerSecret('hunter2');
  const out = redact(new Error('failed with hunter2'));
  assert.ok(!out.includes('hunter2'));
});
