/**
 * Adapter for `pg` (node-postgres).
 *
 * Patching `Client.prototype.query` covers everything built on it — Drizzle,
 * Knex, TypeORM, Sequelize, Kysely, raw SQL — because they all bottom out
 * here.
 *
 * The EXPLAIN is issued on the **same client** that ran the query, which
 * matters: a different connection may not see the same temporary tables,
 * search_path or transaction state, and would explain a different query than
 * the one that was slow.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- driver boundary */

import { AsyncLocalStorage } from "node:async_hooks";
import { captureCallSite } from "../callsite.js";
import { getOptions } from "../config.js";
import { inspect } from "../detect.js";
import { shared } from "../global-state.js";

type AnyFn = (this: any, ...args: any[]) => any;

interface Queryable {
  query(...args: any[]): any;
}

interface PgModule {
  Client?: { prototype: Queryable };
}

const ORIGINAL = Symbol.for("missing-index.original");

interface Extracted {
  sql: string;
  params: readonly unknown[] | undefined;
}

function extract(args: readonly unknown[]): Extracted | undefined {
  const [first, second] = args;
  if (typeof first === "string") {
    return { sql: first, params: Array.isArray(second) ? second : undefined };
  }
  if (typeof first === "object" && first !== null) {
    const config = first as { text?: unknown; values?: unknown };
    if (typeof config.text === "string") {
      const values = Array.isArray(config.values)
        ? config.values
        : Array.isArray(second)
          ? second
          : undefined;
      return { sql: config.text, params: values };
    }
  }
  return undefined;
}

/**
 * Marks statements this library issues itself, so they are never inspected in
 * turn.
 *
 * This has to be async context rather than a flag on the client. A flag is
 * shared by every query on that connection, so while one EXPLAIN is in flight
 * the *application's* next query sees the flag set and gets skipped — queries
 * vanish from the report under any concurrency. Observed exactly that with two
 * queries back to back.
 */
const internal = shared(
  "internal-context",
  () => new AsyncLocalStorage<true>(),
);

function wrap(original: AnyFn): AnyFn {
  function patched(this: unknown, ...args: unknown[]): unknown {
    const options = getOptions();
    if (!options.enabled) return original.apply(this, args);

    const extracted = extract(args);
    if (extracted === undefined) return original.apply(this, args);

    // Callback style: not worth the complexity, and rare in code new enough to
    // care about index tuning.
    if (typeof args[args.length - 1] === "function") return original.apply(this, args);

    if (internal.getStore() === true) return original.apply(this, args);

    const callsite = options.captureStack ? captureCallSite() : undefined;
    const started = performance.now();
    const result = original.apply(this, args);

    if (typeof (result as { then?: unknown })?.then !== "function") return result;

    return (result as Promise<unknown>).then((value) => {
      const durationMs = performance.now() - started;

      // Fire and forget: the caller must not wait on our diagnostics, and a
      // failure in them must not surface as a query failure.
      void inspect({
        sql: extracted.sql,
        params: extracted.params,
        durationMs,
        callsite,
        explain: (statement, params) =>
          internal.run(true, async () => {
            const explained = (await original.apply(this, [statement, params])) as {
              rows?: unknown;
            };
            return explained?.rows;
          }),
      }).catch(() => {
        /* diagnostics never break the app */
      });

      return value;
    });
  }

  Object.defineProperty(patched, ORIGINAL, { value: original, enumerable: false });
  Object.defineProperty(patched, "name", { value: "query", configurable: true });
  return patched;
}

function patch(target: Record<string, any> | undefined): boolean {
  if (target === undefined) return false;
  const current = target["query"] as AnyFn | undefined;
  if (typeof current !== "function") return false;
  if (ORIGINAL in current) return false;
  target["query"] = wrap(current);
  return true;
}

function unpatch(target: Record<string, any> | undefined): void {
  if (target === undefined) return;
  const current = target["query"] as (AnyFn & { [ORIGINAL]?: AnyFn }) | undefined;
  const original = typeof current === "function" ? current[ORIGINAL] : undefined;
  if (original !== undefined) target["query"] = original;
}

/**
 * Instruments the `pg` module.
 *
 * ```ts
 * import pg from "pg";
 * import { instrumentPg } from "missing-index/pg";
 *
 * instrumentPg(pg);
 * ```
 */
export function instrumentPg(pgModule: PgModule): () => void {
  if (pgModule?.Client === undefined) {
    throw new TypeError(
      "instrumentPg() expected the pg module (with a Client export). " +
        "Pass a pool or client to instrumentPgClient() instead.",
    );
  }
  // Only the Client prototype: Pool.query delegates to a client, and patching
  // both would explain every pooled query twice.
  const target = pgModule.Client.prototype as unknown as Record<string, any>;
  patch(target);
  return () => unpatch(target);
}

/** Instruments a single pool or client. */
export function instrumentPgClient<T extends Queryable>(client: T): () => void {
  const target = client as unknown as Record<string, any>;
  patch(target);
  return () => unpatch(target);
}
