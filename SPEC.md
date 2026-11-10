# Nexus Technical Specification

This document is the canonical source for **current** Nexus architecture invariants and behavioral contracts. It does not define future roadmap targets; see [ROADMAP.md](ROADMAP.md) for planned work. Detailed MCP tool inputs, outputs, and status fields belong in [docs/mcp-tools.md](docs/mcp-tools.md).

## 1. Product Boundary

Nexus is a local-first code indexing and retrieval service exposed through Model Context Protocol (MCP). It combines:

- file watching and incremental indexing;
- semantic vector search;
- ripgrep text search;
- AST-aware chunking and a structured symbol catalog;
- exact symbol retrieval from the current working tree;
- SQLite metadata and LanceDB vector storage;
- stdio and local Streamable HTTP transport;
- optional observability and aggregation services.

The default storage root is project-local (`<projectRoot>/.nexus`).

## 2. Data and Provider Boundary

With a local-only embedding provider such as Ollama, source-derived index data remains on the host. Configuring an external embedding provider such as `openai-compat` or `bedrock` can transmit source-derived text to that configured service.

Local HTTP v2 rejects external embedding providers through the transport constraint checks. Do not infer that all Nexus operating modes are zero-transmission when an external provider is configured.

## 3. Runtime Architecture

A Nexus runtime owns the indexing/search state for a project. The principal data flow is:

```text
File watcher
  -> event queue / reconciliation
  -> file diff and chunking
  -> embedding provider
  -> LanceDB search vectors

                       -> SQLite metadata / structured catalog
```

Search combines semantic and/or textual retrieval through the search orchestrator. Structured retrieval uses the structured catalog to identify logical declarations and the current working tree to return verified source. The responsibilities and boundaries of these retrieval layers, including source files as the only source of truth, are defined in [§6 Retrieval Architecture Boundaries and Source of Truth](#6-retrieval-architecture-boundaries-and-source-of-truth).

Runtime storage resources are shared within a runtime rather than recreated for each MCP request.

## 4. Indexing Invariants

### 4.1 Background initial indexing

Normal server startup begins a full scan in the background when no completed usable index exists. Runtime initialization does not wait for the full scan before accepting tool requests.

`index_status` is the canonical public way to observe indexing state.

A completed usable index requires:

- `indexStats.lastIndexedAt` to be non-null; and
- `pipelineProgress.lastError` to be absent.

A stale but previously successful index is not automatically rebuilt solely because it is old.

### 4.2 Event queue and recovery

File-system changes are buffered and debounced. Overflow/reconciliation paths preserve eventual consistency instead of silently dropping changes. Dead-letter/recovery state prevents retry exhaustion from stopping the indexing pipeline.

A full reindex is not considered successful while unresolved dead-letter work remains.

### 4.3 Storage

SQLite is the metadata and structured-catalog store. LanceDB stores vector-search data. Batch mutation paths use transactional/atomic activation boundaries where required so readers do not observe partially activated structured generations.

#### Embedding cache identity

The in-memory L1 and SQLite L2 embedding caches use the same versioned key:
`embedding:v1:<compatibility-sha256>:<content-hash-sha256>`.
Dimensions alone never establish compatibility. The deterministic compatibility
fingerprint includes provider, model, dimensions, endpoint, region/profile,
API-key and effective header configuration (case-insensitive, last override wins,
then sorted by name), Ollama thread options, the embedded-text
identity version (`chunk-content-v1`), and provider request-semantics version.
Credential-bearing configuration participates only in the hash preimage; raw
credentials, headers, endpoints, source text, and configuration are not stored in
cache keys. Retry, timeout, batch scheduling, concurrency, and lock-wait tuning
are excluded because they do not select a different embedding space.

The runtime supplies the effective provider configuration when constructing the
pipeline. This identity is a construction-time snapshot: change the configuration
by constructing a new provider and pipeline. Callers without compatibility
configuration, or with dimensions inconsistent with the provider, bypass both
caches. An unchanged configuration preserves L1 hits and persistent L2 hits
across pipeline restarts.

Legacy `embedding_cache` rows keyed only by content hash remain in SQLite but
are never looked up or promoted into the versioned namespace. They safely miss
and can be removed by existing pruning or explicit cache clearing; no destructive
schema migration is required. The first reindex after this change therefore
recomputes previously unnamespaced embeddings. Changes to provider request
normalization/truncation semantics or embedded-text identity must bump the
corresponding version before cached vectors may be reused. Chunking changes
that produce different text already change its content hash.

This cache contract does not migrate existing LanceDB search vectors when a model
changes: rebuild the index with the new configuration. A model ID or endpoint
that is repointed to different weights also requires an explicit configuration
or compatibility-version change; the cache cannot discover remote model changes.

### 4.4 Full rebuild commit protocol and crash recovery

A clean full rebuild (`nexus --reindex --full`) enforces an all-or-nothing transactional boundary across SQLite metadata, LanceDB vector storage, and the Merkle tree:

- During full rebuild, legacy chunks and path deletions are staged in a legacy shadow table (`legacy_shadow_*`) and Merkle tree mutations are deferred. To avoid long, wasted embedding calls when a rebuild cannot succeed, any structured parse failure aborts early at the window boundary immediately after file read and chunking (Stage 1), before building embed batches, calling the embedding provider, or writing vector/Merkle data. When aborted early, staged shadow data is discarded, no subsequent windows are processed, and live vector tables, Merkle metadata, and active structured catalog generations remain unchanged. The pipeline throws `Structured full rebuild aborted: parsing failed for <filePaths>` (deduplicated in encounter order, comma-and-space separated) and persists the error in `indexStats.lastError`. If pipeline cancellation (`stop()`) occurs during Stage 1, cancellation retains precedence over the parse-failure error while preserving shadow cleanup.
- Multi-store commits follow a durable six-phase journal in SQLite (`structured_rebuild_backup_runs` and `structured_rebuild_backup_vectors`):
  1. `building` (`prepared`): catalog backup and pre-rebuild Merkle snapshot are persisted.
  2. `legacy-swapped`: live legacy `chunks` are backed up (`legacy_bak_*`) and the atomic replacement is promoted.
  3. `structured-swapped`: live `structured_chunks` are backed up (`struct_bak_*`) and the atomic replacement is promoted.
  4. `catalog-activated`: SQLite active generations are promoted.
  5. `merkle-activated`: deferred Merkle mutations are committed to the Merkle tree.
  6. `idle` (`finalized`): backup tables and journal records are removed.
- An interruption before `merkle-activated` triggers a coordinated rollback across all three stores upon startup reconciliation, restoring the SQLite catalog, LanceDB vector tables, and Merkle state from the recorded snapshot.
- An interruption at or after `merkle-activated` preserves the new generation and finalizes temporary artifact cleanup.
- The journal records deterministic names for vector shadow, replacement, and
  backup artifacts. A journal-referenced artifact is retained until coordinated
  reconciliation completes; standalone cleanup removes only unreferenced artifacts.
- Startup reconciliation deletes unreferenced shadow (`legacy_shadow_*`, `struct_shadow_*`), replacement (`legacy_rep_*`, `struct_rep_*`), and backup (`legacy_bak_*`, `struct_bak_*`) tables while strictly preserving live `chunks` and `structured_chunks`.

## 5. Search

### 5.1 Semantic and hybrid search

`semantic_search` performs vector similarity search.

`hybrid_search` combines semantic results and ripgrep results using Reciprocal Rank Fusion (RRF). Search chunks are ranking/retrieval units and must not be treated as complete logical declarations.

### 5.2 Exact text search

`grep_search` uses ripgrep for exact string/regex-oriented lookup.

### 5.3 Bounded file context

`get_context` retrieves an explicit file range or, when no range is supplied in eager mode, the file content according to the tool contract. Its deferred mode provides a bounded preview and a hint for subsequent range retrieval.

## 6. Retrieval Architecture Boundaries and Source of Truth

This section defines the responsibility of each retrieval layer and the source-of-truth rules that apply across them. It constrains retrieval architecture; concrete tool inputs, outputs, and status fields are defined in [docs/mcp-tools.md](docs/mcp-tools.md).

### 6.1 Source files are the only source of truth

Source files are the authoritative source of truth. In retrieval, the only source of truth is the current working tree, and every index, catalog, and derived search result is derived data. The semantic index, the structured catalog, and any other derived state are not authoritative source content and do not override the current working tree for exact or current-source retrieval.

Text search (`grep_search`) operates directly against source files and is not a persistent text search index.

### 6.2 Retrieval layers and responsibilities

- **Semantic index** — a derived cache for meaning-based discovery of candidate code locations.
- **Text search (`grep_search`)** — exact string/regex discovery performed directly against source files.
- **Structured Catalog** — a persistent symbol locator and identity catalog for logical declarations, including the metadata needed to verify freshness.
- **Current working tree** — the authoritative source content that exact and structured retrieval read from.
- **LSP** — on-demand semantic relationships derived from the current working tree, computed live rather than persisted as authoritative state.

### 6.3 Approximate discovery vs verified/current-source retrieval

- **Approximate discovery.** `semantic_search` and `hybrid_search` may identify candidates from derived index state; their results can reflect stale or incomplete index state. `grep_search` searches source files directly, so its candidates are line-oriented matches read directly from the source files rather than from derived index state; they remain approximate discovery and must be verified before being treated as authoritative declarations. Discovery results serve to locate code; they do not by themselves establish that a retrieved declaration is current.
- **Verified/current-source retrieval.** Exact and structured retrieval verify the requested identity against current source before returning it as fresh/current. When verification cannot establish current-source correctness, the response uses an explicit status (`stale`, `stale_identity`, `degraded`, `index_incomplete`, `unsupported`, `not_indexed`) rather than presenting stale or guessed source as current.

### 6.4 Search chunks and logical symbols are distinct units

Search chunks are ranking/retrieval units. Chunk boundaries must not become authoritative declaration boundaries. Logical symbols are identified by a stable `symbolId` and verified against current source.

### 6.5 Structured Catalog persistence boundaries

The Structured Catalog owns:

- stable `symbolId` identity;
- language, kind, logical name, and qualified name;
- file path and declaration range;
- declaration and file hashes;
- structured generation and retirement state;
- parser coverage and status.

The Structured Catalog does not own, and must never be treated as the source of truth for:

- references;
- definition edges;
- implementations;
- caller/callee graphs;
- inheritance and type hierarchies;
- resolved import graphs;
- inferred type information.

When these relationships are needed, they should be derived from the current working tree through LSP or other live analysis rather than read from the Structured Catalog as authoritative state.

### 6.6 LSP-backed semantic navigation role

LSP results are live semantic observations of the current working tree. They are not persisted as authoritative reference/call/type graphs, in the Structured Catalog or elsewhere. When an LSP capability is unavailable, the response reports that limitation explicitly instead of falling back to stale persisted edges.

(Concrete LSP-backed tools are future work tracked in [yohi/nexus#298](https://github.com/yohi/nexus/issues/298); this section defines the architectural role, not a tool contract.)

### 6.7 Architecture non-goals

Nexus does not pursue persistent reference, call, or type graphs. The Structured Catalog must not become a persistent semantic graph. These are retrieval architecture non-goals, each not pursued unless future evidence justifies it, and any exception requires explicit evidence:

- Turning the Structured Catalog into a persistent semantic graph.
- Persisting reference, call, or type graphs.
- Reimplementing language-server semantics inside Nexus language adapters.

### 6.8 Language adapter expectations

Language adapters are responsible for declaration discovery, stable identity, declaration range, and parser coverage/status reporting. They are not required or expected to resolve references, build call graphs, reconstruct type hierarchies, or infer types.

## 7. Structured Symbol Retrieval <a name="6-structured-symbol-retrieval"></a>

### 7.1 Logical symbols are independent of search chunks <a name="61-logical-symbols-are-independent-of-search-chunks"></a>

A logical declaration and a search chunk are separate retrieval units. Large declarations can be split into multiple search chunks for ranking while remaining one logical symbol in the structured catalog.

Exact symbol retrieval returns the complete verified logical declaration, not the search chunk that happened to identify it.

### 7.2 Supported languages and extensions <a name="62-supported-languages-and-extensions"></a>

The structured parser supports:

- TypeScript / JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`) via the TypeScript compiler API;
- Python (`.py`, `.pyi`) via tree-sitter;
- Go (`.go`) via tree-sitter;
- Rust (`.rs`) via tree-sitter;
- Java (`.java`) via tree-sitter;
- C# (`.cs`) via tree-sitter;
- C (`.c`) via tree-sitter;
- C++ (`.h`, `.cc`, `.cpp`, `.cxx`, `.hh`, `.hpp`, `.hxx`) via tree-sitter (`.h` is explicitly parsed as C++).

Unsupported or partially parsed files must report explicit status rather than being presented as exact structured coverage.

### 7.3 Symbol identity and AST parsing contracts <a name="63-symbol-identity-and-ast-parsing-contracts"></a>

`symbolId` is a stable logical identity generated from declaration identity inputs (`filePath`, `qualifiedName`, `kind`, `signatureDiscriminator`, `occurrence`) rather than body text or source line numbers. Moving a declaration without changing its logical identity does not by itself require a new ID; identity-changing signature/name changes can.

Core and additive language-specific `SymbolKind` values are supported (`struct`, `trait`, `impl`, `record`, `field`). The canonical `qualifiedName` uses `.` as the separator across all language catalogs (e.g. Rust `module.Trait`, `Type.method`).

AST traversal guarantees:

- **Error isolation:** A declaration is emitted only when its declaration, range, and scope nodes are free of syntax errors (`ERROR` / `MISSING`). Descendants of a broken container are skipped and never flattened into the parent scope.
- **Lexical ownership:** Parent-child links are established using lexical descriptor keys (`declarationKey` and `ownerKey`) rather than name-based reverse lookup. Rust `impl` method ownership resolves to the uniquely identified target type rather than the `impl` block.
- **Import-only preservation:** A valid parse with `status === 'ok'`, zero declarations, and non-empty imports preserves its import records in the structured catalog.

Retired identities are tracked so stale IDs fail explicitly rather than resolving to a guessed replacement.

### 7.4 Freshness and fail-closed verification <a name="64-freshness-and-fail-closed-verification"></a>

Structured retrieval compares the indexed file identity/hash with the current working-tree file before returning exact source. It also verifies the requested symbol slice against the indexed symbol hash. These checks implement the verified/current-source retrieval boundary defined in [§6 Retrieval Architecture Boundaries and Source of Truth](#6-retrieval-architecture-boundaries-and-source-of-truth).

If the current file, structured generation, parser coverage, or symbol hash does not satisfy the exactness contract, the request fails closed with an explicit structured status/error. It must not silently return stale or guessed source as exact. During indexing, a degraded parse with zero declarations is classified internally as `StructuredReadResult.kind === 'parse-failed'` regardless of import count. Incremental processing records this through `structuredParseFailed` and routes the file to the dead-letter queue; a full rebuild aborts early at the window boundary before embedding or storage writes. This internal marker is not part of the public MCP retrieval contract. The parser result contract uses `status: 'failed'` plus `failure.reasonCode` (including `parse_error` where applicable), while public retrieval tools expose only their documented `status`/`reasonCode` values.

For example, a current file hash mismatch returns `stale` with reason code `INDEX_FILE_HASH_MISMATCH`, while a retired symbol identity returns `stale_identity` with reason code `SYMBOL_RETIRED`.

### 7.5 Embedding independence <a name="65-embedding-independence"></a>

Once a structured catalog generation exists, `get_file_outline`, `get_symbol_source`, and `get_symbol_context` do not require semantic-search or embedding availability to retrieve structured data. They use the structured catalog plus the current working tree.

### 7.6 Repository scope and exclusions <a name="66-repository-scope-and-exclusions"></a>

Structured indexing follows the same project scope and exclusion policy as the main Nexus indexing pipeline. Paths excluded from indexing are not independently indexed for structured retrieval and are reported as excluded when queried.

### 7.7 Context token budget <a name="67-context-token-budget"></a>

`get_symbol_context` always preserves the complete symbol source. Its token budget is used to select related validated imports/context; budget pressure may omit related imports but does not truncate the symbol declaration itself. The response reports requested/actual budget usage and whether related context was omitted for budget.

## 8. Local HTTP v2 <a name="7-local-http-v2"></a>

`nexus serve` exposes Streamable HTTP MCP using the v2 protocol implementation.

### 8.1 Loopback-only binding <a name="71-loopback-only-binding"></a>

The server accepts loopback hosts only (`127.0.0.1`, `localhost`, or `::1`). Non-loopback binding fails closed. Hostname input is resolved/validated so a non-loopback address cannot bypass this restriction.

Origin and Host validation is enforced in the application layer as protection against DNS rebinding.

### 8.2 Stateless transport <a name="72-stateless-transport"></a>

Direct `nexus serve` requests use stateless v2 handling and do not keep legacy server-side MCP session maps. Each HTTP request can create the request-scoped MCP transport/server state needed to process that request while sharing the project runtime.

### 8.3 Health <a name="73-health"></a>

The server exposes health/readiness endpoints as implemented by the current HTTP transport. Readiness reflects whether required runtime storage is available rather than pretending an unavailable runtime is healthy.

## 9. HTTP Bridge and Managed Project Server <a name="8-http-bridge-and-managed-project-server"></a>

`nexus http-bridge` is a stdio-facing MCP bridge for clients that cannot connect directly to Streamable HTTP.

Without an explicit URL, the bridge discovers a healthy project-scoped local server from the storage descriptor or launches a managed loopback server. Managed discovery validates project identity and health before reuse. Discovery is read-only, and the bridge is never a storage writer; see [§10.1](#101-git-worktree-isolation-and-storage-ownership).

Multiple bridge clients for the same project can share the managed runtime while keeping client-side MCP transport state isolated.

Managed servers can shut down automatically after the configured idle period when no clients remain.

## 10. Process Coordination <a name="9-process-coordination"></a>

Nexus uses project-level process locking to prevent conflicting runtime/index writers for the same project. Writer exclusion across projects, Git worktrees and custom storage paths is defined by storage ownership and writer admission in [§10.1](#101-git-worktree-isolation-and-storage-ownership).

Ollama embedding calls use a machine-global lock to prevent multiple Nexus processes from oversubscribing the same local provider. Lock acquisition supports cancellation and bounded waiting according to configuration, and lock release is guaranteed on success and failure paths.

### 10.1 Git worktree isolation and storage ownership

**Runtime identity.** One canonical project root (`realpath`) is one independently correct runtime. Primary worktrees (`.git` directory), linked worktrees (`.git` file), detached HEAD, dirty working trees and non-Git directories all use this same rule. Branch names, commits, dirty state and the shape of `.git` are not identity inputs. Nexus has no repository, worktree or revision identifier.

**Default storage.** Each canonical root gets its own default storage under `<projectRoot>/.nexus`. Sibling worktrees never share search results, structured-catalog generations, vector data, Endpoint descriptors, `nexus.pid`, project locks or writer leases. Sibling runtimes can run at the same time, each behind its own Bridge, and no request is routed to another worktree's runtime.

**Protected persistent targets.** Ownership is evaluated separately for each of three targets:

- `storage.rootDir`, a directory;
- `storage.metadataDbPath`, a file, together with its SQLite sidecars;
- `storage.vectorDbPath`, a directory, unless it is exactly `memory://`.

Paths are canonicalized with the same effective resolution the stores use. An absent target resolves through its nearest existing ancestor. A symlink alias of a target is the same resource.

Admission fails closed on any of the following:

- a hard-linked SQLite file;
- a dangling, inaccessible or ambiguous path;
- one physical path used for two storage roles.

**Ephemeral vector exception.** The exact value `storage.vectorDbPath = "memory://"` gives each runtime a private temporary vector store. The empty string passed directly to runtime assembly is treated the same way. This vector store has no owner claim, no writer lease and no persistent canonical path. It skips only vector ownership: `rootDir` and `metadataDbPath` are still protected, so sharing either of them is refused even when vectors are ephemeral.

**Durable owner claims.** Each persistent target carries an internal, versioned claim. The claim records the canonical `ownerProjectRoot` and the canonical target. A directory target stores it in `.nexus-owner-claim.json` inside the directory. The metadata file stores it in an adjacent `<metadataDbPath>.nexus-owner-claim`. Claims are created atomically, never overwritten, and never deleted or rolled back by Nexus.

A runtime from a different canonical root is refused with `owner_conflict` when it requests any target already claimed by another root. That includes a crashed root's claims, which are not inferred to be abandoned. The refusal leaves the other owner's data, claims, `nexus.pid` and Endpoint bytes unchanged.

**Writer admission.** Every writer entry point obtains writer admission before it mutates anything under storage. Writer entry points are the CLI in stdio, HTTP, managed and `--reindex` modes, `createRuntime`, and direct runtime assembly. A writer must hold admission before it can:

- create storage directories;
- write `nexus.pid` or reclaim a stale one;
- take the project lock;
- open SQLite or LanceDB;
- write logs;
- publish an Endpoint.

Admission runs these steps in order:

1. A read-only preflight.
2. An account-private coordination gate and the sorted per-resource locks.
3. Nonblocking writer leases.
4. Full validation of every target and claim.
5. Creation of only the missing, empty claim-required directories. `metadata.db` is never created or opened here.
6. Atomic claim publication.
7. Verification of the complete claim set.

The admission handle is opaque, single-use and bound to the resolved targets.

If admission fails, no handle is returned and no store is opened. Partial same-owner claims and empty bootstrap directories are kept so that a later retry can complete them after full revalidation. A different owner is never granted them.

An existing nonempty target without a trustworthy claim is refused with `owner_unknown`, with no adoption, migration or deletion. This covers pre-#297 stores, malformed claims and unwritable claim locations.

**Writer exclusion.** At most one live writer may hold any persistent physical target. The same owner is no exception: a second independent writer is refused with `writer_busy`, including one that uses a different `rootDir` that overlaps, nests inside or contains a live writer's target.

The writer lease is a kernel-backed POSIX advisory lock (`fcntl`) held for the whole writer lifetime. It is never taken over based on mtime, a TTL or a PID. A paused live writer keeps its lease. A crash releases the lease through the kernel and leaves the claims in place.

A same-owner sequential restart, whether after a clean shutdown or a crash, passes writer admission onto the existing claimed store without rewriting the claims. After a crash, the separate mtime-based project lock on `storage.rootDir` still refuses an immediate successor runtime. That lock only becomes reclaimable after its stale window (see the untested items below).

A running writer checks its leases periodically (every 5 s by default). If a lease is lost, the CLI stops the pipeline and exits with status 75 instead of continuing to serve. In a test, a real managed process whose lease files were replaced exited with status 75. The observed delay was about 5 s, but the test asserts only that it is under 15 s.

**Coordination root.** Locks, leases, Bridge startup gates and Bridge attempt logs live under `<account home>/.local/state/nexus-ownership-v1`. The account home comes from the OS account database, not from `HOME` or `TMPDIR`. The directory must be account-private (mode `0700`, owned by the account, no symlink substitution) and must not overlap a storage target. Network and userspace filesystems are refused, as listed below. Different `TMPDIR` values reach the same locks.

**HTTP Bridge.** The Bridge is a read-only discovery client and never holds a writer lease. It resolves all three effective targets and runs the read-only preflight. It reuses an Endpoint only when all of the following hold:

- the preflight reports the targets as owned;
- the descriptor's internal target fingerprint matches;
- loopback address, PID, instance and health all check out.

Otherwise the Bridge serializes managed startup on a per-project gate in the coordination root and spawns the managed child.

The Bridge does not create storage or write logs under it, and never deletes any descriptor. Only the admitted managed child may replace a stale same-owner descriptor. The child refuses to publish over a foreign, unverifiable or live descriptor. The child also re-resolves its own targets and exits with `target_mismatch` if they differ from what the Bridge inspected. Concurrent Bridges for one worktree share a single healthy managed runtime, which is the only writer.

**Deletion and recreation of a worktree.** The behavior that has been demonstrated is:

- *Recreation at a different path* is a new canonical root with independent default storage. It never reaches the old runtime, even if the old managed child is still alive.
- *Recreation at the same path with default storage* starts from a fresh store, because the old store was deleted with the old checkout.
  - While an old managed child survives, the recreated worktree cannot reach it, because the old descriptor is gone.
  - It also cannot start a second writer: it is refused with `writer_busy` until the old child exits.
- *Recreation at the same path with storage outside the worktree is not protected.* Canonical-path identity cannot tell the old incarnation from the new one:
  - The recreated worktree's Bridge reattaches to a surviving old managed runtime through the surviving descriptor.
  - Once the old runtime is gone, a new runtime is admitted onto the old store as the same owner.
  - In testing, index entries for files that existed only in the old incarnation were still served after startup and after an explicit full reindex. The directory scan reports no deletions for files that disappeared while no runtime was running.
  - Until this is resolved, stop the old runtime and remove or relocate external storage before recreating a worktree at the same path.

**Limitations.**

- Writer admission and the Bridge startup gate are Linux-only. They verify kernel lock ownership through `/proc/locks`, and other platforms are refused with `unsupported_kernel_lease`. They also fail closed when `/proc/locks` cannot attest the lock. That happens when the PID namespace does not match the procfs mount. It may also happen on filesystems whose reported device numbers differ from `/proc/locks` entries, such as btrfs subvolumes or overlayfs.
- The coordination root is refused on network and userspace filesystems (NFS, SMB/CIFS, FUSE, Ceph and similar), decided by the `statfs` filesystem type.
- Populated stores created before ownership claims existed are refused rather than adopted. Nexus provides no migration procedure.

**Implemented but not exercised by tests.** The implementation does the following, but no executed test has shown it end to end:

- Refusing a coordination root on a physical network or userspace mount. Only the `statfs`-type refusal branch is unit-tested, with a simulated filesystem type.
- Reclaiming the project lock after its 30-second `proper-lockfile` stale window. Only the immediate refusal after a crash is tested.
- Fail-closed `/proc/locks` attestation when the PID namespace does not match the procfs mount, and on btrfs subvolumes or overlayfs.
- Writer admission on non-Linux platforms. The `unsupported_kernel_lease` refusal is unit-tested by overriding the platform value.
- Exclusion of a reused PID. Liveness is decided only by the kernel lease, never by a PID, but PID reuse is not exercised.
- Deriving the coordination root from the OS account database home directory. Every test overrides the coordination root with a disposable directory, so the real `<account home>/.local/state/nexus-ownership-v1` is never used by tests.
- Rejecting symlink substitution of the coordination root or its lock subdirectories. The tested coordination-root refusals are overlap with a storage target, group/other-accessible permissions and filesystem type.

**Exclusions.** This contract provides no shared mutable storage across canonical roots. It also provides no cross-worktree cache reuse, Global Manager, multi-worktree runtime manager or remote routing. Those remain separate roadmap items.

## 11. Package Mode <a name="10-package-mode"></a>

`packageMode` / `NEXUS_PACKAGE_MODE=1` enables distribution-specific constraints.

In package mode:

- the embedding provider is required to be `bedrock`;
- model, dimensions, and region remain deployment-configurable where supported;
- local metrics/dashboard behavior remains available;
- external aggregator registration is skipped.

The operational packaging workflow and deployment prerequisites are documented in [docs/distribution.md](docs/distribution.md).

## 12. Observability <a name="11-observability"></a>

Nexus records MCP tool calls, latency, search hit counts, context lines, embedding requests, and structured-retrieval outcomes through the metrics collector.

A metrics HTTP server exposes Prometheus and JSON metrics. The dashboard/aggregator can discover and aggregate multiple Nexus processes. See [docs/observability/README.md](docs/observability/README.md) for operational setup.

## 13. Security and Path Handling <a name="12-security-and-path-handling"></a>

Tool paths are sanitized against project boundaries and symlink traversal. Source retrieval must not traverse outside the configured project root.

Secrets and credentials are configuration inputs and must not be written into repository documentation, generated index data, or logs.

## 14. Compatibility and Source of Truth <a name="13-compatibility-and-source-of-truth"></a>

- Current public MCP schemas and response fields: [docs/mcp-tools.md](docs/mcp-tools.md)
- Structured index languages and limitations: [docs/structured-index.md](docs/structured-index.md)
- Runtime configuration: [docs/configuration.md](docs/configuration.md)
- Future target state: [ROADMAP.md](ROADMAP.md)
- Released history: [CHANGELOG.md](CHANGELOG.md)

Data-layer source of truth for retrieval — source files as the only authoritative content — is defined in [§6 Retrieval Architecture Boundaries and Source of Truth](#6-retrieval-architecture-boundaries-and-source-of-truth). This section governs document authority only.

When prose conflicts with implementation-backed protocol schemas or tests, fix the prose; do not preserve duplicate normative contracts in multiple documents.
