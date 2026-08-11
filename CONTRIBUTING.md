# Contributing

The most useful contribution is usually **a dialect for a database we do not
cover yet**. The analysis is database-neutral; a dialect is four small methods.

## Getting set up

```sh
npm install
npm test          # unit tests, no database needed
npm run lint
npm run typecheck
```

The integration tests need throwaway servers and are skipped without them:

```sh
docker run -d --name mi-pg --tmpfs /var/lib/postgresql/data:rw,size=512m \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=testdb \
  -e PGDATA=/var/lib/postgresql/data/pg -p 55440:5432 postgres:16-alpine

MISSING_INDEX_PG=1 npm test
```

## Writing a dialect

See `src/dialects/types.ts` for the contract and `src/dialects/postgres.ts` for
the reference implementation. Four things differ between databases:

1. **`explainStatement`** — how to ask for a plan. **Never** use `ANALYZE`:
   PostgreSQL's and MySQL's both *execute* the statement, which for an UPDATE
   means running it twice.
2. **`parseScans`** — flatten your plan format into `ScanNode`. Returning `[]`
   is always valid; an unreadable plan must mean "no suggestion", never a crash.
3. **`tableSizeQuery` / `parseTableSizes`** — from the planner's statistics, not
   `count(*)`. A single cheap lookup that does not read the table.
4. **`buildStatement`** — must be safe on a live table. PostgreSQL has
   `CONCURRENTLY`; MySQL has `ALGORITHM=INPLACE, LOCK=NONE`. A suggestion that
   locks writes for its whole duration is worse than no suggestion.

## Traps, all of them learned the hard way

**Measure the table, not the result.** A plan node's row count is how many rows
*survive* the filter. Reading 60,000 rows to return 12 shows up as "12", so
judging by that number discards exactly the queries worth reporting.

**Identifier quoting differs.** PostgreSQL writes `"col"`, MySQL writes
`` `db`.`table`.`col` `` — fully qualified, three levels deep. Getting this
wrong produces no columns, and a scan with no columns is silently skipped: the
failure is invisible rather than loud.

**Check both the callback and promise call shapes.** `mysql2/promise` wraps the
base connection and calls it *with a callback*, so an adapter that only handles
promises sees nothing at all.

**Never mark "we are inside our own EXPLAIN" with a flag on the connection.**
That flag is shared by every query on it, so the application's next query gets
skipped while an EXPLAIN is in flight. Use the async context in
`src/adapters/shared.ts`.

## Tests

Every dialect needs tests, and they can run without the real database — capture
the plan JSON once and test against it. See `test/dialects.test.ts`.

Prefer tests that assert on the thing that would actually break: for a dialect,
that the `CREATE INDEX` cannot lock the table, and that a garbage plan yields
`[]` rather than throwing.

## Style

- Comments explain **why**, not what.
- No new runtime dependencies. Zero-dependency is a feature.
- The public API is documented with JSDoc; keep it accurate.
