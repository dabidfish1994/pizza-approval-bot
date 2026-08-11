/**
 * Logging with mandatory redaction.
 *
 * Card data passes through this process for a few seconds during placement. The
 * rule is that it must never reach stdout, stderr, or the audit log — including
 * via an exception message from a dependency we do not control. Redaction is
 * applied at the sink rather than at each call site, so there is no way to
 * forget it.
 */

const secrets = new Set<string>();

/** Register a runtime secret (card number, CVV) so it is scrubbed from all output. */
export function registerSecret(value: string | undefined | null): void {
  if (!value) return;
  const v = String(value).trim();
  if (v.length >= 3) secrets.add(v);
}

/** Drop all registered secrets. Call once card data is out of scope. */
export function clearSecrets(): void {
  secrets.clear();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redact(input: unknown): string {
  let text = typeof input === 'string' ? input : safeStringify(input);

  // Exact registered secrets first.
  for (const s of secrets) {
    text = text.replace(new RegExp(escapeRegex(s), 'g'), '[REDACTED]');
  }

  // Belt and braces: any 13-19 digit run that passes Luhn is treated as a PAN,
  // even if it was never registered (e.g. reformatted by a dependency).
  text = text.replace(/\b(?:\d[ -]?){12,18}\d\b/g, m => (luhn(m.replace(/[^\d]/g, '')) ? '[REDACTED-PAN]' : m));

  // Common secret-bearing JSON keys, whatever the value.
  text = text.replace(
    /("(?:securityCode|cvv|cvc|number|cardNumber|expiration)"\s*:\s*)"[^"]*"/gi,
    '$1"[REDACTED]"'
  );

  return text;
}

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function safeStringify(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack ?? ''}`;
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

export function info(...parts: unknown[]): void {
  console.log(parts.map(redact).join(' '));
}

export function warn(...parts: unknown[]): void {
  console.warn(parts.map(redact).join(' '));
}

export function error(...parts: unknown[]): void {
  console.error(parts.map(redact).join(' '));
}
