/**
 * Turning a query plan into an actionable suggestion.
 *
 * The signal we look for is a sequential scan carrying a filter: PostgreSQL
 * read every row of the table and then threw most of them away. On a small
 * table that is correct and cheaper than an index; on a large one it is the
 * classic missing index.
 */

import { columnsInCondition, orderForIndex } from "./conditions.js";
import { walk, type PlanNode } from "./plan.js";

export interface Suggestion {
  /** Table the scan read. */
  table: string;
  /** Columns to index, already ordered for a composite index. */
  columns: string[];
  /** The `CREATE INDEX` statement to run. */
  statement: string;
  /**
   * Rows in the table, i.e. how many the scan had to read. Taken from the
   * planner's own statistics, not from the plan node — a node's `Plan Rows` is
   * how many rows survive the filter, which is the opposite measure.
   */
  tableRows: number;
  /**
   * Rows the filter was expected to keep. The gap between this and
   * {@link tableRows} is the whole point: reading 60,000 rows to return 12 is
   * exactly what an index fixes.
   */
  returnedRows: number;
  /** The plan's own cost estimate for the offending node. */
  cost: number | undefined;
  /** The condition the scan filtered on, as PostgreSQL printed it. */
  filter: string;
  reason: "seq_scan_with_filter";
}

export interface AnalyzeOptions {
  /**
   * Ignore tables smaller than this. Small tables are genuinely faster to scan
   * than to index, and suggesting an index for a 50-row lookup table is noise
   * that trains people to ignore the tool.
   */
  minRows?: number;
  /** Tables to never suggest indexes for. */
  ignoreTables?: readonly RegExp[];
  /**
   * Row counts per table, from the planner's statistics. Tables missing here
   * are skipped: without knowing the size we cannot tell a costly scan from a
   * trivial one.
   */
  tableRows?: ReadonlyMap<string, number>;
}

const DEFAULT_MIN_ROWS = 1_000;

/** Builds a `CREATE INDEX` statement, quoting identifiers conservatively. */
export function buildStatement(table: string, columns: readonly string[]): string {
  const name = `idx_${table}_${columns.join("_")}`.toLowerCase().slice(0, 63);
  const quoted = columns.map((c) => `"${c}"`).join(", ");
  // CONCURRENTLY so the suggestion is safe to run against a live table: a
  // plain CREATE INDEX takes a lock that blocks writes for its whole duration.
  return `CREATE INDEX CONCURRENTLY ${name} ON "${table}" (${quoted});`;
}

/**
 * Finds sequential scans worth indexing in a plan.
 *
 * Returns at most one suggestion per table, since two scans of the same table
 * in one query almost always want the same index.
 */
export function analyzePlan(
  plan: PlanNode,
  options: AnalyzeOptions = {},
): Suggestion[] {
  const minRows = options.minRows ?? DEFAULT_MIN_ROWS;
  const ignore = options.ignoreTables ?? [];
  const byTable = new Map<string, Suggestion>();

  for (const node of walk(plan)) {
    if (node["Node Type"] !== "Seq Scan") continue;

    const table = node["Relation Name"];
    if (table === undefined) continue;
    if (ignore.some((re) => re.test(table))) continue;

    // A scan with no filter reads the table on purpose — no index helps.
    const filter = node.Filter;
    if (filter === undefined || filter.trim() === "") continue;

    const rowsInTable = options.tableRows?.get(table);
    if (rowsInTable === undefined || rowsInTable < minRows) continue;

    const returnedRows = node["Plan Rows"] ?? 0;

    const columns = orderForIndex(columnsInCondition(filter));
    if (columns.length === 0) continue;

    // Beyond three columns a composite index stops paying for itself and the
    // suggestion is more likely wrong than right.
    const capped = columns.slice(0, 3);

    const suggestion: Suggestion = {
      table,
      columns: capped,
      statement: buildStatement(table, capped),
      tableRows: rowsInTable,
      returnedRows,
      cost: node["Total Cost"],
      filter: filter.trim(),
      reason: "seq_scan_with_filter",
    };

    const existing = byTable.get(table);
    // Prefer the most selective scan: the smaller the slice returned from the
    // same table, the more an index pays off.
    if (existing === undefined || suggestion.returnedRows < existing.returnedRows) {
      byTable.set(table, suggestion);
    }
  }

  return [...byTable.values()];
}
