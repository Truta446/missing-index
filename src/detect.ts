/**
 * The pipeline: a slow query goes in, a suggestion comes out.
 */

import { analyzePlan } from "./analyze.js";
import { getOptions, reportedKeys } from "./config.js";
import { explainStatement, isExplainable, type Explainer } from "./explain.js";
import { extractPlan, walk } from "./plan.js";
import { defaultReporter } from "./report.js";
import type { CallSite, Finding } from "./types.js";

export interface InspectInput {
  sql: string;
  params?: readonly unknown[] | undefined;
  durationMs: number;
  callsite?: CallSite | undefined;
  /** Runs a statement against the same connection the query used. */
  explain: Explainer;
}

/**
 * Explains a query and reports any missing index it reveals.
 *
 * Never throws: a failure here must not break the query the application was
 * actually running. A malformed statement, a permissions problem or a
 * disconnect all just mean no suggestion.
 */
export async function inspect(input: InspectInput): Promise<Finding[]> {
  const options = getOptions();
  if (!options.enabled) return [];
  if (input.durationMs < options.thresholdMs) return [];
  if (!isExplainable(input.sql)) return [];
  if (options.ignore.some((re) => re.test(input.sql))) return [];

  let raw: unknown;
  try {
    raw = await input.explain(explainStatement(input.sql), input.params);
  } catch {
    // Cannot explain it — nothing more to say.
    return [];
  }

  const plan = extractPlan(raw);
  if (plan === undefined) return [];

  const scanned = tablesScanned(plan);
  if (scanned.length === 0) return [];

  const tableRows = await fetchTableRows(input.explain, scanned);

  const suggestions = analyzePlan(plan, {
    minRows: options.minRows,
    ignoreTables: options.ignoreTables,
    tableRows,
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
    };
    findings.push(finding);

    options.onFinding?.(finding);
    (options.reporter ?? defaultReporter)(finding);
  }

  return findings;
}


/** Tables reached by a sequential scan in this plan. */
function tablesScanned(plan: import("./plan.js").PlanNode): string[] {
  const names = new Set<string>();
  for (const node of walk(plan)) {
    if (node["Node Type"] !== "Seq Scan") continue;
    const name = node["Relation Name"];
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

/**
 * Asks the planner how big those tables are.
 *
 * `pg_class.reltuples` is the same estimate the planner itself uses, costs a
 * single indexed lookup, and — unlike `count(*)` — does not read the table we
 * are complaining about. A value below zero means the table has never been
 * analysed, in which case we have no basis for a suggestion.
 */
async function fetchTableRows(
  explain: Explainer,
  tables: readonly string[],
): Promise<Map<string, number>> {
  const rows = new Map<string, number>();
  try {
    const result = await explain(
      "SELECT relname, reltuples::bigint AS rows FROM pg_class WHERE relname = ANY($1)",
      [tables],
    );
    for (const row of normalizeRows(result)) {
      const name = row["relname"];
      const count = Number(row["rows"]);
      if (typeof name === "string" && Number.isFinite(count) && count >= 0) {
        rows.set(name, count);
      }
    }
  } catch {
    // No statistics available — better to say nothing than to guess.
  }
  return rows;
}

function normalizeRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (typeof result === "object" && result !== null) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}
