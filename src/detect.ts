/**
 * The pipeline: a slow query goes in, a suggestion comes out.
 */

import { analyzeScans } from "./analyze.js";
import { getOptions, reportedKeys } from "./config.js";
import { begin, end } from "./inflight.js";
import { defaultReporter } from "./report.js";
import type { CallSite, Finding } from "./types.js";
import type { ScanNode } from "./plan.js";
import type { Dialect } from "./dialects/types.js";

/** Runs a statement on the same connection the original query used. */
export type Runner = (
  sql: string,
  params: readonly unknown[] | undefined,
) => Promise<unknown>;

export interface InspectInput {
  sql: string;
  params?: readonly unknown[] | undefined;
  durationMs: number;
  callsite?: CallSite | undefined;
  /** Runs the EXPLAIN and the table-size lookup. */
  run: Runner;
  dialect: Dialect;
}

/**
 * Explains a query and reports any missing index it reveals.
 *
 * Never throws: a failure here must not break the query the application was
 * actually running. A malformed statement, a permissions problem or a
 * disconnect all just mean no suggestion.
 */
export async function inspect(input: InspectInput): Promise<Finding[]> {
  begin();
  try {
    return await run(input);
  } finally {
    end();
  }
}

async function run(input: InspectInput): Promise<Finding[]> {
  const options = getOptions();
  if (!options.enabled) return [];
  if (input.durationMs < options.thresholdMs) return [];
  if (!input.dialect.isExplainable(input.sql)) return [];
  if (options.ignore.some((re) => re.test(input.sql))) return [];

  let scans: ScanNode[];
  try {
    const raw = await input.run(input.dialect.explainStatement(input.sql), input.params);
    scans = input.dialect.parseScans(raw);
  } catch {
    // Cannot explain it — nothing more to say.
    return [];
  }
  if (scans.length === 0) return [];

  const tableRows = await fetchTableSizes(
    input.run,
    input.dialect,
    [...new Set(scans.map((s) => s.table))],
  );

  const suggestions = analyzeScans(scans, {
    minRows: options.minRows,
    ignoreTables: options.ignoreTables,
    tableRows,
    dialect: input.dialect,
  });

  const seen = reportedKeys();
  const findings: Finding[] = [];

  for (const suggestion of suggestions) {
    // One report per index, not per execution: the same query in a loop would
    // otherwise print the same CREATE INDEX on every iteration.
    if (seen.has(suggestion.statement)) continue;
    seen.add(suggestion.statement);

    const finding: Finding = {
      sql: input.sql,
      durationMs: input.durationMs,
      suggestion,
      callsite: input.callsite,
      dialect: input.dialect.name,
    };
    findings.push(finding);

    options.onFinding?.(finding);
    (options.reporter ?? defaultReporter)(finding);
  }

  return findings;
}

/**
 * Asks the planner how big those tables are.
 *
 * Statistics rather than `count(*)`: a single cheap lookup that does not read
 * the table we are complaining about. A table with no statistics is skipped,
 * because without a size there is no basis for a suggestion.
 */
async function fetchTableSizes(
  run: Runner,
  dialect: Dialect,
  tables: readonly string[],
): Promise<Map<string, number>> {
  try {
    const query = dialect.tableSizeQuery(tables);
    const raw = await run(query.sql, query.params);
    return dialect.parseTableSizes(raw);
  } catch {
    return new Map();
  }
}
