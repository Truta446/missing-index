/**
 * Integration test against a real PostgreSQL, driven through the real `pg`
 * driver. Skipped unless MISSING_INDEX_PG is set:
 *
 *   docker run -d --name mi-pg --tmpfs /var/lib/postgresql/data:rw,size=512m \
 *     -e POSTGRES_PASSWORD=test -e POSTGRES_DB=testdb \
 *     -e PGDATA=/var/lib/postgresql/data/pg -p 55440:5432 postgres:16-alpine
 *   MISSING_INDEX_PG=1 npm test
 *
 * The unit tests use plan fixtures; this one proves the fixtures match what
 * PostgreSQL actually emits, which is the part fixtures cannot tell you.
 */

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { configure, resetConfig } from "../src/index.js";
import { instrumentPgClient } from "../src/adapters/pg.js";
import type { Finding } from "../src/types.js";

const enabled = process.env["MISSING_INDEX_PG"] !== undefined;

describe("against a real PostgreSQL", { skip: !enabled }, () => {
  let pg: typeof import("pg");
  let client: import("pg").Client;
  let restore: (() => void) | undefined;
  const findings: Finding[] = [];

  before(async () => {
    pg = await import("pg");
    client = new pg.Client({
      host: "localhost",
      port: 55440,
      user: "postgres",
      password: "test",
      database: "testdb",
    });
    await client.connect();

    await client.query("DROP TABLE IF EXISTS orders");
    await client.query("CREATE TABLE orders (id serial primary key, user_id int, status text, total numeric)");
    // Enough rows that a sequential scan is genuinely the wrong plan.
    await client.query(`
      INSERT INTO orders (user_id, status, total)
      SELECT (i % 5000), CASE WHEN i % 3 = 0 THEN 'paid' ELSE 'open' END, i
      FROM generate_series(1, 60000) i
    `);
    await client.query("ANALYZE orders");

    resetConfig();
    configure({
      enabled: true,
      thresholdMs: 0,
      minRows: 1000,
      onFinding: (f) => findings.push(f),
      reporter: () => {},
    });
    restore = instrumentPgClient(client);
  });

  after(async () => {
    restore?.();
    await client?.query("DROP TABLE IF EXISTS orders").catch(() => {});
    await client?.end().catch(() => {});
  });

  test("suggests the index PostgreSQL is missing", async () => {
    findings.length = 0;

    await client.query("SELECT * FROM orders WHERE user_id = $1", [42]);
    // The suggestion is produced after the query resolves, so let the
    // microtask that runs EXPLAIN finish.
    await new Promise((r) => setTimeout(r, 250));

    assert.equal(findings.length, 1, "expected exactly one suggestion");
    const [finding] = findings;
    assert.equal(finding?.suggestion.table, "orders");
    assert.deepEqual(finding?.suggestion.columns, ["user_id"]);
    assert.match(finding?.suggestion.statement ?? "", /CREATE INDEX CONCURRENTLY/);
    assert.match(finding?.callsite?.file ?? "", /integration\.test/);
  });

  test("stops suggesting once the index exists", async () => {
    resetConfig();
    configure({ enabled: true, thresholdMs: 0, minRows: 1000, onFinding: (f) => findings.push(f), reporter: () => {} });
    findings.length = 0;

    await client.query("CREATE INDEX idx_orders_status ON orders (status)");
    await client.query("ANALYZE orders");

    // Highly selective value, so the planner will choose the index.
    await client.query("SELECT * FROM orders WHERE status = $1", ["nonexistent"]);
    await new Promise((r) => setTimeout(r, 250));

    assert.deepEqual(
      findings.filter((f) => f.suggestion.columns.includes("status")),
      [],
      "an indexed column must not be suggested again",
    );

    await client.query("DROP INDEX idx_orders_status");
  });

  test("does not lose a query issued while an EXPLAIN is in flight", async () => {
    // A boolean flag on the client would be set for the whole duration of the
    // first EXPLAIN, and the second query would be skipped. Two queries back
    // to back is enough to reproduce it.
    resetConfig();
    configure({ enabled: true, thresholdMs: 0, minRows: 1000, onFinding: (f) => findings.push(f), reporter: () => {} });
    findings.length = 0;

    await client.query("SELECT * FROM orders WHERE user_id = $1", [7]);
    await client.query("SELECT * FROM orders WHERE status = $1 AND user_id > $2", ["paid", 100]);
    await new Promise((r) => setTimeout(r, 400));

    const columns = findings.map((f) => f.suggestion.columns.join(","));
    assert.equal(findings.length, 2, `expected both queries reported, got ${columns.join(" | ")}`);
    // Equality before range, or the index is unusable for the equality lookup.
    assert.ok(columns.includes("status,user_id"), `got ${columns.join(" | ")}`);
  });

  test("does not explain writes", async () => {
    resetConfig();
    configure({ enabled: true, thresholdMs: 0, minRows: 1, onFinding: (f) => findings.push(f), reporter: () => {} });
    findings.length = 0;

    await client.query("UPDATE orders SET total = total WHERE user_id = $1", [1]);
    await new Promise((r) => setTimeout(r, 250));

    assert.deepEqual(findings, []);
  });
});
