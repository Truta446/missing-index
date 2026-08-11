/**
 * missing-index — find the index your slow query is missing.
 *
 * When a query crosses a latency threshold, the library runs `EXPLAIN` on it,
 * looks for a sequential scan that filtered away most of the rows it read, and
 * prints the `CREATE INDEX` that would fix it — along with the line of code
 * that issued the query.
 *
 * @example
 * ```ts
 * import pg from "pg";
 * import { configure } from "missing-index";
 * import { instrumentPg } from "missing-index/pg";
 *
 * configure({ thresholdMs: 50 });
 * instrumentPg(pg);
 * ```
 */

export { configure, getOptions, resetConfig } from "./config.js";
export { inspect, type InspectInput, type Runner } from "./detect.js";
export { analyzeScans, type AnalyzeOptions } from "./analyze.js";
export { columnsInCondition, orderForIndex, type ConditionColumn, type Comparison } from "./conditions.js";
export { postgres } from "./dialects/postgres.js";
export { mysql } from "./dialects/mysql.js";
export type { Dialect } from "./dialects/types.js";
export { extractPlan, walk, rowsOf, type ScanNode } from "./plan.js";
export { runWithCallSite, ambientCallSite } from "./callsite-context.js";
export { settled } from "./inflight.js";
export { formatFinding, defaultReporter } from "./report.js";
export { captureCallSite, formatCallSite } from "./callsite.js";

export type {
  CallSite,
  Finding,
  Options,
  PgPlanNode,
  ResolvedOptions,
  Suggestion,
} from "./types.js";
