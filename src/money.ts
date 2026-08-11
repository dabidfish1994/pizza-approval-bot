/**
 * All money in this codebase is integer cents. Never floats, never strings.
 *
 * Domino's `amountsBreakdown` mixes types freely — `foodAndBeverage` comes back
 * as the string "25.49" while `customer` comes back as the number 34.23. A
 * comparison like `total > max` that accidentally compares a string to a number
 * is the single most dangerous bug this program could have, so parsing is
 * centralized here and is deliberately strict.
 */

/** Parse a Domino's money value (string or number) into integer cents. Throws on anything ambiguous. */
export function toCents(value: unknown, label = 'amount'): number {
  let text: string;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label}: not a finite number (${value})`);
    // Round-trip through a decimal string so parsing stays exact. Multiplying a
    // float by 100 does not: 1.005 * 100 is 100.49999999999999, which rounds
    // DOWN to $1.00 and quietly loses a cent.
    text = Math.abs(value) < 1e21 ? String(value) : value.toFixed(10);
    if (text.includes('e') || text.includes('E')) text = value.toFixed(10);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    throw new Error(`${label}: expected string or number, got ${value === null ? 'null' : typeof value}`);
  }

  // Reject anything that isn't a plain decimal number. No currency symbols, no
  // thousands separators, no empty string (which Number() would map to 0).
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(text);
  if (!m) throw new Error(`${label}: unparseable money string ${JSON.stringify(value)}`);

  const [, sign, whole, frac = ''] = m;
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  // Half-up on the third decimal, applied to the magnitude.
  const roundUp = frac.length > 2 && Number(frac[2]) >= 5;
  const magnitude = cents + (roundUp ? 1 : 0);

  if (!Number.isSafeInteger(magnitude)) throw new Error(`${label}: value out of range (${text})`);
  return sign === '-' ? -magnitude : magnitude;
}

/** Format integer cents as a dollar string for display. */
export function fmt(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Dollars (as given by a human or env var) to integer cents. */
export function dollarsToCents(dollars: number, label = 'dollars'): number {
  if (!Number.isFinite(dollars)) throw new Error(`${label}: not a finite number`);
  return Math.round(dollars * 100);
}

/** Percentage of a cent amount, rounded to the nearest cent. */
export function percentOf(cents: number, percent: number): number {
  if (!Number.isFinite(percent) || percent < 0) throw new Error(`invalid percent: ${percent}`);
  return Math.round((cents * percent) / 100);
}
