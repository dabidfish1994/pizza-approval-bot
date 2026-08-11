import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { registerSecret } from './log.js';

const execFileAsync = promisify(execFile);

async function opRead(ref: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('op', ['read', ref], { maxBuffer: 1024 * 1024 });
    const value = stdout.trim();
    if (!value) throw new Error(`1Password returned an empty value for ${ref}`);
    return value;
  } catch (e: any) {
    // Never surface `op`'s stderr verbatim — it can echo the item contents.
    if (e?.code === 'ENOENT') throw new Error('1Password CLI (`op`) not found on PATH.');
    throw new Error(`Failed to read ${ref} from 1Password. Is \`op\` signed in? (try: op signin)`);
  }
}

export type DeliveryAddress = {
  address1: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
};

export async function getDeliveryAddress(): Promise<DeliveryAddress> {
  const [address1, city, state, zip, phone] = await Promise.all([
    opRead(config.refs.address1),
    opRead(config.refs.city),
    opRead(config.refs.state),
    opRead(config.refs.zip),
    opRead(config.refs.phone)
  ]);
  return { address1, city, state, zip, phone };
}

export type PaymentCard = {
  number: string;
  /** MMYY, the format the Domino's API expects. */
  expiration: string;
  securityCode: string;
  postalCode: string;
  cardholder: string;
};

/**
 * Reads card data. Deliberately called only after the policy engine has cleared
 * placement, so a proposal or a rejected order never pulls the PAN into memory
 * at all. Every value is registered with the redactor before it is returned.
 */
export async function getPaymentCard(): Promise<PaymentCard> {
  const [number, expMonth, expYear, cvv, cardholder, billingZip] = await Promise.all([
    opRead(config.refs.cardNumber),
    opRead(config.refs.expMonth),
    opRead(config.refs.expYear),
    opRead(config.refs.cvv),
    opRead(config.refs.cardName),
    opRead(config.refs.billingZip)
  ]);

  const digits = number.replace(/[^\d]/g, '');
  registerSecret(digits);
  registerSecret(number);
  registerSecret(cvv);

  if (!luhn(digits)) {
    throw new Error('Card number from 1Password failed checksum validation — check OP_CARD_NUMBER_REF points at the card number field.');
  }
  if (!/^\d{3,4}$/.test(cvv)) {
    throw new Error('CVV from 1Password is not 3-4 digits — check OP_CARD_CVV_REF.');
  }

  return {
    number: digits,
    expiration: normalizeExpiration(expMonth, expYear),
    securityCode: cvv,
    postalCode: billingZip.replace(/[^\d]/g, '').slice(0, 5),
    cardholder
  };
}

/**
 * 1Password stores month and year separately and inconsistently ("3" or "03",
 * "2030" or "30"). Domino's wants exactly MMYY. Also refuses an already-expired
 * card rather than letting the order fail at the store.
 */
export function normalizeExpiration(rawMonth: string, rawYear: string, now = new Date()): string {
  const monthNum = Number(rawMonth.replace(/[^\d]/g, ''));
  if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) {
    throw new Error(`Card expiration month is not 1-12 (got ${JSON.stringify(rawMonth)}) — check OP_CARD_EXP_MONTH_REF.`);
  }

  const yearDigits = rawYear.replace(/[^\d]/g, '');
  if (yearDigits.length !== 2 && yearDigits.length !== 4) {
    throw new Error(`Card expiration year must be 2 or 4 digits (got ${JSON.stringify(rawYear)}) — check OP_CARD_EXP_YEAR_REF.`);
  }
  const fullYear = yearDigits.length === 4 ? Number(yearDigits) : 2000 + Number(yearDigits);

  // A card is valid through the last day of its expiration month.
  const expiresAfter = new Date(fullYear, monthNum, 1);
  if (expiresAfter <= now) {
    throw new Error(`Card expired ${String(monthNum).padStart(2, '0')}/${fullYear}. Update it in 1Password.`);
  }

  return `${String(monthNum).padStart(2, '0')}${String(fullYear % 100).padStart(2, '0')}`;
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
