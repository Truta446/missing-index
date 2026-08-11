import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeScans } from "../src/analyze.js";
import { columnsInCondition, orderForIndex } from "../src/conditions.js";
import { postgres } from "../src/dialects/postgres.js";
import { extractPlan } from "../src/plan.js";
import type { ScanNode } from "../src/plan.js";

const SIZES = new Map([
  ["orders", 60_000],
  ["items", 40_000],
]);

function scan(overrides: Partial<ScanNode> = {}): ScanNode {
  return {
    table: "orders",
    filter: "(user_id = 42)",
    returnedRows: 12,
    cost: 1234.5,
    ...overrides,
  };
}

function analyze(scans: ScanNode[], extra: Record<string, unknown> = {}) {
  return analyzeScans(scans, { tableRows: SIZES, dialect: postgres, ...extra });
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
  const columns = columnsInCondition("((note)::text = 'user_id = 7'::text)");
  assert.deepEqual(
    columns.map((c) => c.column),
    ["note"],
  );
});

test("classifies range comparisons apart from equality", () => {
  assert.deepEqual(columnsInCondition("((a = 1) AND (b > 2))"), [
    { column: "a", comparison: "equality" },
    { column: "b", comparison: "range" },
  ]);
});

test("strips the table alias", () => {
  assert.deepEqual(columnsInCondition("(o.user_id = 42)"), [
    { column: "user_id", comparison: "equality" },
  ]);
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

// --- analysis ---------------------------------------------------------------

test("flags a scan that read the table to return almost nothing", () => {
  const [suggestion] = analyze([scan()]);
  assert.ok(suggestion !== undefined);
  assert.equal(suggestion.table, "orders");
  assert.deepEqual(suggestion.columns, ["user_id"]);
  assert.equal(suggestion.tableRows, 60_000);
  assert.equal(suggestion.returnedRows, 12);
});

test("judges by table size, not by rows returned", () => {
  // A highly selective filter returns few rows; that is the *worst* case for a
  // full scan, not a reason to stay quiet. Filtering on the node's own row
  // count would discard exactly the queries worth reporting.
  assert.equal(analyze([scan({ returnedRows: 1 })]).length, 1);
});

test("says nothing about a table it has no statistics for", () => {
  assert.deepEqual(analyze([scan({ table: "unknown_table" })]), []);
});

test("ignores small tables, which are faster to scan than to index", () => {
  const small = new Map([["orders", 40]]);
  assert.deepEqual(analyzeScans([scan()], { tableRows: small, dialect: postgres }), []);
  assert.equal(
    analyzeScans([scan()], { tableRows: small, minRows: 10, dialect: postgres }).length,
    1,
  );
});

test("reports one suggestion per table, the most selective one", () => {
  const suggestions = analyze([
    scan({ returnedRows: 10_000 }),
    scan({ returnedRows: 8, filter: "(status = 1)" }),
  ]);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.returnedRows, 8);
});

test("honours the table ignore list", () => {
  assert.deepEqual(analyze([scan()], { ignoreTables: [/^orders$/] }), []);
});

test("caps a composite index at three columns", () => {
  const s = scan({ filter: "((a = 1) AND (b = 2) AND (c = 3) AND (d = 4))" });
  assert.equal(analyze([s])[0]?.columns.length, 3);
});

// --- statements are the dialect's business ---------------------------------

test("PostgreSQL suggests CONCURRENTLY", () => {
  const statement = postgres.buildStatement("orders", ["user_id"]);
  assert.match(statement, /CREATE INDEX CONCURRENTLY/);
  assert.match(statement, /ON "orders" \("user_id"\)/);
});

test("index names stay within the identifier limit", () => {
  const statement = postgres.buildStatement("a".repeat(40), ["b".repeat(40)]);
  const name = /CREATE INDEX CONCURRENTLY (\S+)/.exec(statement)?.[1] ?? "";
  assert.ok(name.length <= 63, `name was ${name.length} chars`);
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

test("reads a fully qualified MySQL column, backticks and all", () => {
  // MySQL renders conditions as `db`.`table`.`column`, three levels deep and
  // backtick-quoted. Only handling PostgreSQL's `"` and single qualifier meant
  // the columns came back empty and MySQL never produced a suggestion —
  // silently, because an empty column list just skips the scan.
  assert.deepEqual(columnsInCondition("(`testdb`.`orders`.`user_id` = 42)"), [
    { column: "user_id", comparison: "equality" },
  ]);
  assert.deepEqual(
    columnsInCondition("((`db`.`t`.`status` = 'paid') and (`db`.`t`.`user_id` > 100))"),
    [
      { column: "status", comparison: "equality" },
      { column: "user_id", comparison: "range" },
    ],
  );
});
