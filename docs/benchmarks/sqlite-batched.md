# SQLite Batched Writes Benchmark

## Command

```bash
npm run test:bench -- --run --minWorkers=1 --maxWorkers=1 tests/benchmarks/sqlite-batched.bench.ts
```

## Scope

- `SqliteMetadataStore.bulkUpsertMerkleNodes()`
- `SqliteMetadataStore.bulkDeleteMerkleNodes()`
- Node counts: `1,000`, `5,000`, `10,000`
- Batch sizes: `25`, `50`, `100`, `250`, `500`

## Latest Observation

Run date: `2026-04-07`

### Runtime Metadata

| Field | Value |
| --- | --- |
| CPU | Generic x86_64 (8-core) |
| OS | Linux (Ubuntu 22.04 LTS) |
| Node.js | v20.12.2 |
| SQLite | v3.45.1 |
| PRAGMA | `journal_mode=WAL`, `synchronous=NORMAL`, `cache_size=2000`, `temp_store=MEMORY` |

- In this environment, `batchSize=500` was the fastest `upsert` configuration at `1,000`, `5,000`, and `10,000` rows.
- `batchSize=100` was consistently slower than `250` and `500` in the larger data sets.
- `upsert+delete` performance showed more variance, but `100` was not the best configuration there either.

## Conclusion

The current default `batchSize=100` is functional, but this benchmark (run on the metadata above) does not support it as the best-performing choice.

If we want to tune production defaults based on measured throughput, `250` or `500` are better candidates for follow-up evaluation.
