# Nexus LSP-Backed Semantic Navigation — Design R0.1

**Issue:** [#298 — Add LSP-backed semantic navigation tools](https://github.com/yohi/nexus/issues/298)  
**Date:** 2026-11-08 (JST)  
**Decision:** Human Owner approved the TypeScript/JavaScript-first design direction in brainstorming; this document records that design.  
**Scope:** DESIGN_ONLY; no implementation, test execution, or follow-on task authorization.  
**Authoritative architecture:** [SPEC.md §6](../../../SPEC.md) and [Issue #296](https://github.com/yohi/nexus/issues/296).

## 1. Intent

Extend Nexus from text/vector/structured code retrieval to **live, worktree-local semantic navigation**. Expose three MCP operations:

- `get_definition`
- `get_references`
- `get_implementations`

A Structured Catalog `symbolId` identifies a declaration; the Language Server Protocol (LSP) supplies semantic relations against the current project files. LSP does **not** make the catalog a reference graph, and results from stale persisted relationships are never used as fallback.

The initial supported language family is TypeScript/JavaScript, with `typescript-language-server` as an externally supplied executable. Python (`basedpyright`) is an explicit *later* language and is not required for the initial issue's implementation completion.

### Goals

1. Resolve definitions, references, and implementations by verified `symbolId` **or** explicit project-relative file/position.
2. Use a language-server-independent provider/transport contract.
3. Run language servers lazily and isolate their mutable state by canonical Nexus runtime/project root (one worktree = one runtime).
4. Represent missing capabilities, launch errors, stale symbol identity, and source-verification limitations explicitly.
5. Preserve independent semantic/vector/text/structured retrieval when LSP is absent or fails.
6. Document language-server prerequisites, process boundaries, and measurable correctness tests.

### Non-goals and anti-goals

- No persistent reference, definition, implementation, call, inheritance, or type graphs.
- No Global Manager, repository/revision identity system, cross-worktree LSP sharing, or mandatory completion of #297 before initial work.
- No automated language-server installation, language-server downloads, or ambient execution of arbitrary configured shell commands.
- No initial Python, hover, type-definition, call-hierarchy, or type-hierarchy implementation.
- No IDE unsaved-buffer synchronization: the *on-disk current worktree*, including uncommitted saved edits, is the source of truth.
- No invented results or silent fallback to catalog/vector edges when a semantic request fails.

## 2. Existing integration points and constraints

The default branch currently exposes nine MCP tools via:

- `src/server/tools/registry/definitions.ts` — common `ToolName`, input schemas, and tool listing.
- `src/server/tools/tool-support.ts` — handlers and existing instrumented result/error paths.
- `src/server/tools/registry/adapters/v1-adapter.ts` and `v2-adapter.ts` — MCP-compatible registration and validation.
- `src/server/runtime-assembly.ts` and `src/server/index.ts` — runtime construction, shutdown, and cleanup.
- `src/structured/retrieval-service.ts` — verified `symbolId` resolution, catalog-generation checks, and source hashes.
- `src/server/path-sanitizer.ts` — canonical root, project-relative paths, and symlink containment.

The current `get_symbol_source` path fails closed if an indexed file/symbol no longer matches the worktree. Reuse that guarantee rather than turning a stale `symbolId` into a best-effort match. For a saved edit that invalidates the catalog, the explicit file/position input provides an independent, current-source navigation path.

Nexus has two MCP schema adapter generations. The existing neutral integer validation assumes positive values, so any `character = 0` input requires **targeted** neutral-schema validation changes and regression tests; do not silently reinterpret zero as one.

## 3. Approaches considered

| Approach | Advantages | Costs / failure modes | Decision |
| --- | --- | --- | --- |
| A. One generic LSP client and runtime-local process manager | Reuses one protocol implementation across languages; keeps catalog small; tests via stub server | Requires lifecycle and document synchronization | **Selected** |
| B. Language-specific semantic analyzers in Nexus | No child LSP process | Duplicates compiler/LSP semantics and grows maintenance cost | Rejected |
| C. Persist semantic edges with Structured Catalog | Potentially fast repeated lookups | Invalidation and cross-worktree stale-result risk; contradicts SPEC §6 | Rejected |

Keep approach A deliberately small: one protocol client, language-command configuration, and navigation coordinator. A larger language-plugin framework is not required for the first implementation.

## 4. Component boundaries

```text
MCP Client
  -> TOOL_DEFINITIONS / v1 or v2 schema adapters
  -> buildToolHandlers() / tool instrumentation
  -> LspNavigationService
       -> CurrentSourceTargetResolver
            -> SymbolRetrievalService + Structured Catalog (symbolId only)
            -> PathSanitizer + current disk source (file/position)
       -> RuntimeLocalLspManager
            -> ILspProvider / JSON-RPC stdio client
                 -> typescript-language-server --stdio
       -> CurrentSourceResultValidator
  -> explicit structured MCP result

Existing semantic / vector / grep / structured retrieval bypasses LSP.
```

Proposed internal responsibilities (file names are design guidance; implementation may choose smaller cohesive modules):

- `src/lsp/contracts.ts`: navigation target, capability/status, location and provider types.
- `src/lsp/navigation-service.ts`: target resolution, request/capability dispatch, result normalization.
- `src/lsp/target-resolver.ts`: verified catalog-identity resolution and current-source file/position validation.
- `src/lsp/process-manager.ts`: lazy startup, shared in-flight startup, transport, cancellation and teardown.
- `src/lsp/result-validator.ts`: URI/range containment, current disk checks, partial-result reporting.
- `src/server/tools/get-lsp-navigation.ts`: common executor called by the three public handlers.

No modification to the existing search orchestrator or source-index persistence model is required. The manager is constructed with the runtime assembly and closed by the runtime cleanup path, including partial-initialization rollback.

## 5. Public MCP contract

Three separate tools remain independently discoverable. Each accepts the same flat target fields because the current neutral MCP schema does not natively express a discriminated object union.

```typescript
interface NavigationToolArgs {
  symbolId?: string;
  filePath?: string;
  line?: number;       // 1-based
  character?: number;  // 0-based UTF-16 code units; 0 is valid
  maxResults?: number; // only meaningful for references; optional bounded default
}
```

The application must enforce **exactly one** target shape:

1. `symbolId` alone; or
2. `filePath` + `line` + `character`, all present.

Mixed/partial target shapes, negative positions, line zero, or invalid identifiers produce a deterministic invalid-input error *before* a language server is launched. `filePath` is project-relative, not an arbitrary absolute path or URI. For the first revision, cap reference results (proposed default 100, hard maximum 1000), with an explicit `truncated` field; definition/implementation results are also bounded by an internal safety limit.

Public output is a tagged result, not an exception-shaped success:

```typescript
interface NavigationLocation {
  filePath: string;  // validated, project-relative
  startLine: number; // 1-based
  startCharacter: number; // 0-based UTF-16
  endLine: number;
  endCharacter: number;
}
interface NavigationResponse {
  status:
    | 'ok' | 'not_found' | 'stale_identity' | 'stale'
    | 'index_incomplete' | 'excluded' | 'unsupported'
    | 'unavailable' | 'timeout' | 'cancelled' | 'error';
  capability: 'supported' | 'unsupported' | 'unavailable';
  locations: NavigationLocation[];
  truncated: boolean;
  sourceValidation: 'verified' | 'partial' | 'unknown';
  reasonCode?: string;
  excludedResultCount?: number;
  reindexRequired?: boolean;
}
```

Contract rules:

- `status: 'ok'` plus an empty `locations` array means the server *supported and processed* the request and found no semantic locations. It is **not** equivalent to `unsupported` or `unavailable`.
- The `not_found` status refers to an unresolved input identity/file, not to a valid zero-match navigation result.
- `sourceValidation: 'verified'` means returned file positions were checked against current disk bytes; it **does not** prove complete project-wide semantic freshness or soundness of the language server.
- An `ok` result may be `partial` if some LSP locations cannot be safely returned. Report `excludedResultCount`; never silently present an incomplete result as exhaustive.
- Invalid MCP arguments are returned via existing tool error handling; expected runtime/domain outcomes use structured statuses with stable reason codes, not raw language-server stderr.
- Do not return raw host absolute paths, file contents, or unredacted process errors in a public error/status field.
- Maintain deterministic sorting and de-duplication of returned locations.

## 6. Target resolution, coordinates, and source authority

### 6.1 Verified `symbolId`

Use the Structured Catalog's active generation, retirement state, and current file/symbol hashes before LSP invocation. A retired, missing, pending, stale, or excluded `symbolId` must return the respective explicit status: never map it to a similar name/declaration.

An indexed declaration's *start* may be on an `export`, decorator, modifier, or keyword rather than its identifier. Therefore identify the actual symbol-name token in the **verified current source** with a language-aware in-memory resolver (TypeScript AST for TS/JS), constrained by the indexed declaration identity/range. If that identity/token cannot be established unambiguously, return an explicit non-success outcome. Do not send the start position blindly or choose a text match heuristically.

### 6.2 Explicit file and position

Accept saved, dirty on-disk files even when their structured catalog generation is stale or absent. Validate the path lexically and by realpath, enforce project-root containment and configured exclusions, read the current UTF-8 source, then check the UTF-16 character offset and line bounds.

The input contract uses 1-based lines and 0-based UTF-16 characters. Convert to standard LSP zero-based lines and the negotiated position encoding. Initially advertise/require UTF-16; fail with `unsupported` if the server selects an unsupported encoding. Cover non-BMP Unicode, CRLF, empty lines, and position zero in tests.

### 6.3 Document synchronization and consistency

The authoritative input is disk, not an editor buffer. For the target document, use `textDocument/didOpen` or `didChange` with full current source and monotonically increasing document versions before requesting navigation. Keep runtime-local document state, not cross-worktree state.

Apply cancellation and finite request deadlines. Check the relevant current disk snapshots before and after an LSP request and validate returned locations (file URI, root containment, range bounds, current file contents). If target files change during a request or the source cannot be validated, return an explicit `stale`/partial/unknown result rather than claiming freshness.

The LSP may internally analyze additional project files asynchronously; neither `didChange` nor disk hashes prove the server has incorporated *all* concurrent changes. Treat LSP semantic answers as **live observations**, with bounded verification claims. Do not manufacture a universal "workspace fully synchronized" guarantee. No semantic edges are persisted.

## 7. Runtime-local LSP lifecycle and capability negotiation

A single `RuntimeLocalLspManager` belongs to one concrete canonical `projectRoot`. Its server processes, open documents, in-flight requests, timers, and cache are scoped exclusively to that runtime. Different linked Git worktrees are separate runtimes regardless of common Git history or branch name.

1. Validate the request and target before attempting process startup.
2. On first supported request, spawn the configured executable directly (argument array, `shell: false`) with project-root working directory.
3. Coalesce concurrent startup requests for the same language/server into one initialization.
4. Perform LSP `initialize` / `initialized`, with `rootUri` and workspace folder restricted to the concrete worktree.
5. Inspect server capabilities independently for definition, references, and implementation; report unavailable/unsupported instead of guessing.
6. Reuse the initialized server while active; optional configurable idle timeout shuts it down.
7. On idle timeout/runtime close, send `shutdown`, then `exit`, then bounded forced process termination if required. Cleanup must also cover startup failure, crash, cancellation, and runtime-assembly rollback.

Default configuration requires an explicit, installed `typescript-language-server --stdio` (and compatible TypeScript runtime). No package auto-installation or automatic fallback to a different executable. Expose config guidance for executable path/arguments and timeouts. If disabled or not installed, existing Nexus retrieval remains available.

Limit aggregate process count and request concurrency *within the runtime* conservatively; do not introduce a global pool or resource manager without #299/#303 measurement evidence.

## 8. Security and failure isolation

Language servers can execute code, load plugins and configuration, and traverse dependencies: **LSP is not an isolation boundary**. Use only trusted project worktrees and owner-approved server executables; running untrusted repositories requires an external sandbox/process isolation policy.

- Reject path traversal and escaping symlinks for request targets and returned locations. Resolve real paths for existing files and normalize file URIs.
- Honor existing ignore/exclusion rules; do not expose excluded files or external dependency paths as normal successful locations. Report omission/partialness.
- Spawn with argument arrays and no shell; do not download servers or grant additional host/network privileges.
- Bound output collection, request duration, concurrent requests, process lifetime, and result counts.
- Cancellation must terminate the request and leave reusable process state coherent; a wedged server may be restarted lazily for later requests.
- Sanitize logged exceptions and child stderr. Do not leak secrets from environment, path, or file content through a status.
- LSP launch failure, unsupported operation, crash, and timeout must not prevent `semantic_search`, `hybrid_search`, `grep_search`, `get_context`, or Structured Catalog tools from operating.

## 9. Validation and acceptance evidence

Test implementation in small, executable units; no broad review/repair cycle is mandated by this design.

**Unit / protocol tests**

- Neutral v1 and v2 schema adapters accept `character: 0` and reject malformed or mixed target shapes.
- Verified `symbolId` maps to an identifier token; stale/retired/pending/missing identities are fail-closed.
- LSP capability flags are independently respected; an `ok` empty result differs from unsupported/unavailable.
- UTF-16/non-BMP/CRLF/zero positions and LSP URI/range conversions are correct.
- Startup is coalesced; idle cleanup, abrupt exit, timeout, cancellation, and runtime shutdown close processes.
- Out-of-root, symlink, excluded, deleted, and changed-during-request sources are never represented as verified current locations.

**Integration tests (pinned, installed TypeScript server in controlled test environment)**

- `get_definition`, `get_references`, and `get_implementations` return current TS/JS locations in a small multi-file project.
- Saved uncommitted edits are observed through explicit file/position requests without waiting for structured reindexing.
- A stale catalog `symbolId` is refused and cannot be silently remapped.
- Two divergent sibling worktrees with the same relative file paths receive no cross-worktree document/process/result state.
- Failure or absence of TypeScript LSP does not fail unrelated retrieval tools.
- Existing MCP tool registration, verification and runtime-shutdown tests remain compatible with three added tool names.

After the first implementation exists, #320 may incorporate deterministic LSP current-worktree cases and a direct/live LSP baseline. #299 may separately measure startup/request/process overhead. Those are **separate, explicitly authorized tasks**, not additional blockers automatically triggered by this design.

## 10. Documentation, completion, and stopping rules

Update `docs/mcp-tools.md` with the three public contracts and documented statuses as part of implementation, plus language-server prerequisite/config/security guidance. Keep `SPEC.md §6` authoritative and change it only if a concrete inconsistency requires clarification.

The initial implementation meets #298's bounded goal when TS/JS navigation works for all three operations with demonstrated current-worktree behavior, predictable lifecycle, explicit unsupported/unavailable/error statuses, worktree isolation, and preserved non-LSP retrieval. Python is not an initial completion gate.

**Stop / fail closed:** on source-identity ambiguity, out-of-root access, untrusted/unknown executable policy, or unverifiable requested identity, do not invoke or report guessed semantic relationships. A failure isolated to LSP does not halt unrelated search.

**Owner checkpoint:** when implementation evidence and any directly relevant findings are available, the Human Owner decides whether to adopt, make a limited correction, or defer. New findings do not automatically authorize further independent reviews, implementation changes, or follow-on tasks.

## 11. Decision log

- **2026-11-08:** Human Owner selected TypeScript/JavaScript-first, Python second. Generic provider plus runtime-local lazy LSP manager selected. No persistent semantic graph or automated installation.
- This document is a committed *design artifact*, not evidence that implementation, integration tests, deployment, or correctness benchmarking have run.
