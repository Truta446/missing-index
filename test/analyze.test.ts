import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzePlan, buildStatement } from "../src/analyze.js";
import { columnsInCondition, orderForIndex } from "../src/conditions.js";
import { extractPlan } from "../src/plan.js";
import { isExplainable, explainStatement } from "../src/explain.js";
import type { PlanNode } from "../src/plan.js";

/** Table sizes, which analyzePlan now needs to judge whether a scan is costly. */
const SIZES = new Map([["orders", 60_000], ["items", 40_000]]);

function analyze(plan: PlanNode, extra: Record<string, unknown> = {}) {
  return analyzePlan(plan, { tableRows: SIZES, ...extra });
}

function seqScan(overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    "Node Type": "Seq Scan",
    "Relation Name": "orders",
    "Plan Rows": 50_000,
    "Total Cost": 1234.5,
    Filter: "(user_id = 42)",
    ...overrides,
  };
}

// --- conditions -------------------------------------------------------------

test("reads a column out of a simple equality", () => {
  assert.deepEqual(columnsInCondition("(user_id = 42)"), [
    { column: "user_id", comparison: "equality" },
  ]);
});

test("sees through casts, which EXPLAIN adds everywhere", () => {
  assert.deepEqual(columnsInCondition("((status)::text = 'active'::text)"), [
    { column: "status", comparison: "equality" },
  ]);
});

test("does not read a column name out of a string literal", () => {
  // The literal mentions `user_id`; only the real column must come back.
  const columns = columnsInCondition("((note)::text = 'user_id = 7'::text)");
  assert.deepEqual(columns.map((c) => c.column), ["note"]);
});

test("classifies range comparisons apart from equality", () => {
  assert.deepEqual(columnsInCondition("((a = 1) AND (b > 2))"), [
    { column: "a", comparison: "equality" },
    { column: "b", comparison: "range" },
  ]);
});

test("ignores boolean keywords", () => {
  const columns = columnsInCondition("((a = 1) AND (b = 2) OR (c = 3))");
  assert.deepEqual(columns.map((c) => c.column), ["a", "b", "c"]);
});

test("strips the table alias", () => {
  assert.deepEqual(columnsInCondition("(o.user_id = 42)"), [
    { column: "user_id", comparison: "equality" },
  ]);
});

test("keeps equality when a column is compared twice", () => {
  const columns = columnsInCondition("((a > 1) AND (a = 2))");
  assert.deepEqual(columns, [{ column: "a", comparison: "equality" }]);
});

test("puts equality columns before the range column", () => {
  // A range column placed first makes the rest of a composite index unusable
  // for the equality lookup — the classic hand-written index mistake.
  const ordered = orderForIndex([
    { column: "created_at", comparison: "range" },
    { column: "tenant_id", comparison: "equality" },
    { column: "status", comparison: "equality" },
  ]);
  assert.deepEqual(ordered, ["tenant_id", "status", "created_at"]);
});

test("keeps only the first range column, which is all an index can use", () => {
  const ordered = orderForIndex([
    { column: "a", comparison: "range" },
    { column: "b", comparison: "range" },
  ]);
  assert.deepEqual(ordered, ["a"]);
});

// --- statements -------------------------------------------------------------

test("suggests CONCURRENTLY so the fix is safe on a live table", () => {
  const statement = buildStatement("orders", ["user_id"]);
  assert.match(statement, /CREATE INDEX CONCURRENTLY/);
  assert.match(statement, /ON "orders" \("user_id"\)/);
});

test("index names stay within the identifier limit", () => {
  const statement = buildStatement("a".repeat(40), ["b".repeat(40)]);
  const name = /CREATE INDEX CONCURRENTLY (\S+)/.exec(statement)?.[1] ?? "";
  assert.ok(name.length <= 63, `name was ${name.length} chars`);
});

// --- plan analysis ----------------------------------------------------------

test("flags a sequential scan that filtered rows away", () => {
  // 60,000 rows read to return 12 — precisely what an index fixes.
  const [suggestion] = analyze(seqScan({ "Plan Rows": 12 }));
  assert.ok(suggestion !== undefined);
  assert.equal(suggestion.table, "orders");
  assert.deepEqual(suggestion.columns, ["user_id"]);
  assert.equal(suggestion.tableRows, 60_000);
  assert.equal(suggestion.returnedRows, 12);
});

test("judges by table size, not by rows returned", () => {
  // A highly selective filter returns few rows; that is the *worst* case for a
  // sequential scan, not a reason to stay quiet. Filtering on the node's own
  // row count would discard exactly the queries worth reporting.
  assert.equal(analyze(seqScan({ "Plan Rows": 1 })).length, 1);
});

test("says nothing about a table it has no statistics for", () => {
  const plan = seqScan({ "Relation Name": "unknown_table" });
  assert.deepEqual(analyze(plan), []);
});

test("ignores a scan with no filter, where no index would help", () => {
  const plan = seqScan();
  delete plan.Filter;
  assert.deepEqual(analyze(plan), []);
});

test("ignores small tables, which are faster to scan than to index", () => {
  const small = new Map([["orders", 40]]);
  assert.deepEqual(analyzePlan(seqScan(), { tableRows: small }), []);
  assert.equal(analyzePlan(seqScan(), { tableRows: small, minRows: 10 }).length, 1);
});

test("ignores index scans", () => {
  assert.deepEqual(analyze({ ...seqScan(), "Node Type": "Index Scan" }), []);
});

test("finds scans nested inside a join", () => {
  const plan: PlanNode = {
    "Node Type": "Hash Join",
    Plans: [
      { "Node Type": "Index Scan", "Relation Name": "users", "Plan Rows": 1 },
      seqScan({ "Relation Name": "items", Filter: "(order_id = 7)" }),
    ],
  };
  const [suggestion] = analyze(plan);
  assert.equal(suggestion?.table, "items");
});

test("reports one suggestion per table", () => {
  const plan: PlanNode = {
    "Node Type": "Append",
    Plans: [
      seqScan({ "Plan Rows": 10_000 }),
      seqScan({ "Plan Rows": 90_000, Filter: "(status = 1)" }),
    ],
  };
  const suggestions = analyze(plan);
  assert.equal(suggestions.length, 1);
  // The more selective scan wins, being the one an index helps most.
  assert.equal(suggestions[0]?.returnedRows, 10_000);
});

test("honours the table ignore list", () => {
  assert.deepEqual(analyze(seqScan(), { ignoreTables: [/^orders$/] }), []);
});

test("caps a composite index at three columns", () => {
  const plan = seqScan({ Filter: "((a = 1) AND (b = 2) AND (c = 3) AND (d = 4))" });
  assert.equal(analyze(plan)[0]?.columns.length, 3);
});

// --- plan extraction --------------------------------------------------------

test("unwraps the plan from the shapes drivers return", () => {
  const inner = { "Node Type": "Seq Scan" };
  assert.deepEqual(extractPlan([{ Plan: inner }]), inner);
  assert.deepEqual(extractPlan([{ "QUERY PLAN": [{ Plan: inner }] }]), inner);
  assert.deepEqual(extractPlan(JSON.stringify([{ Plan: inner }])), inner);
  assert.equal(extractPlan("not json"), undefined);
  assert.equal(extractPlan([]), undefined);
});

// --- what we are willing to explain ----------------------------------------

test("explains reads only", () => {
  assert.ok(isExplainable("SELECT * FROM t WHERE a = 1"));
  assert.ok(isExplainable("  select 1"));
  assert.ok(isExplainable("WITH x AS (SELECT 1) SELECT * FROM x"));

  // Explaining a write is pointless and needlessly close to the edge.
  assert.ok(!isExplainable("UPDATE t SET a = 1"));
  assert.ok(!isExplainable("DELETE FROM t"));
  assert.ok(!isExplainable("INSERT INTO t VALUES (1)"));
  // A CTE can hide a write.
  assert.ok(!isExplainable("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"));
  // Never explain an EXPLAIN.
  assert.ok(!isExplainable("EXPLAIN SELECT 1"));
});

test("wraps the statement for JSON output", () => {
  assert.equal(explainStatement("SELECT 1"), "EXPLAIN (FORMAT JSON) SELECT 1");
});
