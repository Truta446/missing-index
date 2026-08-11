# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-08-11

### Added

- **MySQL and MariaDB support** (`missing-index/mysql2`), closing #1. The
  analysis was already database-neutral; what differed was four things, now
  isolated behind a `Dialect`: how to ask for a plan, how to read it, where the
  table sizes live, and how to phrase a `CREATE INDEX` that does not lock the
  table. MySQL has no `CONCURRENTLY`, so its suggestions carry
  `ALGORITHM=INPLACE, LOCK=NONE` — the equivalent promise.

- **`expectNoMissingIndex()`** (`missing-index/test`), closing #3. The detector
  on its own is something you run once; the assertion in CI is what keeps an
  unindexed query from coming back.

  Suggestions arrive asynchronously — the EXPLAIN runs after the query it came
  from has resolved. Rather than sleeping for a guessed duration, the library
  now counts inspections in flight and the helper awaits that count reaching
  zero: immediate when nothing is pending, and never flaky.

- **Drizzle adapter** (`missing-index/drizzle`) and the ambient call site
  mechanism behind it. A Drizzle query is a lazy thenable, so by execution time
  the caller's frame has left the stack and suggestions were reported against
  nothing. The adapter captures the call site while the query is still being
  built and republishes it during execution.

- `captureMissingIndexes()` for asserting on the details, and `settled()` for
  awaiting pending inspections directly.

### Fixed

- **MySQL suggestions were never produced**, found by running against a real
  MySQL 8 rather than fixtures. MySQL renders conditions fully qualified and
  backtick-quoted — ``(`db`.`orders`.`user_id` = 42)`` — and the column parser
  only understood PostgreSQL's `"` with a single qualifier. It returned no
  columns, and a scan with no columns is silently skipped, so the failure was
  invisible.

- **`mysql2/promise` queries were skipped entirely.** The promise API wraps the
  base connection and calls it *with a callback*, and the adapter treated
  callback style as a rare path worth ignoring. It is the default path.

### Changed

- `analyzePlan` became `analyzeScans` and takes dialect-neutral `ScanNode`s.
  `explainStatement`/`isExplainable` moved onto the dialect.

## [0.1.1] — 2026-08-10

### Changed

- Conditional exports so `require()` works from Node 20.19, where requiring an
  ES module was backported. Verified under Node 18, 20, 22 and 24.
- README banner.

## [0.1.0] — 2026-08-10

Initial release. Explains queries that cross a latency threshold, looks for a
sequential scan carrying a filter, and prints the `CREATE INDEX` that would fix
it along with the line of code that ran the query.

[0.2.0]: https://github.com/Truta446/missing-index/releases/tag/v0.2.0
[0.1.1]: https://github.com/Truta446/missing-index/releases/tag/v0.1.1
[0.1.0]: https://github.com/Truta446/missing-index/releases/tag/v0.1.0
