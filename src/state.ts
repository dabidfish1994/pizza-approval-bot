import { mkdir, readFile, writeFile, rename, open, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

/**
 * Durable state: the single pending proposal, the order history that powers rate
 * limiting, and a lockfile that keeps two agent invocations from racing.
 *
 * Writes are atomic (temp file + rename) because a torn write to the history
 * file would corrupt the rate limiter, and a broken rate limiter is how you end
 * up with six pizzas.
 */

export const STATE_VERSION = 1;

export type PendingOrder = {
  id: string;
  createdAt: number;
  expiresAt: number;
  /** sha256 of the confirm token. The token itself is never stored. */
  tokenHash: string;
  /** Binds the token to this exact order; re-checked against a fresh price at confirm time. */
  fingerprint: string;
  storeId: string;
  serviceMethod: 'Delivery' | 'Carryout';
  items: OrderItem[];
  totalCents: number;
  tipCents: number;
  breakdown: Record<string, number>;
  addressSummary: string;
  /** Set immediately before the irreversible call, so a crash mid-placement is detectable. */
  placementStartedAt?: number;
};

export type OrderItem = {
  code: string;
  name: string;
  qty: number;
  priceCents: number;
  /**
   * Topping selections. Must survive to confirm time: rebuilding the order
   * without them re-prices a topped pizza as a plain one, which then fails the
   * price check and blocks every topping order.
   */
  options?: Record<string, Record<string, string>>;
};

export type HistoryEntry = {
  id: string;
  placedAt: number;
  storeId: string;
  items: OrderItem[];
  totalCents: number;
  outcome: 'placed' | 'dry-run' | 'failed' | 'unknown-crashed';
  confirmation?: string;
  error?: string;
};

export type State = {
  version: number;
  pending: PendingOrder | null;
  history: HistoryEntry[];
};

const EMPTY: State = { version: STATE_VERSION, pending: null, history: [] };

function statePath(): string {
  return join(config.stateDir, 'state.json');
}

function lockPath(): string {
  return join(config.stateDir, 'place.lock');
}

async function ensureDir(): Promise<void> {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
}

export async function readState(): Promise<State> {
  try {
    const raw = await readFile(statePath(), 'utf8');
    const parsed = JSON.parse(raw) as State;
    if (parsed.version !== STATE_VERSION) {
      throw new Error(`State file version ${parsed.version} is not supported (expected ${STATE_VERSION}).`);
    }
    return { ...EMPTY, ...parsed, history: parsed.history ?? [] };
  } catch (e: any) {
    if (e?.code === 'ENOENT') return structuredClone(EMPTY);
    throw e;
  }
}

export async function writeState(state: State): Promise<void> {
  await ensureDir();
  const target = statePath();
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(tmp, target); // atomic on the same filesystem
}

export async function mutateState<T>(fn: (s: State) => T | Promise<T>): Promise<T> {
  const state = await readState();
  const result = await fn(state);
  await writeState(state);
  return result;
}

export async function appendHistory(entry: HistoryEntry): Promise<void> {
  await mutateState(s => {
    s.history.push(entry);
    // Keep the file bounded; rate limiting only ever looks at recent entries.
    if (s.history.length > 500) s.history = s.history.slice(-500);
  });
}

/** Order placements are single-flight across processes. Stale locks expire. */
const LOCK_STALE_MS = 5 * 60 * 1000;

export async function acquirePlacementLock(): Promise<() => Promise<void>> {
  await ensureDir();
  const path = lockPath();

  try {
    const handle = await open(path, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
    await handle.close();
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e;
    // Reclaim a lock left behind by a crashed process, but only once it is old
    // enough that it cannot plausibly be an in-flight placement.
    const age = await stat(path).then(s => Date.now() - s.mtimeMs).catch(() => Infinity);
    if (age < LOCK_STALE_MS) {
      throw new Error('Another placement is already in progress. Refusing to run two at once.');
    }
    await unlink(path).catch(() => {});
    return acquirePlacementLock();
  }

  return async () => {
    await unlink(path).catch(() => {});
  };
}
