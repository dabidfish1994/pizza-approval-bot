import type { MenuIndex, MenuVariant } from './dominos.js';

/**
 * Turns "large pepperoni pizza" into an orderable Domino's item.
 *
 * This is subtler than a name search, because Domino's does not name products
 * the way people order them:
 *
 *  - A plain cheese pizza is called "Large (14\") Hand Tossed Pizza" (14SCREEN,
 *    $18.99). The word "cheese" never appears in it — sauce and cheese are its
 *    default toppings. A naive name search for "cheese pizza" instead finds
 *    "Wisconsin 6-Cheese Pizza" ($25.49), a specialty pie, and quietly
 *    overcharges by $6.50.
 *  - There is no plain pepperoni variant at all. Pepperoni is a topping applied
 *    to a base pizza; searching for it finds "Ultimate Pepperoni" ($25.49)
 *    rather than a $18.99 base plus one topping.
 *
 * So: base pizzas (productCode S_PIZZA) plus explicit toppings by default, and
 * a specialty pie only when the request actually names one.
 */

export const BASE_PIZZA_PRODUCT = 'S_PIZZA';

const SIZES: Array<{ size: string; words: string[] }> = [
  { size: '10', words: ['small', '10"', '10 inch'] },
  { size: '12', words: ['medium', 'med', '12"', '12 inch'] },
  { size: '14', words: ['large', 'lg', '14"', '14 inch'] },
  { size: '16', words: ['extra large', 'x-large', 'xlarge', 'xl', '16"', '16 inch'] }
];

const CRUSTS: Array<{ key: string; words: string[] }> = [
  { key: 'gluten free', words: ['gluten free', 'gluten-free', 'gf'] },
  { key: 'parmesan stuffed crust', words: ['stuffed crust', 'stuffed'] },
  { key: 'handmade pan', words: ['pan', 'handmade pan', 'deep dish'] },
  { key: 'new york style', words: ['new york', 'ny', 'brooklyn'] },
  { key: 'thin', words: ['thin', 'thin crust', 'crispy'] },
  { key: 'hand tossed', words: ['hand tossed', 'hand-tossed', 'classic', 'regular'] }
];

/** Extra ways people name toppings, beyond the literal menu name. */
const TOPPING_ALIASES: Record<string, string[]> = {
  P: ['pepperoni', 'pepperonis', 'pep'],
  S: ['sausage', 'italian sausage'],
  K: ['bacon'],
  H: ['ham'],
  B: ['beef', 'ground beef', 'hamburger'],
  Du: ['chicken', 'grilled chicken'],
  Pm: ['philly steak', 'steak'],
  M: ['mushroom', 'mushrooms'],
  O: ['onion', 'onions'],
  G: ['green pepper', 'green peppers', 'bell pepper', 'bell peppers'],
  R: ['black olive', 'black olives', 'olive', 'olives'],
  N: ['pineapple'],
  J: ['jalapeno', 'jalapenos', 'jalapeño', 'jalapeños'],
  Z: ['banana pepper', 'banana peppers'],
  Td: ['tomato', 'tomatoes', 'diced tomatoes'],
  Si: ['spinach'],
  Fe: ['feta'],
  E: ['cheddar'],
  Cp: ['provolone'],
  Cs: ['parmesan asiago', 'asiago'],
  F: ['garlic']
};

/** Words that never distinguish one pizza from another. */
const GENERIC = new Set([
  'pizza', 'pizzas', 'pie', 'crust', 'style', 'inch', 'a', 'an', 'the', 'with', 'and', 'plain', 'topping', 'toppings',
  ...SIZES.flatMap(s => s.words.flatMap(w => w.split(' '))),
  ...CRUSTS.flatMap(c => c.words.flatMap(w => w.split(' ')))
]);

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9"]+/g, ' ')
    .trim();
}

export type Resolution = {
  code: string;
  /** What the human will see in the quote. */
  name: string;
  qty: number;
  options?: Record<string, Record<string, string>>;
  toppings: string[];
  priceCents: number;
  alternatives: Array<{ code: string; name: string; priceCents: number }>;
  /** Why this resolved the way it did, surfaced in --json for the agent to relay. */
  reason: string;
};

export function detectSize(norm: string): string | null {
  // Longest phrases first so "extra large" beats "large".
  const candidates = SIZES.flatMap(s => s.words.map(w => ({ size: s.size, w })));
  candidates.sort((a, b) => b.w.length - a.w.length);
  for (const c of candidates) if (containsPhrase(norm, c.w)) return c.size;
  return null;
}

export function detectCrust(norm: string): string | null {
  const candidates = CRUSTS.flatMap(c => c.words.map(w => ({ key: c.key, w })));
  candidates.sort((a, b) => b.w.length - a.w.length);
  for (const c of candidates) if (containsPhrase(norm, c.w)) return c.key;
  return null;
}

function containsPhrase(haystack: string, phrase: string): boolean {
  const p = normalize(phrase);
  if (!p) return false;
  return new RegExp(`(^| )${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(haystack);
}

export type DetectedTopping = { code: string; name: string; qty: string };

export function detectToppings(menu: MenuIndex, norm: string): DetectedTopping[] {
  const found: DetectedTopping[] = [];
  const seen = new Set<string>();
  const wantsExtraCheese = containsPhrase(norm, 'extra cheese') || containsPhrase(norm, 'double cheese');

  for (const topping of menu.toppings) {
    if (seen.has(topping.code)) continue;
    const keys = [topping.name, ...(TOPPING_ALIASES[topping.code] ?? [])];
    // Skip sauces and cheese here; they are defaults, handled separately.
    if (topping.code === 'X' || topping.code === 'C') continue;
    if (keys.some(k => containsPhrase(norm, k))) {
      seen.add(topping.code);
      found.push({ code: topping.code, name: topping.name, qty: '1' });
    }
  }

  if (wantsExtraCheese) found.push({ code: 'C', name: 'Extra Cheese', qty: '1.5' });
  return found;
}

/**
 * A specialty pizza is chosen only when the request literally contains its
 * name, with the size and crust prefix stripped — "philly cheese steak",
 * "extravaganzza", "wisconsin 6 cheese".
 *
 * An earlier version instead looked for "distinctive" words, excluding any word
 * that was also a topping name. That silently made Philly Cheese Steak
 * unreachable, because both "philly" and "steak" are toppings. Matching the
 * whole phrase is simpler and behaves predictably: "pepperoni pizza" never
 * pulls in "Ultimate Pepperoni", but "ultimate pepperoni" does.
 */
export function specialtyPhrase(name: string): string {
  let n = name;
  n = n.replace(/^\s*(x-large|extra large|small|medium|large)?\s*\(\d+"\)\s*/i, '');
  for (const crust of ['gluten free crust', 'parmesan stuffed crust', 'handmade pan', 'new york style', 'hand tossed', 'thin crust', 'thin', 'brooklyn', 'pan']) {
    const re = new RegExp(`^${crust}\\s+`, 'i');
    if (re.test(n)) {
      n = n.replace(re, '');
      break;
    }
  }
  return normalize(n.replace(/\bpizza\b/i, '').trim());
}

export function findSpecialty(menu: MenuIndex, norm: string): MenuVariant | null {
  const wantedSize = detectSize(norm);
  const matches: Array<{ variant: MenuVariant; phraseLength: number }> = [];

  for (const variant of menu.variants) {
    if (variant.productCode === BASE_PIZZA_PRODUCT) continue;
    if (!isPizzaVariant(variant)) continue;

    const phrase = specialtyPhrase(variant.name);
    if (!phrase) continue;
    if (!containsPhrase(norm, phrase)) continue;
    matches.push({ variant, phraseLength: phrase.length });
  }

  if (matches.length === 0) return null;

  // Honour the requested size when a variant of that size matched.
  const sized = wantedSize
    ? matches.filter(m => String(m.variant.sizeCode) === wantedSize || m.variant.name.includes(`(${wantedSize}")`))
    : [];
  const pool = sized.length ? sized : matches;

  // Longest matching phrase is the most specific; break ties on price.
  pool.sort((a, b) => b.phraseLength - a.phraseLength || a.variant.priceCents - b.variant.priceCents);
  return pool[0].variant;
}

function isPizzaVariant(v: MenuVariant): boolean {
  return /\(\d+"\)/.test(v.name);
}

/** Does this request look like a pizza at all? */
export function looksLikePizza(menu: MenuIndex, norm: string): boolean {
  if (containsPhrase(norm, 'pizza') || containsPhrase(norm, 'pie')) return true;
  const size = detectSize(norm);
  if (!size) return false;
  // "large coke" has a size word but is not a pizza; require a crust or topping.
  return detectCrust(norm) !== null || detectToppings(menu, norm).length > 0;
}

function findBase(menu: MenuIndex, size: string, crust: string): MenuVariant | null {
  const bases = menu.variants.filter(v => v.productCode === BASE_PIZZA_PRODUCT);
  const bySize = bases.filter(v => String(v.sizeCode) === size || v.name.includes(`(${size}")`));
  const pool = bySize.length ? bySize : bases;

  const exact = pool.find(v => normalize(v.name).includes(normalize(crust)));
  if (exact) return exact;
  // Crust unavailable in this size — fall back to the cheapest base of that size.
  return pool.sort((a, b) => a.priceCents - b.priceCents)[0] ?? null;
}

/** Plain name search, for everything that is not a pizza. */
export function searchVariants(menu: MenuIndex, query: string, limit = 5): Array<MenuVariant & { score: number }> {
  const q = normalize(query);
  const tokens = [...new Set(q.split(' ').filter(Boolean))];
  if (tokens.length === 0) return [];

  return menu.variants
    .map(v => {
      const name = normalize(v.name);
      let score = 0;
      // "large coke" must find the drink, not a Large pizza: size and crust
      // words carry almost no identifying information on their own.
      for (const t of tokens) if (name.includes(t)) score += GENERIC.has(t) ? 1 : Math.max(2, t.length);
      if (name === q) score += 50;
      else if (name.includes(q)) score += 10;
      score -= Math.abs(name.split(' ').length - tokens.length) * 0.25;
      return { ...v, score };
    })
    .filter(v => v.score > 0)
    .sort((a, b) => b.score - a.score || a.priceCents - b.priceCents)
    .slice(0, limit);
}

export function resolveItem(menu: MenuIndex, query: string, qty = 1): Resolution | null {
  const norm = normalize(query);
  if (!norm) return null;

  if (looksLikePizza(menu, norm)) {
    const specialty = findSpecialty(menu, norm);
    if (specialty) {
      return {
        code: specialty.code,
        name: specialty.name,
        qty,
        toppings: [],
        priceCents: specialty.priceCents,
        alternatives: searchVariants(menu, query, 4).filter(v => v.code !== specialty.code).map(strip),
        reason: 'matched a specialty pizza by name'
      };
    }

    const size = detectSize(norm) ?? '14';
    const crust = detectCrust(norm) ?? 'hand tossed';
    const base = findBase(menu, size, crust);
    if (!base) return null;

    const toppings = detectToppings(menu, norm);
    const options: Record<string, Record<string, string>> = {};
    if (toppings.length > 0) {
      // Passing options replaces the defaults, so sauce and cheese must be
      // restated or the pizza arrives bare.
      options.X = { '1/1': '1' };
      options.C = { '1/1': '1' };
      for (const t of toppings) options[t.code] = { '1/1': t.qty };
    }

    const toppingNames = toppings.map(t => t.name);
    return {
      code: base.code,
      name: toppingNames.length ? `${base.name} with ${toppingNames.join(', ')}` : base.name,
      qty,
      options: toppings.length ? options : undefined,
      toppings: toppingNames,
      priceCents: base.priceCents,
      alternatives: [],
      reason: toppingNames.length
        ? `base pizza plus ${toppingNames.length} topping(s) — cheaper than the equivalent specialty pie`
        : 'base pizza (sauce and cheese are its defaults)'
    };
  }

  const matches = searchVariants(menu, query, 5);
  if (matches.length === 0) return null;
  return {
    code: matches[0].code,
    name: matches[0].name,
    qty,
    toppings: [],
    priceCents: matches[0].priceCents,
    alternatives: matches.slice(1).map(strip),
    reason: 'matched a menu item by name'
  };
}

function strip(v: MenuVariant): { code: string; name: string; priceCents: number } {
  return { code: v.code, name: v.name, priceCents: v.priceCents };
}
