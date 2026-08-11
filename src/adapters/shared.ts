/**
 * Machinery shared by the driver adapters.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- driver boundary */

import { AsyncLocalStorage } from "node:async_hooks";
import { ambientCallSite } from "../callsite-context.js";
import { captureCallSite, type CallSite } from "../callsite.js";
import { getOptions } from "../config.js";
import { shared } from "../global-state.js";

export type AnyFn = (this: any, ...args: any[]) => any;

const ORIGINAL = Symbol.for("missing-index.original");

/**
 * Marks statements this library issues itself, so they are never inspected in
 * turn.
 *
 * Async context rather than a flag on the client: a flag is shared by every
 * query on that connection, so while one EXPLAIN is in flight the
 * *application's* next query would be skipped, and queries vanish from the
 * report under any concurrency.
 */
export const internal = shared(
  "internal-context",
  () => new AsyncLocalStorage<true>(),
);

/**
 * Captures the application frame, if attribution is enabled.
 *
 * An ORM adapter above us may already know the answer. Its value wins, because
 * for a lazy ORM the stack at this point holds nothing but ORM and driver
 * internals — see `src/adapters/drizzle.ts`.
 */
export function captureNow(): CallSite | undefined {
  const options = getOptions();
  if (!options.captureStack) return undefined;

  const ambient = ambientCallSite();
  if (ambient !== undefined) return ambient;

  return captureCallSite();
}

export function patchMethod(
  object: Record<string, any> | undefined,
  name: string,
  make: (original: AnyFn) => AnyFn,
): boolean {
  if (object === undefined || object === null) return false;
  const original = object[name] as AnyFn | undefined;
  if (typeof original !== "function") return false;
  if (ORIGINAL in original) return false;

  const patched = make(original);
  Object.defineProperty(patched, ORIGINAL, { value: original, enumerable: false });
  Object.defineProperty(patched, "name", { value: name, configurable: true });
  object[name] = patched;
  return true;
}

export function unpatchMethod(
  object: Record<string, any> | undefined,
  name: string,
): void {
  if (object === undefined || object === null) return;
  const current = object[name] as (AnyFn & { [ORIGINAL]?: AnyFn }) | undefined;
  const original = typeof current === "function" ? current[ORIGINAL] : undefined;
  if (original !== undefined) object[name] = original;
}

export function combineRestores(restores: readonly (() => void)[]): () => void {
  return () => {
    for (let i = restores.length - 1; i >= 0; i--) restores[i]!();
  };
}
