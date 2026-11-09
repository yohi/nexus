# MCP Tool Reference

Nexus exposes twelve MCP tools through `createNexusServer()`. This is the canonical public reference for tool roles and structured-retrieval behavior. Current architecture invariants are in [SPEC.md](../SPEC.md).

## Tools

| Tool | Purpose |
| --- | --- |
| `semantic_search` | Vector search over indexed code chunks |
| `grep_search` | Exact text and regex search through ripgrep |
| `hybrid_search` | Reciprocal Rank Fusion of semantic and grep results |
| `get_context` | Bounded or deferred file-range retrieval |
| `get_file_outline` | Symbol outline for a known supported source file |
| `get_symbol_source` | Exact verified source for a structured `symbolId` |
| `get_symbol_context` | Exact symbol source plus verified related imports within a token budget |
| `get_definition` | Live TypeScript/JavaScript LSP definition locations (opt-in, Owner-approved server) |
| `get_references` | Live TypeScript/JavaScript LSP reference locations (opt-in, Owner-approved server) |
| `get_implementations` | Live TypeScript/JavaScript LSP implementation locations (opt-in, Owner-approved server) |
| `index_status` | Index, structured-index, pipeline, vector, and plugin health |
| `reindex` | Manual incremental reindex or clean full rebuild |

## Retrieval Flow

Call `index_status` before relying on search results.

```text
semantic_search / hybrid_search
  -> usable symbolId
  -> get_symbol_source or get_symbol_context

known supported source file
  -> get_file_outline
  -> symbolId
  -> get_symbol_source or get_symbol_context

line-oriented / non-symbol hit
  -> get_context
```

Search chunks and logical symbols are different retrieval units. Prefer exact structured retrieval when a usable `symbolId` exists.

## Search Tools

`semantic_search` accepts `query` and optional `topK`, `filePattern`, `filePatterns`, and `language`. Results contain ranked chunks; a chunk backed by a structured declaration can carry `chunk.symbolId`.

`grep_search` accepts `pattern` and optional `filePattern`, `filePatterns`, `caseSensitive`, and `maxResults`. Matches are line-oriented and include file/line/submatch information.

`hybrid_search` accepts `query` and optional `topK`, `filePattern`, `filePatterns`, `language`, `grepPattern`, `includeSnippet`, and `contextLines`. `contextLines` is clamped to 20. Snippet-read failures omit that snippet rather than failing the entire search response.

## Context and Structured Retrieval

`get_context` requires project-relative `filePath` and supports optional `startLine`, `endLine`, and `mode` (`eager` or `deferred`). Paths are sanitized and ranges are clamped to file bounds. Deferred mode returns a bounded preview plus follow-up range metadata.

`get_file_outline` requires `filePath`. On `ok`, symbols can include `name`, `qualifiedName`, `symbolId`, `kind`, `signatureDiscriminator`, `position`, `isExact`, `languageId`, and `parentSymbolId`.

### `kind`

Symbols report a `kind` describing the declaration shape. Core kinds include `function`, `class`, `interface`, `method`, `property`, `variable`, `enum`, `type`, `namespace`, `module`, and `import`.

Additional language-specific kinds include `struct`, `trait`, `impl`, `record`, and `field`.

`get_symbol_source` requires `symbolId`. On `ok`, it returns the complete verified declaration plus freshness/reindex state. Non-`ok` outcomes do not return guessed source.

`get_symbol_context` requires `symbolId` and `tokenBudget` (`1..100000`). The complete symbol declaration is preserved even if it exceeds the budget; related imports are reduced instead. Budget metadata reports requested/actual usage, whether it was exceeded, and omissions.

### Import completeness

Related imports expose `completeness`. A direct binding or concrete include is
`complete`; wildcard, static, unresolved, or diagnostic imports are `partial`.
This describes syntactic capture only and does not imply compiler-level module
or include resolution.

Structured retrieval is fail-closed. Public statuses include `ok`, `not_found`, `stale_identity`, `not_indexed`, `excluded`, `unsupported`, `degraded`, `stale`, and `index_incomplete`. Representative codes include `FILE_NOT_FOUND`, `SYMBOL_NOT_FOUND`, `SYMBOL_RETIRED`, `STRUCTURED_INDEX_MISSING`, `PATH_EXCLUDED`, `STRUCTURED_SCHEMA_UNSUPPORTED`, `unsupported_language`, `PARSER_COVERAGE_PARTIAL`, `PARSER_BOUNDARY_UNCERTAIN`, `INDEX_FILE_HASH_MISMATCH`, `INDEX_FILE_MISSING`, `INDEX_PENDING_GENERATION`, `INDEX_SYMBOL_HASH_MISMATCH`, `INDEX_IMPORT_HASH_MISMATCH`, and `INDEX_GENERATION_MISSING`.

A stale or retired identity must not be silently mapped to a similar symbol.

## LSP Semantic Navigation

`get_definition`, `get_references`, and `get_implementations` ask a
runtime-local TypeScript/JavaScript language server for live semantic
locations. They are **disabled by default**. When disabled, unconfigured, or
unapproved they return an LSP-local `unavailable` result, and every other tool
keeps working. Semantic answers are live observations. Nexus does not persist
a navigation graph.

### Arguments

All three tools take the same flat target fields. Supply **exactly one** of
these target shapes:

1. `symbolId` alone (a verified Structured Catalog identity), or
2. `filePath` + `line` + `character`, all present.

| Field | Type | Notes |
| --- | --- | --- |
| `symbolId` | string | Structured `symbolId` from `get_file_outline` or search results |
| `filePath` | string | Project-relative path (no absolute paths or URIs) |
| `line` | integer >= 1 | 1-based line |
| `character` | integer >= 0 | 0-based UTF-16 code-unit offset; `0` is valid |
| `maxResults` | integer 1..1000 | `get_references` only; default 100. A configured HTTP `maxResultsLimit` can lower this maximum but never raise it above 1000 |

Mixed or partial targets, `line: 0`, negative positions, and malformed
identifiers fail as ordinary tool input errors before any language server is
started. Supported extensions are `.ts`, `.mts`, `.cts` (`typescript`),
`.tsx` (`typescriptreact`), `.js`, `.mjs`, `.cjs` (`javascript`), and `.jsx`
(`javascriptreact`). Both target forms use the same extension mapping.

The `filePath` form reads the **saved file on disk**, so it works on dirty
files that have not been reindexed yet. The `symbolId` form is fail-closed. A
changed, retired, or otherwise stale identity is refused and never remapped to
a similar symbol.

### Result

```typescript
interface NavigationResponse {
  status: 'ok' | 'not_found' | 'stale_identity' | 'stale' | 'index_incomplete'
    | 'not_indexed' | 'degraded' | 'excluded' | 'unsupported' | 'unavailable'
    | 'timeout' | 'cancelled' | 'error';
  capability: 'supported' | 'unsupported' | 'unavailable' | 'not_checked';
  // project-relative paths, 1-based lines, 0-based UTF-16 characters
  locations: Array<{ filePath: string; startLine: number; startCharacter: number;
    endLine: number; endCharacter: number }>;
  truncated: boolean;
  sourceValidation: 'verified' | 'partial' | 'unknown';
  reasonCode?: string;
  excludedResultCount?: number;
  reindexRequired?: boolean;
}
```

- `status: 'ok'` with an empty `locations` array means the server processed
  the request and found nothing. That differs from `unsupported` and
  `unavailable`.
- `sourceValidation: 'verified'` means every returned position was checked
  against the current disk bytes. It does **not** prove project-wide semantic
  freshness.
- `partial` means some server locations were dropped because they were
  outside the worktree, excluded, or unsafe. `excludedResultCount` gives the
  number dropped.
- `truncated: true` means the result hit `maxResults` (references) or the
  internal limit of 100 (definitions and implementations).
- Locations are de-duplicated and sorted. Public fields never contain raw
  absolute paths, file contents, or language-server stderr.

### Statuses and reason codes

| Status / `reasonCode` | Meaning | Retry? |
| --- | --- | --- |
| `not_found` / `FILE_NOT_FOUND` | Target file does not exist or is not a regular file | After fixing input |
| `not_found` / `POSITION_OUT_OF_RANGE` | `line`/`character` is outside the current file | After fixing input |
| `not_found` / `POSITION_INSIDE_SURROGATE_PAIR` | `character` splits a non-BMP character (UTF-16 surrogate pair) | After fixing input |
| `not_found` / `SYMBOL_NOT_FOUND`, `stale_identity` / `SYMBOL_RETIRED` | Unknown or retired `symbolId` | Get a fresh `symbolId` |
| `not_indexed` / `STRUCTURED_INDEX_MISSING` | No structured baseline for the `symbolId` | After indexing |
| `index_incomplete` / `INDEX_PENDING_GENERATION`, `INDEX_GENERATION_MISSING`, `INDEX_SYMBOL_HASH_MISMATCH` | Structured index is mid-update or inconsistent | Yes, after indexing settles |
| `stale` / `INDEX_FILE_HASH_MISMATCH`, `INDEX_FILE_MISSING` | Target file changed or disappeared during the request. With `reindexRequired: true`, the `symbolId` is out of date | Yes. Use the file/position form or reindex |
| `excluded` / `PATH_EXCLUDED` | Path is outside the worktree, a symlink escape, or excluded by ignore rules | No |
| `unsupported` / `unsupported_language`, `STRUCTURED_SCHEMA_UNSUPPORTED` | Extension or parser not supported | No |
| `degraded` / `PARSER_COVERAGE_PARTIAL`, `IDENTIFIER_TOKEN_UNRESOLVED` | No unique name token could be proven for the `symbolId` | Use the file/position form |
| `unsupported` / `LSP_CAPABILITY_UNSUPPORTED` | The server does not advertise this operation | No |
| `unsupported` / `unsupported_line_separator` | The target file contains U+2028 or U+2029. TypeScript counts these as line breaks but LSP does not, so positions cannot be mapped safely. Result locations in such files are omitted (`partial`), and an open document that gains one aborts the request as `stale` / `INDEX_FILE_HASH_MISMATCH` | After removing the characters |
| `unavailable` / `LSP_NOT_CONFIGURED` | LSP is disabled or no executable is configured (the default) | After configuration |
| `unavailable` / `LSP_CONFIG_INVALID` | An `lsp` config value is invalid. Only LSP is affected | After fixing config |
| `unavailable` / `LSP_TRUST_REQUIRED` | Trust store is missing, unreadable, or unsafe, or this worktree is not approved | After Owner approval |
| `unavailable` / `LSP_EXECUTABLE_NOT_APPROVED` | Executable path, digest, args, or approved version does not match the trust entry, or the server reported a different version | After Owner re-approval |
| `unavailable` / `LSP_START_FAILED` | The approved process could not be spawned or exited during startup | Yes |
| `unavailable` / `LSP_SYNC_UNSUPPORTED` | The server cannot accept open/close plus Full or Incremental document sync | No |
| `timeout` / `LSP_REQUEST_TIMEOUT` | Startup, request, or navigation-lock wait exceeded its bound | Yes |
| `cancelled` / `REQUEST_CANCELLED` | The caller cancelled the request | Yes |
| `error` / `LSP_PROTOCOL_ERROR` | Protocol or transport failure, or a malformed or error reply. A failed document sync or close, or a process exit, discards the session so the next request starts a fresh process. A malformed reply or error response to the navigation request itself keeps the session | Yes |
| `error` / `FILE_READ_ERROR`, `TARGET_RESOLUTION_FAILED`, `invalid_utf8` | The target source could not be read or decoded | After fixing the file |
| `error` / `RESULT_VALIDATION_FAILED`, `INVARIANT_VIOLATION`, `PARSE_ERROR` | Internal validation fault. No locations are returned | Report if persistent |

**Other open documents.** Before each navigation, Nexus re-reads every other
document this server already has open and synchronizes any saved changes. A
definition in file A, reached from file B, therefore reflects A's current disk
content. If another open document is **missing, unsafe, unreadable, or
changes during the request**, Nexus closes it where possible and **aborts the
current navigation**. The abort surfaces as `stale` / `INDEX_FILE_MISSING` or
`stale` / `INDEX_FILE_HASH_MISMATCH`, even when the requested target is
unchanged. These outcomes are **retryable**: the closed document is dropped
from the server, so a retry normally succeeds.

### Enabling LSP navigation

Turning LSP on takes two independent steps. Configuration alone never
authorizes execution.

**1. External prerequisite (not installed by Nexus).** Install
`typescript-language-server@6.0.2` outside the repository. The target project
should use TypeScript 5.9.x (`node_modules/typescript`). Nexus never runs
`npx`, never auto-installs, and never looks up the executable on `PATH`.

**2. Configuration** (`.nexus.json`; each environment variable overrides its
file field):

```json
{
  "lsp": {
    "enabled": true,
    "typescript": {
      "executable": "/absolute/path/to/typescript-language-server",
      "args": ["--stdio"]
    },
    "startupTimeoutMs": 10000,
    "requestTimeoutMs": 10000,
    "idleTimeoutMs": 60000
  }
}
```

| Environment variable | Field | Accepted values |
| --- | --- | --- |
| `NEXUS_LSP_ENABLED` | `enabled` | `true` / `false` (default `false`) |
| `NEXUS_LSP_TYPESCRIPT_EXECUTABLE` | `typescript.executable` | Absolute path (default `null`) |
| `NEXUS_LSP_TYPESCRIPT_ARGS_JSON` | `typescript.args` | JSON array of strings (default `["--stdio"]`) |
| `NEXUS_LSP_STARTUP_TIMEOUT_MS` | `startupTimeoutMs` | 1..60000 (default 10000) |
| `NEXUS_LSP_REQUEST_TIMEOUT_MS` | `requestTimeoutMs` | 1..60000 (default 10000) |
| `NEXUS_LSP_IDLE_TIMEOUT_MS` | `idleTimeoutMs` | 1000..3600000 (default 60000) |

**3. Owner approval (trust store).** The Owner creates the trust store outside
every project and worktree, at `$XDG_CONFIG_HOME/nexus/lsp-trust.json`, or
`$HOME/.config/nexus/lsp-trust.json` when `XDG_CONFIG_HOME` is unset. The
file must belong to the current user with mode `0600`. Parent directories
must not be symlinks or group/world-writable. Nexus only **reads** this file;
it has no approval command and never writes approvals.

```json
{
  "version": 1,
  "approvals": [
    {
      "projectRoot": "/absolute/canonical/worktree",
      "executable": "/absolute/canonical/typescript-language-server",
      "executableSha256": "<sha256 of the executable file bytes, lowercase hex>",
      "args": ["--stdio"],
      "serverVersion": "6.0.2"
    }
  ]
}
```

`projectRoot` and `executable` must be `realpath`-canonical. Each linked Git
worktree needs its own approval. The approval is re-checked before **every**
new server launch, including restarts after idle exit or a crash, so
revocation takes effect at the next launch. Windows is not supported:
owner-only ACL checks are not implemented, so LSP stays `unavailable`.

### Runtime behavior

- Each Nexus runtime (one worktree) owns at most one lazily started server
  process. TS and JS share it, and processes are never shared across
  worktrees. The process starts on the first navigation request, stops after
  `idleTimeoutMs`, and is terminated (bounded SIGTERM, then SIGKILL) on
  runtime close.
- The child runs with `shell: false` and cwd set to the canonical worktree
  root. Its environment is an allowlist: `HOME`, `TMPDIR`, `LANG`, `LC_ALL`,
  and a fixed `PATH` of the Node runtime directory plus `/usr/local/bin`,
  `/usr/bin`, and `/bin`. No other environment variable, including `NODE_*`,
  credentials, proxies, or `NEXUS_*`, is passed through.
- Nexus always sends Automatic Type Acquisition disabled
  (`initializationOptions.disableAutomaticTypingAcquisition: true`) and never
  supplies `npmLocation`. Server requests to edit files
  (`workspace/applyEdit`) are always refused.
- Requests in one runtime run one at a time through a navigation gate. A
  queued request waits at most `startupTimeoutMs + requestTimeoutMs + 1000`
  ms, and never less than 10 s, then returns `timeout` /
  `LSP_REQUEST_TIMEOUT`. This bound covers one cold start plus one request
  ahead of it. Different worktrees are independent.

### Security limitations and residual risks

- **An LSP server is not a sandbox.** It runs with your user's permissions,
  can read any file you can, and loads project code, plugins, and
  configuration. Approve only worktrees and dependency installs you trust.
- **The trust digest pins only the executable file.** It does not pin the
  server's transitive Node packages, the project's TypeScript, or plugins. The
  `serverVersion` value is an Owner assertion. It is not an independent check
  of the code that actually loads.
- **The hash check and spawn are not atomic.** Nexus hashes the executable
  and then spawns it by path, so a file swapped between those two steps
  (time-of-check to time-of-use) is not detected. Keep the executable and its
  parent directories writable only by the Owner.
- **Disabling ATA is not a network boundary.** It turns off the server's
  normal typings download path. It is not an OS-level block on network access
  or npm execution by the child.
- **Stdout is bounded per session, not per message.** A session is ended once
  its cumulative stdout exceeds 64 MiB. Single messages have no separate size
  limit below that budget.
- **Grandchild processes can be orphaned.** After SIGKILL, a `tsserver`
  grandchild started by the language server may be left running, because
  Nexus terminates only its direct child.
- Removing secrets from the child environment does not protect secrets stored
  on disk.

## Index State

`index_status` accepts an empty object. Initial full indexing can run in the background while tools are available. Treat initial indexing as successfully completed only when `indexStats.lastIndexedAt` is non-null and `pipelineProgress.lastError` is absent. A `running` pipeline means search is available but may be incomplete. `structuredIndex` reports schema/generation state and rebuild requirements.

`reindex` accepts optional `fullRebuild` and `reason` (`manual`,
`overflow-recovery`, or `startup-reconciliation`). If indexing is already
running, it reports that state instead of starting a second pipeline. A full
rebuild is not successfully complete while unresolved dead-letter work remains.
During a structured full rebuild, a structured parse failure stops embedding
for the window containing the failure and aborts the rebuild. Earlier windows
may already have been embedded. The failed rebuild leaves the existing index
state intact, throws
`Structured full rebuild aborted: parsing failed for <file>`, and records the
error in pipeline progress and index stats.

## Direct Verification

Run `npm run verify:mcp-tools` from a Source Build checkout to invoke every
registered tool against an isolated temporary fixture. The verifier checks
search results, line context, reindex completion, and structured symbol source
and context. The fixture has no LSP approval, so the three LSP navigation tools
must return `unavailable` with `LSP_NOT_CONFIGURED`, `LSP_TRUST_REQUIRED`, or
`LSP_EXECUTABLE_NOT_APPROVED`. The verifier returns non-zero when any tool or
lifecycle assertion fails.

Use `node scripts/verify-mcp-tools.mjs --json` after `npm run build` when a
machine-readable summary is needed. A cold-start structured-index failure is
reported explicitly rather than being treated as a skipped structured tool.

## HTTP Bridge

`nexus http-bridge` adapts stdio-only MCP clients to a Nexus Streamable HTTP endpoint. Without an explicit URL it discovers or starts the project-scoped loopback server. Transport and managed-server safety invariants are defined in [SPEC.md](../SPEC.md).
