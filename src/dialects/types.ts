/**
 * What differs between databases.
 *
 * The analysis itself — find a full table scan, read the columns out of its
 * filter, order them for a composite index — is the same everywhere. What
 * changes is four things: how you ask for a plan, what that plan looks like,
 * where the table sizes live, and how you phrase a `CREATE INDEX` that will not
 * lock a live table.
 *
 * A dialect is those four things and nothing else.
 */

import type { ScanNode } from "../plan.js";

export interface Dialect {
  /** Identifier used in messages and tests. */
  readonly name: string;

  /**
   * Wraps a statement so the database returns its plan.
   *
   * Must never execute the statement for real. PostgreSQL's `ANALYZE` and
   * MySQL's `EXPLAIN ANALYZE` both do, which for an UPDATE means running it
   * twice — hence the estimated plan is what every dialect asks for.
   */
  explainStatement(sql: string): string;

  /**
   * True when this statement is a read we are willing to explain.
   *
   * Explaining a write is pointless — we suggest indexes for reads — and
   * needlessly close to the edge, so every dialect refuses them.
   */
  isExplainable(sql: string): boolean;

  /**
   * Pulls the full table scans out of whatever the driver returned. Returning
   * an empty array is always a valid answer: an unparseable plan should mean
   * "no suggestion", never a crash.
   */
  parseScans(raw: unknown): ScanNode[];

  /**
   * A query returning `{ name, rows }` for each of `tables`, from the planner's
   * own statistics.
   *
   * Statistics rather than `count(*)`: it is a single cheap lookup, and it does
   * not read the table we are complaining about.
   */
  tableSizeQuery(tables: readonly string[]): { sql: string; params: unknown[] };

  /** Reads the size rows back out of the driver's response. */
  parseTableSizes(raw: unknown): Map<string, number>;

  /**
   * The `CREATE INDEX` to suggest.
   *
   * Must be safe to run against a live table — `CONCURRENTLY` on PostgreSQL,
   * `ALGORITHM=INPLACE, LOCK=NONE` on MySQL. Suggesting a statement that locks
   * writes for its whole duration is worse than suggesting nothing.
   */
  buildStatement(table: string, columns: readonly string[]): string;
}
