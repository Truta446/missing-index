/**
 * Tracking inspections in flight.
 *
 * A suggestion is produced after the query it came from has already resolved:
 * the adapter fires the EXPLAIN without awaiting it, so the application never
 * waits on diagnostics. That is right for production and inconvenient for a
 * test, which needs to know when the dust has settled.
 *
 * A fixed sleep would be both slow and flaky. Counting is neither.
 */

import { shared } from "./global-state.js";

interface State {
  count: number;
  waiters: (() => void)[];
}

function state(): State {
  return shared<State>("inflight", () => ({ count: 0, waiters: [] }));
}

/** Marks an inspection as started. */
export function begin(): void {
  state().count += 1;
}

/** Marks an inspection as finished, releasing anyone waiting. */
export function end(): void {
  const current = state();
  current.count = Math.max(0, current.count - 1);
  if (current.count === 0) {
    const waiters = current.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

/**
 * Resolves once no inspection is running.
 *
 * Resolves immediately when the count is already zero, which is the common case
 * in a test that ran no queries.
 */
export function settled(): Promise<void> {
  const current = state();
  if (current.count === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    current.waiters.push(resolve);
  });
}
