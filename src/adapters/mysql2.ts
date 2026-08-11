/**
 * Adapter for `mysql2` (MySQL and MariaDB).
 *
 * Both `query` and `execute` go through `Connection.prototype`, and the promise
 * wrapper in `mysql2/promise` delegates to that same base connection — so
 * patching the prototype covers all of it. Anything built on mysql2 comes
 * along: Drizzle, Knex, TypeORM, Sequelize.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- driver boundary */

import { getOptions } from "../config.js";
import { inspect } from "../detect.js";
import { mysql } from "../dialects/mysql.js";
import {
  captureNow,
  combineRestores,
  internal,
  patchMethod,
  unpatchMethod,
  type AnyFn,
} from "./shared.js";

interface Queryable {
  query(...args: any[]): any;
  execute?(...args: any[]): any;
}

interface Mysql2Module {
  Connection?: { prototype: Queryable };
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
    const config = first as { sql?: unknown; values?: unknown };
    if (typeof config.sql === "string") {
      const values = Array.isArray(config.values)
        ? config.values
        : Array.isArray(second)
          ? second
          : undefined;
      return { sql: config.sql, params: values };
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
    if (internal.getStore() === true) return original.apply(this, args);

    const callsite = captureNow();
    const started = performance.now();
    const self = this;

    /**
     * Runs a statement on this same connection and resolves with its rows.
     *
     * Always callback-style, because that is what the base connection speaks —
     * `mysql2/promise` is a wrapper that supplies the callback itself.
     */
    const run = (statement: string, params: readonly unknown[] | undefined) =>
      internal.run(
        true,
        () =>
          new Promise<unknown>((resolve, reject) => {
            original.apply(self, [
              statement,
              params ?? [],
              (error: unknown, rows: unknown) => {
                if (error) reject(error as Error);
                else resolve(rows);
              },
            ]);
          }),
      );

    const examine = (): void => {
      void inspect({
        sql: extracted.sql,
        params: extracted.params,
        durationMs: performance.now() - started,
        callsite,
        dialect: mysql,
        run,
      }).catch(() => {});
    };

    // Callback style. This is not the rare path: `mysql2/promise` wraps the
    // base connection and calls it with a callback, so every promise-API query
    // arrives here.
    const last = args[args.length - 1];
    if (typeof last === "function") {
      const callback = last as AnyFn;
      const forwarded = args.slice(0, -1);
      forwarded.push(function (this: unknown, ...cbArgs: unknown[]) {
        examine();
        return callback.apply(this, cbArgs);
      });
      return original.apply(this, forwarded);
    }

    const result = original.apply(this, args);
    if (typeof (result as { then?: unknown })?.then !== "function") return result;

    return (result as Promise<unknown>).then((value) => {
      examine();
      return value;
    });
  };
}

/**
 * Instruments the `mysql2` module. Also covers `mysql2/promise`, which wraps
 * the same connection class.
 *
 * ```ts
 * import mysql from "mysql2";
 * import { instrumentMysql2 } from "missing-index/mysql2";
 *
 * instrumentMysql2(mysql);
 * ```
 */
export function instrumentMysql2(mysql2Module: Mysql2Module): () => void {
  if (mysql2Module?.Connection === undefined) {
    throw new TypeError(
      "instrumentMysql2() expected the mysql2 module (with a Connection export). " +
        "Pass a connection or pool to instrumentMysql2Connection() instead.",
    );
  }
  // Pool.query delegates to a connection, so only the connection is patched.
  const target = mysql2Module.Connection.prototype as unknown as Record<string, any>;
  patchMethod(target, "query", wrap);
  patchMethod(target, "execute", wrap);
  return combineRestores([
    () => unpatchMethod(target, "query"),
    () => unpatchMethod(target, "execute"),
  ]);
}

/** Instruments a single connection or pool. */
export function instrumentMysql2Connection<T extends Queryable>(connection: T): () => void {
  const target = connection as unknown as Record<string, any>;
  patchMethod(target, "query", wrap);
  patchMethod(target, "execute", wrap);
  return combineRestores([
    () => unpatchMethod(target, "query"),
    () => unpatchMethod(target, "execute"),
  ]);
}
