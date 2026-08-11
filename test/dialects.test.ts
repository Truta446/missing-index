/**
 * Each dialect is four things: how to ask for a plan, how to read it, where the
 * table sizes live, and how to phrase a safe CREATE INDEX. These test all four
 * against plan output captured from the real databases.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { postgres } from "../src/dialects/postgres.js";
import { mysql } from "../src/dialects/mysql.js";

describe("postgres", () => {
  test("explains without ANALYZE, which would execute the statement", () => {
    const statement = postgres.explainStatement("SELECT 1");
    assert.equal(statement, "EXPLAIN (FORMAT JSON) SELECT 1");
    assert.ok(!/analyze/i.test(statement));
  });

  test("explains reads only", () => {
    assert.ok(postgres.isExplainable("SELECT * FROM t WHERE a = 1"));
    assert.ok(postgres.isExplainable("WITH x AS (SELECT 1) SELECT * FROM x"));
    assert.ok(!postgres.isExplainable("UPDATE t SET a = 1"));
    assert.ok(!postgres.isExplainable("DELETE FROM t"));
    // A CTE can hide a write.
    assert.ok(!postgres.isExplainable("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"));
    assert.ok(!postgres.isExplainable("EXPLAIN SELECT 1"));
  });

  test("pulls sequential scans out of a real plan", () => {
    const plan = [
      {
        Plan: {
          "Node Type": "Hash Join",
          Plans: [
            { "Node Type": "Index Scan", "Relation Name": "users", "Plan Rows": 1 },
            {
              "Node Type": "Seq Scan",
              "Relation Name": "orders",
              "Plan Rows": 12,
              "Total Cost": 1234.5,
              Filter: "(user_id = 42)",
            },
          ],
        },
      },
    ];
    assert.deepEqual(postgres.parseScans(plan), [
      { table: "orders", filter: "(user_id = 42)", returnedRows: 12, cost: 1234.5 },
    ]);
  });

  test("ignores a scan with no filter, where no index would help", () => {
    const plan = [{ Plan: { "Node Type": "Seq Scan", "Relation Name": "orders" } }];
    assert.deepEqual(postgres.parseScans(plan), []);
  });

  test("an unreadable plan means no suggestion, not a crash", () => {
    assert.deepEqual(postgres.parseScans("garbage"), []);
    assert.deepEqual(postgres.parseScans(null), []);
  });

  test("reads table sizes, skipping never-analysed tables", () => {
    // reltuples is -1 when a table has never been analysed.
    const sizes = postgres.parseTableSizes({
      rows: [
        { name: "orders", rows: 60000 },
        { name: "fresh", rows: -1 },
      ],
    });
    assert.equal(sizes.get("orders"), 60000);
    assert.equal(sizes.has("fresh"), false);
  });
});

describe("mysql", () => {
  test("explains without ANALYZE", () => {
    const statement = mysql.explainStatement("SELECT 1");
    assert.equal(statement, "EXPLAIN FORMAT=JSON SELECT 1");
    assert.ok(!/analyze/i.test(statement));
  });

  test("finds access_type ALL, which is MySQL's full table scan", () => {
    // Shape captured from MySQL 8 EXPLAIN FORMAT=JSON.
    const plan = [
      [
        {
          EXPLAIN: JSON.stringify({
            query_block: {
              select_id: 1,
              table: {
                table_name: "orders",
                access_type: "ALL",
                rows_examined_per_scan: 60000,
                rows_produced_per_join: 12,
                filtered: "0.02",
                cost_info: { read_cost: "5900.00" },
                attached_condition: "(`db`.`orders`.`user_id` = 42)",
              },
            },
          }),
        },
      ],
    ];
    const scans = mysql.parseScans(plan);
    assert.equal(scans.length, 1);
    assert.equal(scans[0]?.table, "orders");
    assert.equal(scans[0]?.returnedRows, 12);
    assert.match(scans[0]?.filter ?? "", /user_id/);
  });

  test("ignores a table reached through an index", () => {
    const plan = [
      [
        {
          EXPLAIN: JSON.stringify({
            query_block: {
              table: {
                table_name: "orders",
                access_type: "ref",
                key: "idx_orders_user_id",
                attached_condition: "(`db`.`orders`.`user_id` = 42)",
              },
            },
          }),
        },
      ],
    ];
    assert.deepEqual(mysql.parseScans(plan), []);
  });

  test("finds scans nested inside a join", () => {
    const plan = {
      query_block: {
        nested_loop: [
          { table: { table_name: "users", access_type: "eq_ref" } },
          {
            table: {
              table_name: "items",
              access_type: "ALL",
              rows_examined_per_scan: 40000,
              rows_produced_per_join: 5,
              attached_condition: "(`db`.`items`.`order_id` = 7)",
            },
          },
        ],
      },
    };
    const scans = mysql.parseScans(plan);
    assert.equal(scans.length, 1);
    assert.equal(scans[0]?.table, "items");
  });

  test("never suggests a statement that locks the table", () => {
    // MySQL has no CONCURRENTLY; INPLACE with LOCK=NONE is the equivalent
    // promise, and without it the table is unwritable while the index builds.
    const statement = mysql.buildStatement("orders", ["status", "user_id"]);
    assert.match(statement, /ALGORITHM=INPLACE, LOCK=NONE/);
    assert.match(statement, /ON `orders` \(`status`, `user_id`\)/);
    assert.ok(!/CONCURRENTLY/.test(statement));
  });

  test("index names stay within MySQL's 64-character limit", () => {
    const statement = mysql.buildStatement("a".repeat(40), ["b".repeat(40)]);
    const name = /CREATE INDEX (\S+)/.exec(statement)?.[1] ?? "";
    assert.ok(name.length <= 64, `name was ${name.length} chars`);
  });

  test("reads table sizes from information_schema", () => {
    const query = mysql.tableSizeQuery(["orders", "items"]);
    assert.match(query.sql, /information_schema\.TABLES/);
    assert.deepEqual(query.params, ["orders", "items"]);

    // mysql2 resolves to [rows, fields].
    const sizes = mysql.parseTableSizes([[{ name: "orders", rows: 60000 }], []]);
    assert.equal(sizes.get("orders"), 60000);
  });

  test("an unreadable plan means no suggestion, not a crash", () => {
    assert.deepEqual(mysql.parseScans("garbage"), []);
    assert.deepEqual(mysql.parseScans(undefined), []);
  });
});
