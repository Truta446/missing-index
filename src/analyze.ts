/**
 * Turning a scan into an actionable suggestion.
 *
 * The signal is a full table scan carrying a filter: the database read every
 * row and threw most of them away. On a small table that is correct and
 * cheaper than an index; on a large one it is the classic missing index.
 *
 * Everything here is dialect-neutral — it works from {@link ScanNode}, which
 * each dialect produces from its own plan format.
 */

import { columnsInCondition, orderForIndex } from "./conditions.js";
import type { ScanNode } from "./plan.js";
import type { Dialect } from "./dialects/types.js";

export interface Suggestion {
  /** Table the scan read. */
  table: string;
  /** Columns to index, already ordered for a composite index. */
  columns: string[];
  /** The `CREATE INDEX` statement to run. */
  statement: string;
  /**
   * Rows in the table, i.e. how many the scan had to read. Taken from the
   * planner's own statistics, not from the plan node — a node's row count is
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
  /** The condition the scan filtered on, as the database printed it. */
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
  /** Dialect used to phrase the `CREATE INDEX`. */
  dialect: Dialect;
}

const DEFAULT_MIN_ROWS = 1_000;

/**
 * Finds scans worth indexing.
 *
 * Returns at most one suggestion per table, since two scans of the same table
 * in one query almost always want the same index.
 */
export function analyzeScans(
  scans: readonly ScanNode[],
  options: AnalyzeOptions,
): Suggestion[] {
  const minRows = options.minRows ?? DEFAULT_MIN_ROWS;
  const ignore = options.ignoreTables ?? [];
  const byTable = new Map<string, Suggestion>();

  for (const scan of scans) {
    if (ignore.some((re) => re.test(scan.table))) continue;

    const rowsInTable = options.tableRows?.get(scan.table);
    if (rowsInTable === undefined || rowsInTable < minRows) continue;

    const columns = orderForIndex(columnsInCondition(scan.filter));
    if (columns.length === 0) continue;

    // Beyond three columns a composite index stops paying for itself and the
    // suggestion is more likely wrong than right.
    const capped = columns.slice(0, 3);

    const suggestion: Suggestion = {
      table: scan.table,
      columns: capped,
      statement: options.dialect.buildStatement(scan.table, capped),
      tableRows: rowsInTable,
      returnedRows: scan.returnedRows,
      cost: scan.cost,
      filter: scan.filter,
      reason: "seq_scan_with_filter",
    };

    const existing = byTable.get(scan.table);
    // Prefer the most selective scan: the smaller the slice returned from the
    // same table, the more an index pays off.
    if (existing === undefined || suggestion.returnedRows < existing.returnedRows) {
      byTable.set(scan.table, suggestion);
    }
  }

  return [...byTable.values()];
}
