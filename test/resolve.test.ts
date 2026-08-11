import './env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resolveItem, detectSize, detectCrust, detectToppings, findSpecialty, looksLikePizza, searchVariants } =
  await import('../src/resolve.ts');

/**
 * Fixture captured verbatim from a live Domino's store menu (store 8278),
 * codes, names and prices included. An earlier version of this suite used
 * invented names like "Large (14\") Hand Tossed Cheese Pizza" — it passed while
 * the real behaviour was wrong, because no such product exists. Everything here
 * is real.
 */
const MENU = {
  storeId: '8278',
  variants: [
    // Base pizzas — note that none of them say "cheese".
    { code: '10SCREEN', name: 'Small (10") Hand Tossed Pizza', priceCents: 1399, productCode: 'S_PIZZA', sizeCode: '10' },
    { code: '12SCREEN', name: 'Medium (12") Hand Tossed Pizza', priceCents: 1699, productCode: 'S_PIZZA', sizeCode: '12' },
    { code: '14SCREEN', name: 'Large (14") Hand Tossed Pizza', priceCents: 1899, productCode: 'S_PIZZA', sizeCode: '14' },
    { code: '12THIN', name: 'Medium (12") Thin Pizza', priceCents: 1699, productCode: 'S_PIZZA', sizeCode: '12' },
    { code: '14THIN', name: 'Large (14") Thin Pizza', priceCents: 1899, productCode: 'S_PIZZA', sizeCode: '14' },
    { code: 'PBKIREZA', name: 'Large (14") New York Style Pizza', priceCents: 1899, productCode: 'S_PIZZA', sizeCode: '14' },
    { code: 'P12IPAZA', name: 'Medium (12") Handmade Pan Pizza', priceCents: 1699, productCode: 'S_PIZZA', sizeCode: '12' },
    { code: 'P10IGFZA', name: 'Small (10") Gluten Free Crust Pizza', priceCents: 1399, productCode: 'S_PIZZA', sizeCode: '10' },
    { code: 'P12PSCZA', name: 'Medium (12") Parmesan Stuffed Crust Pizza', priceCents: 1699, productCode: 'S_PIZZA', sizeCode: '12' },
    // Specialty pizzas.
    { code: 'P14IRECZ', name: 'Large (14") Hand Tossed Wisconsin 6-Cheese Pizza', priceCents: 2549, productCode: 'S_PIZCZ', sizeCode: '14' },
    { code: 'P14IREPH', name: 'Large (14") Hand Tossed Philly Cheese Steak', priceCents: 2549, productCode: 'S_PIZPH', sizeCode: '14' },
    { code: '14SCPFEAST', name: 'Large (14") Hand Tossed Ultimate Pepperoni', priceCents: 2549, productCode: 'S_PIZPX', sizeCode: '14' },
    { code: '14SCEXTRAV', name: 'Large (14") Hand Tossed ExtravaganZZa', priceCents: 2549, productCode: 'S_PIZZZ', sizeCode: '14' },
    { code: 'P14IREUH', name: 'Large (14") Hand Tossed Honolulu Hawaiian', priceCents: 2549, productCode: 'S_PIZUH', sizeCode: '14' },
    { code: 'P14IRESPF', name: 'Large (14") Hand Tossed Spinach & Feta', priceCents: 2549, productCode: 'S_PIZSF', sizeCode: '14' },
    // Not pizza.
    { code: 'B16PBIT', name: '16-Piece Parmesan Bread Bites', priceCents: 799, productCode: 'F_PBITES', sizeCode: 'BRD16' },
    { code: '20BCOKE', name: '20oz Bottle Coke', priceCents: 229, productCode: 'F_DRINK', sizeCode: '20OZ' },
    { code: 'MARINARA', name: 'Marinara Dipping Cup', priceCents: 99, productCode: 'F_SIDE', sizeCode: '' }
  ],
  toppings: [
    { code: 'X', name: 'Robust Inspired Tomato Sauce' },
    { code: 'C', name: 'Cheese' },
    { code: 'P', name: 'Pepperoni' },
    { code: 'S', name: 'Italian Sausage' },
    { code: 'K', name: 'Bacon' },
    { code: 'H', name: 'Ham' },
    { code: 'B', name: 'Beef' },
    { code: 'Du', name: 'Premium Chicken' },
    { code: 'Pm', name: 'Philly Steak' },
    { code: 'M', name: 'Mushrooms' },
    { code: 'O', name: 'Onions' },
    { code: 'G', name: 'Green Peppers' },
    { code: 'R', name: 'Black Olives' },
    { code: 'N', name: 'Pineapple' },
    { code: 'J', name: 'Jalapeno Peppers' },
    { code: 'Si', name: 'Spinach' },
    { code: 'Fe', name: 'Feta Cheese' },
    { code: 'F', name: 'Garlic' }
  ]
};

// ── the two bugs this module exists to prevent ───────────────────────────────

test('"large cheese pizza" resolves to the $18.99 base, not the $25.49 specialty', () => {
  const r = resolveItem(MENU, 'large cheese pizza');
  assert.equal(r?.code, '14SCREEN');
  assert.equal(r?.priceCents, 1899);
  assert.equal(r?.options, undefined, 'a plain pizza should use the store defaults (sauce + cheese)');
});

test('"large pepperoni pizza" is a base pizza plus a topping, not Ultimate Pepperoni', () => {
  const r = resolveItem(MENU, 'large pepperoni pizza');
  assert.equal(r?.code, '14SCREEN', 'must not resolve to 14SCPFEAST at $25.49');
  assert.deepEqual(r?.toppings, ['Pepperoni']);
  // Passing options replaces defaults, so sauce and cheese must be restated.
  assert.deepEqual(r?.options, {
    X: { '1/1': '1' },
    C: { '1/1': '1' },
    P: { '1/1': '1' }
  });
});

// ── specialty pizzas, when actually asked for ────────────────────────────────

test('a specialty pizza is chosen when the request names one', () => {
  assert.equal(resolveItem(MENU, 'large extravaganzza pizza')?.code, '14SCEXTRAV');
  assert.equal(resolveItem(MENU, 'philly cheese steak pizza')?.code, 'P14IREPH');
  assert.equal(resolveItem(MENU, 'wisconsin 6 cheese pizza')?.code, 'P14IRECZ');
  assert.equal(resolveItem(MENU, 'honolulu hawaiian pizza')?.code, 'P14IREUH');
});

test('a specialty whose name is only topping words never wins over base + toppings', () => {
  // "Spinach & Feta" has no distinguishing word, and base + 2 toppings is cheaper.
  const r = resolveItem(MENU, 'large spinach and feta pizza');
  assert.equal(r?.code, '14SCREEN');
  assert.deepEqual(r?.toppings.sort(), ['Feta Cheese', 'Spinach']);
});

test('findSpecialty ignores topping words entirely', () => {
  assert.equal(findSpecialty(MENU, 'large pepperoni pizza'), null);
  assert.equal(findSpecialty(MENU, 'large cheese pizza'), null);
  assert.equal(findSpecialty(MENU, 'large extravaganzza pizza')?.code, '14SCEXTRAV');
});

// ── sizes and crusts ─────────────────────────────────────────────────────────

test('size words map to Domino\'s sizes', () => {
  assert.equal(detectSize('small cheese pizza'), '10');
  assert.equal(detectSize('medium pizza'), '12');
  assert.equal(detectSize('large pizza'), '14');
  assert.equal(detectSize('extra large pizza'), '16', 'longest phrase wins over "large"');
  assert.equal(detectSize('14" pizza'), '14');
  assert.equal(detectSize('a pizza'), null);
});

test('crust styles are detected, longest phrase first', () => {
  assert.equal(detectCrust('thin crust pizza'), 'thin');
  assert.equal(detectCrust('hand tossed pizza'), 'hand tossed');
  assert.equal(detectCrust('pan pizza'), 'handmade pan');
  assert.equal(detectCrust('brooklyn pizza'), 'new york style');
  assert.equal(detectCrust('gluten free pizza'), 'gluten free');
  assert.equal(detectCrust('cheese pizza'), null);
});

test('size and crust select the right base variant', () => {
  assert.equal(resolveItem(MENU, 'medium thin pizza')?.code, '12THIN');
  assert.equal(resolveItem(MENU, 'small gluten free pizza')?.code, 'P10IGFZA');
  assert.equal(resolveItem(MENU, 'medium pan pizza')?.code, 'P12IPAZA');
  assert.equal(resolveItem(MENU, 'large brooklyn pizza')?.code, 'PBKIREZA');
});

test('an unspecified size defaults to large hand tossed', () => {
  const r = resolveItem(MENU, 'pepperoni pizza');
  assert.equal(r?.code, '14SCREEN');
});

test('a crust unavailable in the requested size falls back to the cheapest base of that size', () => {
  // There is no small thin crust in this fixture.
  const r = resolveItem(MENU, 'small thin pizza');

  assert.ok(['10SCREEN', 'P10IGFZA'].includes(r!.code), `fell back to ${r?.code}`);
});

// ── toppings ─────────────────────────────────────────────────────────────────

test('multiple toppings are all applied', () => {
  const r = resolveItem(MENU, 'large pizza with pepperoni, mushrooms and black olives');
  assert.equal(r?.code, '14SCREEN');
  assert.deepEqual(r!.toppings.sort(), ['Black Olives', 'Mushrooms', 'Pepperoni']);
  assert.deepEqual(Object.keys(r!.options!).sort(), ['C', 'M', 'P', 'R', 'X']);
});

test('topping aliases match how people actually speak', () => {
  assert.deepEqual(detectToppings(MENU, 'large sausage pizza').map(t => t.code), ['S']);
  assert.deepEqual(detectToppings(MENU, 'pizza with olives').map(t => t.code), ['R']);
  assert.deepEqual(detectToppings(MENU, 'pizza with mushroom').map(t => t.code), ['M']);
  assert.deepEqual(detectToppings(MENU, 'pizza with chicken').map(t => t.code), ['Du']);
});

test('extra cheese is a 1.5 portion, not a duplicate topping', () => {
  const r = resolveItem(MENU, 'large pizza with extra cheese');
  assert.equal(r?.options?.C?.['1/1'], '1.5');
});

test('plain sauce and cheese are never treated as requested toppings', () => {
  assert.deepEqual(detectToppings(MENU, 'large cheese pizza'), []);
  assert.deepEqual(detectToppings(MENU, 'plain pizza'), []);
});

// ── non-pizza items ──────────────────────────────────────────────────────────

test('a size word does not force a drink onto the pizza path', () => {
  assert.equal(looksLikePizza(MENU, 'large coke'), false);
  assert.equal(resolveItem(MENU, 'large coke')?.code, '20BCOKE');
});

test('sides resolve by name', () => {
  assert.equal(resolveItem(MENU, 'parmesan bread bites')?.code, 'B16PBIT');
  assert.equal(resolveItem(MENU, 'marinara dipping cup')?.code, 'MARINARA');
});

test('an unmatchable request returns null rather than a bad guess', () => {
  assert.equal(resolveItem(MENU, 'sushi platter'), null);
  assert.equal(resolveItem(MENU, ''), null);
  assert.equal(resolveItem(MENU, '   '), null);
});

test('quantity is carried through', () => {
  assert.equal(resolveItem(MENU, 'large cheese pizza', 3)?.qty, 3);
});

test('searchVariants ranks by score then by price', () => {
  const results = searchVariants(MENU, 'pizza', 5);
  assert.ok(results.length > 0);
  for (let i = 1; i < results.length; i++) {
    assert.ok(
      results[i - 1].score > results[i].score ||
        (results[i - 1].score === results[i].score && results[i - 1].priceCents <= results[i].priceCents)
    );
  }
});
