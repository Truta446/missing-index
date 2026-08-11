/**
 * Adapter for `pg` (node-postgres).
 *
 * Patching `Client.prototype.query` covers everything built on it — Drizzle,
 * Knex, TypeORM, Sequelize, Kysely, raw SQL — because they all bottom out here.
 *
 * The EXPLAIN runs on the **same client** that ran the query, which matters: a
 * different connection may not see the same `search_path`, temporary tables or
 * transaction state, and would explain a different query.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- driver boundary */

import { getOptions } from "../config.js";
import { inspect } from "../detect.js";
import { postgres } from "../dialects/postgres.js";
import { captureNow, internal, patchMethod, unpatchMethod, type AnyFn } from "./shared.js";

interface Queryable {
  query(...args: any[]): any;
}

interface PgModule {
  Client?: { prototype: Queryable };
}

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

function wrap(original: AnyFn): AnyFn {
  return function patched(this: unknown, ...args: unknown[]): unknown {
    const options = getOptions();
    if (!options.enabled) return original.apply(this, args);

    const extracted = extract(args);
    if (extracted === undefined) return original.apply(this, args);

    // Callback style: rare in code new enough to care about index tuning.
    if (typeof args[args.length - 1] === "function") return original.apply(this, args);
    if (internal.getStore() === true) return original.apply(this, args);

    const callsite = captureNow();
    const started = performance.now();
    const result = original.apply(this, args);

    if (typeof (result as { then?: unknown })?.then !== "function") return result;

    return (result as Promise<unknown>).then((value) => {
      // Fire and forget: the caller must not wait on diagnostics, and a failure
      // in them must never surface as a query failure.
      void inspect({
        sql: extracted.sql,
        params: extracted.params,
        durationMs: performance.now() - started,
        callsite,
        dialect: postgres,
        run: (statement, params) =>
          internal.run(true, async () => {
            const explained = (await original.apply(this, [statement, params])) as {
              rows?: unknown;
            };
            return explained?.rows;
          }),
      }).catch(() => {});

      return value;
    });
  };
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
  patchMethod(target, "query", wrap);
  return () => unpatchMethod(target, "query");
}

/** Instruments a single pool or client. */
export function instrumentPgClient<T extends Queryable>(client: T): () => void {
  const target = client as unknown as Record<string, any>;
  patchMethod(target, "query", wrap);
  return () => unpatchMethod(target, "query");
}
