# Retrieval and indexing performance baselines

This harness measures the production Nexus runtime and tool handlers using a
fixed local synthetic embedding provider. It establishes measurement validity
and resource costs; it does not measure embedding-service throughput, retrieval
relevance, or LSP performance.

## Run the harness

Use the source checkout's locked dependencies and Node.js 24 or later:

```bash
npm ci
npm run build
npm run lint:perf
npm run --silent test:perf -- --profile smoke --output reports/performance-smoke.json
```

The full profiles run sequentially on the same host:

```bash
npm run --silent test:perf -- --profile small --output docs/observability/benchmarks/small.json
npm run --silent test:perf -- --profile medium --output docs/observability/benchmarks/medium.json
npm run --silent test:perf -- --profile large --output docs/observability/benchmarks/large.json
```

Without `--output`, direct Node invocation writes one JSON document to stdout:

```bash
node scripts/run-performance.mjs --profile smoke
```

With `--output`, stdout is empty and the runner creates the destination's parent
directory. Diagnostics go to stderr. npm's ordinary lifecycle banner is not
machine-readable report output; use `npm run --silent` when capturing JSON.
Unknown options and execution failures have nonzero exit status and explicit
incomplete reports wherever the output destination is writable.

| Profile |  Files | Declarations per file | Total declarations | Default scenario deadline |
| ------- | -----: | --------------------: | -----------------: | ------------------------: |
| smoke   |     20 |                     5 |                100 |                120,000 ms |
| small   |    100 |                    10 |              1,000 |                120,000 ms |
| medium  |  1,000 |                    10 |             10,000 |                600,000 ms |
| large   | 10,000 |                    10 |            100,000 |              1,800,000 ms |

`--timeout-ms <positive integer>` and `--memory-limit-mb <positive integer>`
override the scenario deadline and Node old-space ceiling. The default ceiling
is 2,048 MiB. It applies through `NODE_OPTIONS` to scenario and aggregation
processes, including fixture generation, cache preparation, indexing, audits and
retrieval. Setup is not exempt from the wall deadline. This heap setting is not
a whole-process RSS cap.

CI runs only smoke and uploads `reports/performance-smoke.json`, including failed
reports. CI checks completeness and contracts, not wall-clock latency thresholds.
Smoke has three measured warm calls and one lifecycle/first-call run; it cannot
support baseline-quality or tail-latency conclusions.

## Workload and measurement boundaries

The recipe is `retrieval-performance-v1`. Provider `test` uses
`nexus-synthetic-sha256-v1`, 128 finite normalized components, deterministic SHA-256
expansion, and no external embedding requests. Distribution preflight checks
fixed strings and the generated/query inputs. Normal factory creation still
rejects the reserved test provider; the benchmark's internal constructor accepts
only its fixed configuration.

Fixture metadata is root-independent and records actual UTF-8 bytes and separate
legacy rows, active structured vectors/declarations, and catalog imports. Helpers
are included in declaration counts. Legacy imports have an additional aggregate
chunk. Structured/file/recipe SHA-256 hashes are distinct from production xxHash64
chunk/Merkle hashes used by the unchanged compatible embedding-cache identity.

| Measurement             | Start                                               | End                                                        | Excluded from primary duration                                          |
| ----------------------- | --------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| `runtime_ready_ms`      | Immediately before invoking a fresh runtime factory | Successful initialization/indexing and settled queues/work | Manifest audit, retrieval probe, resource inspection                    |
| `audit_validation_ms`   | After the runtime-ready candidate                   | Complete all-file physical/catalog/source audit            | Runtime-ready candidate                                                 |
| `retrieval_probe_ms`    | After audit                                         | Successful known-fixture handler probe                     | Runtime-ready candidate                                                 |
| `audited_ready_ms`      | Same factory start                                  | Audit and probe complete                                   | Cleanup/resource inspection                                             |
| `indexing_operation_ms` | Production entry point on an existing runtime       | Successful operation and settlement                        | Fixture writes, audits, probe                                           |
| Handler samples         | Actual handler invocation                           | Handler response and production normalization complete     | Argument-schema preflight, path/proof/fixture validation, MCP transport |

Audit/probe failure invalidates the candidate readiness and associated samples.
Old timestamps and a successful single-file probe are not proof that every file
is indexed. Audit checks each physical row identity/hash/span/generation, catalog
declaration/import membership, persisted counters, source freshness, direct DLQ
state, and before/after mutation revision. Vector reads project no embeddings or
source text and request at most 512 rows. Failures retain counts and at most 20
validated logical examples per code.

### Lifecycle and cache interpretation

- Cold startup and each sibling worktree use independent empty state.
- L1 replay uses the existing production **full rebuild** path in the same
  runtime, retaining compatible caches. `indexingMode: full_rebuild` is explicit.
  It is not ordinary incremental/no-op reindex latency. Default finite L1
  capacity can produce a mixture of L1 and L2 hits on larger profiles.
- L2 rebuild copies only compatible cache entries to a new empty SQLite store,
  in sorted batches of at most 512 keys. Every batch is read back and verified;
  the final key projection must exactly equal the expected set. No Merkle,
  catalog, vector-index state or complete vector union is copied/hydrated.
  Transfer/setup failure discards the owned partial target and produces no warm
  sample.
- Warm restart constructs a new runtime over settled persisted state.
- Incremental work pauses/restarts the existing watcher around untimed fixture
  writes, then submits one add, modify and delete through the production queue
  and pipeline. Filesystem detection/debounce is not the measured boundary.
- Sibling worktrees come from one generated fixture commit in an owned disposable
  repository. Their stores/caches remain independent. Configured hooks/templates
  are rejected rather than bypassed. No user repository is committed or changed.

The observed same-generation non-full replay path can remove its newly activated
structured rows at this revision. The harness does not change that production
behavior and never admits the resulting missing-row audit as a fast valid run.
The L1 case's full-rebuild mode is therefore a deliberate scope distinction.

Full warm cases have five unmeasured warmups followed by 100 measured calls each.
Nearest-rank p50/p95/p99 are computed per named case. Full lifecycle and
first-call cases have three independent runs, with raw/min/median/max rather than
tail claims. Each first-call run reopens a fresh runtime; its readiness probe uses
a different helper from the named source workload. Probe identities and warmed
catalog/filesystem/handler dependencies are recorded, so this is not a claim of
an untouched process or cold OS cache.

### Retrieval validity and limits

Each call must pass envelope/serialization, request-scoped internal execution,
and independently generated fixture membership/multiplicity checks. Semantic
checks do not assert a ranking or relevance score. Structured positive results
must be `ok`, fresh, and require no reindex; every other status is diagnostic,
not a normal latency sample.

The production grep path is uncapped even when the request asks for 100 results.
Broad results are validated in full. Hybrid requires both branches to succeed
and separately proves all 125 measured pre-fusion grep matches/submatches even
when final RRF output contains 20 entries. A plausible top 20 cannot rescue
missing branch evidence or corruption beyond the final slice.

Path validation happens after the handler timer. Native in-root absolute paths
are projected to manifest logical identities; traversal, foreign forms, unknown
files, symlink escapes and aliases fail. Original envelopes, raw IDs and grep
arguments are never rewritten. Reports retain logical identities, bounded
examples, full counts and `sha256-multiset-v1` proofs, not source text or temporary
absolute paths.

## Resource and report semantics

Schema version 1 records options, source/lock fingerprints, revision/dirty state,
fixture identity/counts, limits, cache/provider work, validity, raw samples and
scope-specific resources. Incomplete, invalid, blocked and skipped outcomes
remain visible and do not enter normal summaries. An aggregation failure cannot
produce a complete accepted baseline.

`node_worker` CPU deltas include in-process native work and the stated interval;
they are not just JavaScript CPU. Heap is a numeric end snapshot, not a heap dump.
Peak RSS is the worker's lifetime high-water mark including setup, not exact
per-operation allocation. `external_ripgrep` CPU/RSS and `process_tree` totals are
`not_collected`, never zero. Child wall time/exit outcome is separate and is not
an estimate of CPU. Settled artifact counts are apparent metadata/vector file
bytes, outside primary timers, not allocated disk blocks or log sizes.

Only `nexus_embedding_cache_lookups_total` is new. Its finite `outcome` is
`l1_hit`, `l2_hit` or provider-bound `miss`, with existing `project`/`pid` labels.
Each chunk occurrence has one terminal lookup outcome; unique provider keys are
a union across legacy/structured origins. Mixed batches count one provider
call, and duplicate submitted occurrences are not deduplicated. See the
[metrics inventory](README.md#metrics-index-full-catalog).

## Recorded host and baseline status

The current small report is complete: run
`2bf1d36e-fa17-4dd5-a1cd-9a8e06ed6590`, 41 valid records, no missing or invalid
required cases, and 100 measured calls for each warm case. It contains 100 files,
1,000 declarations and 111,740 UTF-8 source bytes. Medium and large were attempted
with the default limits and remain incomplete. Issue #299's full scale-baseline
acceptance is **not complete**.

| Profile | Raw report                            | Valid / invalid records | Outcome                                                            |
| ------- | ------------------------------------- | ----------------------: | ------------------------------------------------------------------ |
| Small   | [small.json](benchmarks/small.json)   |                  41 / 0 | Complete; host-condition-specific baseline                         |
| Medium  | [medium.json](benchmarks/medium.json) |                  0 / 41 | All records invalid with `worker_timeout`; no normal summaries     |
| Large   | [large.json](benchmarks/large.json)   |                  0 / 41 | 7 timeout records and 34 cancellation records; no normal summaries |

Counts in the table are scenario records, not worker-process counts. A sibling
worker represents two records, and a retrieval worker represents multiple cases.

Medium run `cbb814ac-40b8-4574-9976-c0bc6c106abe` exhausted each attempted
scenario's 600,000 ms deadline. Large run
`92e1b880-786d-42e1-a219-857d315f2260` exhausted six scenario-worker deadlines
of 1,800,000 ms, including the sibling worker that represents two records. The
operator then sent SIGTERM to the large parent CLI. The runner cancelled the
active/remaining work, aggregated failure records and removed its owned scratch
directory. `worker_killed` includes jobs cancelled before spawn; it does not
mean every case ran, timed out, or exhausted memory. Both failure reports retain
all 27 required case IDs through 41 invalid records and exclude them from
latency statistics. Per-scenario deadlines include preparation and are not
measured handler latencies.

The three reports use the same source fingerprint
`8324d4dbac08acc06bc68e88fb8366ad419c3e5b6d8e6556c63d8f9fb4164f06`.
Timeouts do not establish an out-of-memory failure or isolate indexing,
instrumentation, native storage or host contention as the cause. In a diagnostic
snapshot, the large sibling worker had accumulated 31:27 CPU time in 25:54 wall
time, with 610,952 KiB RSS; this snapshot is not a completed scenario resource
measurement. Its coarse phase was `setup`, and initial traversal reached 5,000
entries in about 67 ms. Deeper indexing-stage progress and contention evidence
were not retained. The cause remains unconfirmed.

No complete medium/large audit, L2 seed/resource proof or retrieval distribution
is available. Keep these failed run IDs when collecting new evidence. First
capture bounded production-stage progress and host CPU/I/O pressure to separate
indexing/storage scaling, observer overhead and host contention. A new full run
must document a suitable otherwise-idle environment, retain the default limits
and full audits, and use a distinct output/run ID; do not silently overwrite or
combine these failures with successful samples.

| Small measurement          | Observed milliseconds | Scope                                                 |
| -------------------------- | --------------------: | ----------------------------------------------------- |
| Cold ready median          |             10,448.54 | Construction through runtime readiness; 3 runs        |
| Same-process L1 median     |             10,238.73 | Full-rebuild indexing operation; 3 runs               |
| Seeded L2 ready median     |              9,637.63 | Target construction/readiness; setup separate; 3 runs |
| Warm restart median        |                 97.54 | New runtime over persisted state; 3 runs              |
| Incremental median         |                 67.87 | Manually submitted production-queue operation; 3 runs |
| Selective grep p95         |                 17.63 | Handler-only; 100 calls                               |
| Broad uncapped grep p95    |                 41.61 | Handler-only; 2,000 returned matches; 100 calls       |
| Hybrid125/top20 p95        |                 23.40 | Handler-only; full branch proof; 100 calls            |
| Semantic p95               |                 17.54 | Handler-only; fixture membership, not ranking quality |
| Outline/source/context p95 |    1.74 / 1.43 / 1.66 | Handler-only; separate 100-call cases                 |

Raw measurements and all other cases are in the [small report](benchmarks/small.json).
The largest recorded small audit was 230.62 ms. Observed worker maxima were
260.93 MiB heap and 527.63 MiB lifetime RSS; these are not interchangeable with
the 2,048 MiB Node old-space setting. Each L2 setup verified all 1,807 expected
keys in four batches, with maximum request size 512 and no provider-bound misses
during the target rebuild.

All three small sibling pairs had equal nonempty provider-input multiset
digests and 1,888 submitted inputs per first worktree, proving 100% repeated
input multiplicity. Their observed indexing intervals were over 99% of first
worktree runtime readiness, excluding audits/probes. This meets the stated #300
investigation condition on this workload; it does not authorize shared-state
implementation or generalize to unmeasured configurations. #301/regression and
repeatability conclusions are not established from this single full profile
pass.

The measurement host has an Intel Core Ultra 7 270K Plus, 24 available logical
CPUs and 65,296,789,504 bytes of RAM. Initial load averages were approximately
5.94/7.21/8.65; background load was not eliminated. The session cgroup reported
unlimited memory/cpu quota, separately from the Node ceiling. Existing swap use
and host activity make these host-condition-specific observations, not a
controlled idle-machine comparison. OS cache state is `uncontrolled`; the runner
does not clear it.

### Investigation signals

These are investigation rules, not automatic optimization mandates or product
latency guarantees:

- #301 requires large warm grep p95 above 100 ms on **two** comparable full runs
  and source-byte scaling evidence.
- #300 requires at least 80% repeated first-worktree provider inputs in its
  sibling and indexing at least 50% of cold `runtime_ready_ms`, excluding audits
  and probes.
- Compatible L2 rebuild provider-bound misses after complete verified seeding
  are a cache-validity failure to investigate.
- Regression requires median or p95 worsening by more than 20% **and** at least
  5 ms on two comparable full runs. Match fixture digest, runtime, hardware,
  sample count, cache conditions and effective limits first.

A single profile pass does not establish repeatability. Lower synthetic latency
does not show improved relevance or source correctness. #298 LSP lifecycle,
#320 correctness/relevance scoring, #297 optimization work and #300 shared-state
implementation remain outside this baseline.
