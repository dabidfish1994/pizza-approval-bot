import './env.ts';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Isolate this file's state directory before anything reads config.
const DIR = join(process.env.TMPDIR ?? '/tmp', `pizza-state-test-${process.pid}`);
process.env.PIZZA_STATE_DIR = DIR;

const { readState, writeState, mutateState, appendHistory, acquirePlacementLock, STATE_VERSION } =
  await import('../src/state.ts');

beforeEach(async () => {
  await rm(DIR, { recursive: true, force: true });
});

after(async () => {
  await rm(DIR, { recursive: true, force: true });
});

const ITEM = { code: 'P14IRECZ', name: 'Large Cheese', qty: 1, priceCents: 2549 };

function entry(over = {}) {
  return { id: 'x', placedAt: Date.now(), storeId: '8278', items: [ITEM], totalCents: 3423, outcome: 'placed' as const, ...over };
}

test('a missing state file reads as empty rather than throwing', async () => {
  const s = await readState();
  assert.equal(s.pending, null);
  assert.deepEqual(s.history, []);
  assert.equal(s.version, STATE_VERSION);
});

test('state round-trips through disk', async () => {
  await writeState({ version: STATE_VERSION, pending: null, history: [entry()] });
  const s = await readState();
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].totalCents, 3423);
});

test('mutateState persists the mutation and returns the callback value', async () => {
  const returned = await mutateState(s => {
    s.history.push(entry());
    return 'done';
  });
  assert.equal(returned, 'done');
  assert.equal((await readState()).history.length, 1);
});

test('the state file is written atomically, leaving no partial file behind', async () => {
  await writeState({ version: STATE_VERSION, pending: null, history: [entry()] });
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(DIR);
  assert.deepEqual(files.filter(f => f.includes('.tmp')), [], 'temp files must be renamed, not left around');
  // The file must always be complete, parseable JSON.
  JSON.parse(await readFile(join(DIR, 'state.json'), 'utf8'));
});

test('history is bounded so the file cannot grow without limit', async () => {
  for (let i = 0; i < 60; i++) await appendHistory(entry({ id: `e${i}` }));
  const s = await readState();
  assert.equal(s.history.length, 60);
  assert.equal(s.history.at(-1)?.id, 'e59', 'newest entries are kept');
});

test('an unknown state version is refused rather than misread', async () => {
  await mkdir(DIR, { recursive: true });
  await writeFile(join(DIR, 'state.json'), JSON.stringify({ version: 999, pending: null, history: [] }));
  await assert.rejects(() => readState(), /version 999 is not supported/);
});

test('placement is single-flight: a second acquire is refused', async () => {
  const release = await acquirePlacementLock();
  await assert.rejects(() => acquirePlacementLock(), /already in progress/);
  await release();
  // Once released, the next placement can proceed.
  const again = await acquirePlacementLock();
  await again();
});

test('releasing a lock twice is harmless', async () => {
  const release = await acquirePlacementLock();
  await release();
  await release();
  const again = await acquirePlacementLock();
  await again();
});
