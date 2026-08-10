/**
 * A table with 60,000 orders and no index on user_id. The query looks
 * innocent; the plan is not.
 *
 *   docker run -d --name mi-demo --tmpfs /var/lib/postgresql/data:rw,size=512m \
 *     -e POSTGRES_PASSWORD=test -e POSTGRES_DB=testdb \
 *     -e PGDATA=/var/lib/postgresql/data/pg -p 55441:5432 postgres:16-alpine
 *   npm run build && node examples/demo.mjs
 */

import pg from "pg";
import { configure } from "../dist/index.js";
import { instrumentPgClient } from "../dist/adapters/pg.js";

const client = new pg.Client({
  host: "localhost",
  port: Number(process.env.PGPORT ?? 55441),
  user: "postgres",
  password: "test",
  database: "testdb",
});

await client.connect();

await client.query("DROP TABLE IF EXISTS orders");
await client.query(
  "CREATE TABLE orders (id serial primary key, user_id int, status text, created_at timestamptz default now())",
);
await client.query(`
  INSERT INTO orders (user_id, status)
  SELECT (i % 5000), CASE WHEN i % 3 = 0 THEN 'paid' ELSE 'open' END
  FROM generate_series(1, 60000) i
`);
await client.query("ANALYZE orders");

// Instrument after the setup, so seeding does not report on itself.
instrumentPgClient(client);
configure({ thresholdMs: 0 });

console.log("running two ordinary-looking queries...\n");

await client.query("SELECT * FROM orders WHERE user_id = $1", [42]);
await client.query("SELECT * FROM orders WHERE status = $1 AND user_id > $2", ["paid", 100]);

// The suggestions are produced after each query resolves.
await new Promise((r) => setTimeout(r, 400));

await client.query("DROP TABLE orders");
await client.end();
