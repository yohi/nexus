# Nexus LSP-Backed Semantic Navigation — Design R0.1.2

**Issue:** [#298 — Add LSP-backed semantic navigation tools](https://github.com/yohi/nexus/issues/298)  
**Date:** 2026-11-08 (JST)  
**Decision:** Human Owner approved the TypeScript/JavaScript-first design direction in brainstorming; this document records that design.  
**Scope:** DESIGN_ONLY; F-006 synchronization state/operation ownership limited documentation correction only. Historical F-001–F-005 and F-007/F-008 decisions remain unchanged. No implementation, test execution, environment change, gate change, or follow-on task authorization.  
**Correction authority:** Owner approved this bounded documentation correction; formal adoption of the revised design is NOT_VERIFIED; implementation remains BLOCKED.  
**Committed GitHub baseline for this correction:** Branch `feature/nexus-lsp-semantic-navigation-design-20261108` at reviewed HEAD `9cb0500b8ca3c96a01cca7a2951645a4cc525d90` (base `master`); Design R0.1.2 Git blob `683833f310d0f91dcf64c21ae913a73e3b33b064` and Implementation Plan R0.1.1 Git blob `c470e37637663b28b5be628665d25140172ebcdc` are the pre-correction baseline. Earlier HEAD/blob values are historical only.
**This correction:** Human Owner approved F-006 contract consolidation and the documentation-only Commit/Push. Formal design adoption and implementation remain unapproved; GitHub publication of this amendment must be confirmed by the actual resulting commit, not this draft.  
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
- `src/lsp/target-resolver.ts`: delegate `symbolId` resolution to the new internal `SymbolRetrievalService.resolveVerifiedNavigationTarget()` and separately validate explicit current-source file/position.
- `src/lsp/process-manager.ts`: lazy startup, shared in-flight startup, approved child-process execution, stdin/stdout handoff, process lifetime, cancellation and teardown; does **not** create or listen on an LSP connection.
- `src/lsp/protocol-client.ts`: sole owner of `createMessageConnection`, `StreamMessageReader`/`StreamMessageWriter`, the single `connection.listen()` call, LSP message processing and negotiated document synchronization.
- `src/lsp/result-validator.ts`: URI/range containment, current disk checks, partial-result reporting.
- `src/server/tools/get-lsp-navigation.ts`: common executor called by the three public handlers.

`SymbolRetrievalService` owns the internal `resolveVerifiedNavigationTarget()` entry point and TS AST identifier-token lookup (`6.1`); its existing `verifySymbol()` stays private. The navigation service must not duplicate catalog verification or guess another symbol identity. The provider/transport seam is the following exact internal interface:

```typescript
type LspNavigationKind = 'definition' | 'references' | 'implementations';
// LSP text-document IDs are distinct from the Structured Catalog's parser/language IDs.
type LspDocumentLanguageId = 'typescript' | 'typescriptreact' | 'javascript' | 'javascriptreact';
interface ILspProvider {
  start(input: {
    rootUri: string;
    expectedServerVersion: '6.0.2'; // passed from Owner-approved ApprovedLspLaunch.serverVersion
    signal?: AbortSignal;
  }): Promise<{
    definition: boolean; references: boolean; implementations: boolean;
    positionEncoding: 'utf-16';
  }>;
  // The caller supplies validated current disk text; the Protocol Client owns kind/version.
  syncDocument(input: {
    uri: string; languageId: LspDocumentLanguageId; text: string;
  }): Promise<void>;
  closeDocument(input: { uri: string }): Promise<void>;
  navigate(input: {
    kind: LspNavigationKind; uri: string;
    position: { line: number; character: number }; // LSP 0-based UTF-16
    signal?: AbortSignal;
  }): Promise<null | readonly (Location | LocationLink)[]>;
  shutdown(): Promise<void>;
}
// Exported by src/lsp/protocol-client.ts (Task 5); no untrusted version text in error messages.
class LspServerVersionMismatchError extends Error {
  readonly reasonCode = 'LSP_EXECUTABLE_NOT_APPROVED' as const;
}
// Internal to the Protocol Client; mapped to unavailable by the Process Manager.
class LspSyncUnsupportedError extends Error {
  readonly reasonCode = 'LSP_SYNC_UNSUPPORTED' as const;
}
```

`Location` and `LocationLink` are types from `vscode-languageserver-protocol`. `RuntimeLocalLspManager` owns the concrete `ILspProvider`, never an MCP client/handler. **F-006 Owner decision:** `ILspProvider.syncDocument({uri,languageId,text})` receives only validated full current disk text. The Protocol Client alone decides first-open versus subsequent-change and document versions from its synchronized per-URI state; `closeDocument({uri})` handles closure. Callers must never supply `kind` or `version`. The Protocol Client adapts the full text to the negotiated LSP synchronization format. The Process Manager supplies the approved child process stdin/stdout and owns its lifetime; the Protocol Client alone creates/listens on one connection for that process. Neither component may duplicate `createMessageConnection()` or `listen()`. For F-003, the manager obtains `expectedServerVersion` **only** from the successful Owner-approved `ApprovedLspLaunch.serverVersion` returned by the trust gate and passes it unchanged to `ILspProvider.start()`. The protocol client compares any explicitly reported `InitializeResult.serverInfo.version` with that exact expected value; omission is allowed. An explicit nonmatching value (including malformed/non-string values) raises an internal `LspServerVersionMismatchError` with fixed `reasonCode: 'LSP_EXECUTABLE_NOT_APPROVED'`. The manager catches this specific error, terminates the failed provider/child and returns the existing public `unavailable` / `LSP_EXECUTABLE_NOT_APPROVED` outcome without navigation. This error is not a new public status and is not a general protocol-error fallback.

**F-005 — exact LSP document-ID conversion:** `src/lsp/target-resolver.ts` owns `lspDocumentLanguageIdForPath(filePath: string): LspDocumentLanguageId | null`. Match the normalized project-relative file extension (case-sensitive) with the following exhaustive table; do not infer the LSP ID from the Structured Catalog's `languageId`:

| File extension | `LspDocumentLanguageId` |
| --- | --- |
| `.ts`, `.mts`, `.cts` | `typescript` |
| `.tsx` | `typescriptreact` |
| `.js`, `.mjs`, `.cjs` | `javascript` |
| `.jsx` | `javascriptreact` |

Both verified-`symbolId` and explicit `filePath`/position targets use this **same** conversion after resolving/validating the current file path. Unknown extensions return `unsupported` before `didOpen` and do not guess a language. The existing Structured Catalog `languageId` field, indexed identity, parser semantics, and stored records are unchanged.

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
    | 'index_incomplete' | 'not_indexed' | 'degraded' | 'excluded' | 'unsupported'
    | 'unavailable' | 'timeout' | 'cancelled' | 'error';
  capability: 'supported' | 'unsupported' | 'unavailable' | 'not_checked';
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
- Pre-launch identity failures use `capability: 'not_checked'` (not `unavailable`); a missing/index-incomplete source is different from a missing server. Underlying Structured `failed` outcomes become a sanitized `error`, and `not_indexed` / `degraded` remain separate public statuses.
- The `not_found` status refers to an unresolved input identity/file, not to a valid zero-match navigation result.
- `sourceValidation: 'verified'` means returned file positions were checked against current disk bytes; it **does not** prove complete project-wide semantic freshness or soundness of the language server.
- An `ok` result may be `partial` if some LSP locations cannot be safely returned. Report `excludedResultCount`; never silently present an incomplete result as exhaustive.
- Invalid MCP arguments are returned via existing tool error handling; expected runtime/domain outcomes use structured statuses with stable reason codes, not raw language-server stderr.
- Do not return raw host absolute paths, file contents, or unredacted process errors in a public error/status field.
- Maintain deterministic sorting and de-duplication of returned locations.

## 6. Target resolution, coordinates, and source authority

### 6.1 Verified `symbolId` — F-001

Existing `SymbolRetrievalService.verifySymbol()` is **private**, and `getSymbolSource()` does not return declaration location. Implement this **new internal** method on the existing service, reusing the private method instead of exposing its return type or independently duplicating hash checks:

```typescript
interface VerifiedSymbolNavigationTarget {
  readonly symbolId: string;
  readonly filePath: string; // normalized project-relative
  readonly languageId: 'typescript' | 'javascript'; // Structured Catalog ID, NOT LSP document languageId
  readonly position: {
    readonly line: number;      // Nexus 1-based
    readonly character: number; // UTF-16, 0-based
  };
  readonly fileSha256: string;
  readonly generationId: string;
}
type VerifiedSymbolNavigationResult =
  | { readonly status: 'ok'; readonly target: VerifiedSymbolNavigationTarget }
  | { readonly status:
      'stale_identity' | 'stale' | 'not_found' | 'not_indexed' |
      'index_incomplete' | 'excluded' | 'unsupported' |
      'degraded' | 'error' | 'cancelled';
      readonly reasonCode: string; readonly reindexRequired: boolean };
class SymbolRetrievalService {
  resolveVerifiedNavigationTarget(input: {
    symbolId: string; signal?: AbortSignal;
  }): Promise<VerifiedSymbolNavigationResult>;
}
```

The new method calls private `verifySymbol({ symbolId, signal })` for existing active-generation, retirement, parser/index state, exclusion, file SHA-256, and exact declaration-slice SHA-256 checks. Also require `declaration.isExact`, read/verify the active generation ID and guard against its change, and verify the resolved source file remains within `PathSanitizer.resolveExisting()` canonical project-root containment **before launching** the LSP. Do not treat a textually similar symbol as a valid replacement.

**AST identifier responsibility:** inside `SymbolRetrievalService`, reuse the TypeScript compiler API already in the repository to parse the verified current bytes. Find the uniquely corresponding declaration by indexed `kind`, `qualifiedName`, `signatureDiscriminator` and bounded indexed declaration range/occurrence; take the AST declaration's *name token* (identifier/private identifier), not the declaration's leading `export`, modifier, decorator or keyword. Validate token/name and byte bounds against the verified declaration and source; convert the token start to Nexus 1-based line/0-based UTF-16 character. Recheck file hash and active generation before returning `target`. If a unique token cannot be demonstrated, refuse to navigate (`degraded` / `IDENTIFIER_TOKEN_UNRESOLVED`), never guess a text occurrence. `LspNavigationService` alone translates Nexus line to LSP zero-based line.

| Condition | Public status / reasonCode |
| --- | --- |
| Retired / absent symbol | `stale_identity` / `SYMBOL_RETIRED`; `not_found` / `SYMBOL_NOT_FOUND` |
| Missing baseline | `not_indexed` / `STRUCTURED_INDEX_MISSING` |
| Pending/missing generation or symbol-hash inconsistency | `index_incomplete` / existing `INDEX_PENDING_GENERATION`, `INDEX_GENERATION_MISSING`, `INDEX_SYMBOL_HASH_MISMATCH` |
| Missing/changed file or generation race | `stale` / `INDEX_FILE_MISSING` or `INDEX_FILE_HASH_MISMATCH` |
| Excluded source | `excluded` / `PATH_EXCLUDED` |
| Unsupported parser/language | `unsupported` / `unsupported_language` or `STRUCTURED_SCHEMA_UNSUPPORTED` |
| Partial parser coverage, nonexact declaration, unresolved/ambiguous token | `degraded` / `PARSER_COVERAGE_PARTIAL` or `IDENTIFIER_TOKEN_UNRESOLVED` |
| Unexpected parse/invariant fault | `error` / `PARSE_ERROR` or `INVARIANT_VIOLATION` |
| Cancelled verification | `cancelled` / `REQUEST_CANCELLED` |

Maintain the existing failure's `reindexRequired` where meaningful; AST ambiguity alone uses `false`. All non-`ok` responses have no target and use public `capability: 'not_checked'`. The `filePath + position` route (`6.2`) bypasses catalog identity safely for saved dirty/unindexed source; it must not reassign a stale `symbolId`.

### 6.2 Explicit file and position

Accept saved, dirty on-disk files even when their structured catalog generation is stale or absent. Validate the path lexically and by realpath, enforce project-root containment and configured exclusions, read the current UTF-8 source, then check the UTF-16 character offset and line bounds.

Resolve `LspDocumentLanguageId` using the **same** `lspDocumentLanguageIdForPath(filePath)` mapping defined in §4 for both `symbolId` and file/position inputs. Keep Catalog language IDs separate; unsupported extensions fail closed without an LSP request.

The input contract uses 1-based lines and 0-based UTF-16 characters. Convert to standard LSP zero-based lines and the negotiated position encoding. Initially advertise/require UTF-16; fail with `unsupported` if the server selects an unsupported encoding. Cover non-BMP Unicode, CRLF, empty lines, and position zero in tests.

### 6.3 Document synchronization and consistency

The authoritative input is disk, not an editor buffer. The Protocol Client parses `InitializeResult.capabilities.textDocumentSync` before any document synchronization: numeric `TextDocumentSyncKind.Full` (1) or `Incremental` (2) implicitly allow open/close; an options object requires `openClose === true` **and** `change` equal to Full (1) or Incremental (2). Options with `openClose` false **or omitted**, absent/None (0)/unknown change kinds, and missing synchronization capability are unsupported. The pinned `typescript-language-server@6.0.2` advertises numeric Incremental (2). Unsupported synchronization raises `LspSyncUnsupportedError` and is mapped by the Manager to `unavailable/LSP_SYNC_UNSUPPORTED`, with child cleanup and no navigation.

**Unique state owner — Protocol Client:** Each process/Connection creates a fresh, isolated per-URI synchronized-document map of `{languageId, text, version}`, and a per-URI FIFO operation queue. `syncDocument({uri,languageId,text})` never accepts caller-selected `kind` or `version`. On an unknown URI it sends a single `didOpen` containing full current disk text, mapped `languageId`, and version `1`; only after successful local send/queue does it record the state. On an already-open URI with unchanged `languageId` and identical text, it emits no duplicate `didOpen` or spurious change. With changed text, it emits `didChange` at `previousVersion + 1` and updates its own snapshot only after successful local send/queue. A language ID contradiction for an open URI is refused rather than silently reopening or changing its identity. `closeDocument({uri})` sends `didClose` for a tracked URI in the same queue, and retires that URI's state; repeated close on an untracked URI is a safe no-op. A legitimate subsequent open begins a new document lifetime at version `1`.

For a Full (1) server, `didChange.contentChanges` is `[{text:newText}]`. For an Incremental (2) server, replace the **previously synchronized** complete document with `[{range:{start:{line:0,character:0},end:previousDocumentEnd},text:newText}]`; compute `previousDocumentEnd` from the saved **old** text in zero-based UTF-16 coordinates. CRLF is a single line break, not part of the final line's character count; non-BMP code points occupy two UTF-16 code units. An unranged full-text `didChange` is forbidden for Incremental. Versions are monotonically increasing within each open document lifetime; queued changes cannot overtake one another.

The Protocol Client serializes `syncDocument`, `closeDocument`, and `navigate` per URI. `navigate` cannot run while a preceding synchronization is pending or after synchronization failure, and requires an open, successfully locally-sent snapshot. Task 7 resolves/validates current disk content, calls `syncDocument` and then `navigate`, and checks source snapshots before/after; it never guesses the `didOpen`/`didChange` kind or version. A local send/queue failure marks the provider session unusable for navigation; the Manager closes that child and reports an LSP-local `error/LSP_PROTOCOL_ERROR` (unless a more specific existing typed failure applies). No stale cached synchronized state can authorize navigation. After process exit/restart a **new** Protocol Client/Connection starts with an empty map, so the next sync is `didOpen` version `1` and no version/state carries over. LSP notification send success is **not** proof that the server has applied changes.

Apply cancellation and finite request deadlines. Check the relevant current disk snapshots before and after an LSP request and validate returned locations (file URI, root containment, range bounds, current file contents). If target files change during a request or the source cannot be validated, return an explicit `stale`/partial/unknown result rather than claiming freshness.

The LSP may internally analyze additional project files asynchronously; neither `didChange` nor disk hashes prove the server has incorporated *all* concurrent changes. Treat LSP semantic answers as **live observations**, with bounded verification claims. Do not manufacture a universal "workspace fully synchronized" guarantee. No semantic edges are persisted.

## 7. Runtime-local LSP lifecycle and capability negotiation

### 7.1 Protocol and version ownership — F-002

**Pinned initial implementation choice:** direct dependency `vscode-languageserver-protocol@3.18.4`, using the Microsoft Node-side protocol/transport exports from `vscode-languageserver-protocol/node`. Its compatible `vscode-jsonrpc@9.0.3` family is the messaging implementation **as a transitive dependency**, not an independently selected duplicate JSON-RPC stack. `RuntimeLocalLspManager` spawns and manages the Owner-approved child process, then hands its stdin/stdout streams to `src/lsp/protocol-client.ts`. The Protocol Client (not the Manager) creates the sole `createMessageConnection` backed by `StreamMessageReader(child.stdout)` and `StreamMessageWriter(child.stdin)`, registers handlers and calls `listen()` exactly once. No second Connection/listener is permitted. Use the package's typed LSP messages, cancellation tokens, and error responses. Do not implement JSON-RPC framing manually or depend on VS Code extension-host-only `vscode-languageclient`.

Initial server: **`typescript-language-server@6.0.2` (major 6)**, externally installed and owner-approved; target project TypeScript 5.9.x. v6 requires Node >=22.22.2, compatible with Nexus Node >=24. Pin the integration fixture server; Python is later. Official version/API evidence: [Microsoft 3.18.4 / JSON-RPC 9.0.3 release notes](https://github.com/microsoft/vscode-languageserver-node/blob/main/README.md), [Node JSON-RPC transport](https://www.npmjs.com/package/vscode-jsonrpc), [TypeScript LSP 6.0.2](https://github.com/typescript-language-server/typescript-language-server/releases/tag/v6.0.2).

### 7.2 Client-to-server and result contracts — F-002

| LSP method | Owner and exact behavior |
| --- | --- |
| `initialize`, `initialized` | Protocol Client sends initialize request then initialized notification; canonical `rootUri` and one worktree folder; advertise UTF-16/static navigation, `dynamicRegistration=false`, then interpret the server-returned `textDocumentSync` kind/options before document synchronization (no assumption that the server supports un-ranged full changes) |
| `textDocument/didOpen` | Protocol Client `syncDocument({uri,languageId,text})` sends a single initial full-text open at version 1 for an untracked URI; the client records state after successful local send. `.tsx`/`.jsx` retain the React-specific IDs (§4). |
| `textDocument/didChange` | Protocol Client detects changed text for an already-open URI, increments its stored version and sends `[{text}]` for Full (1) or `[{range:{start:(0,0),end:previousDocumentEnd},text}]` for Incremental (2), using **previous** text in UTF-16; unchanged text sends no change. Per-URI operations are FIFO. |
| `textDocument/didClose` | `closeDocument({uri})` sends close at most once for a tracked URI, in the same per-URI queue, then retires its state; restart creates a fresh Protocol Client map. |
| `textDocument/definition` | `navigate(definition)` with validated position |
| `textDocument/references` | `navigate(references)`, `context.includeDeclaration=true` |
| `textDocument/implementation` | `navigate(implementations)` with validated position |
| `$/cancelRequest` | Library-managed notification for cancellation/deadline, keyed to the actual outstanding request |
| `shutdown`, `exit` | On idle/runtime close: request shutdown, then exit notification, then bounded force termination if needed |

The Protocol Client must reject absent/None/unsupported synchronization; for an options-based response it requires **explicit** `openClose:true` and Full (1) or Incremental (2) `change`—`openClose:false` **or missing** is rejected. The client throws internal `LspSyncUnsupportedError` (`reasonCode:'LSP_SYNC_UNSUPPORTED'`); the Process Manager maps it to `unavailable/LSP_SYNC_UNSUPPORTED` and closes the child with zero navigation. The F-006-approved `ILspProvider` document methods take neither `kind` nor `version`; only the client owns those decisions.

Use the `initialize` response's `definitionProvider`, `referencesProvider` and `implementationProvider` booleans/options separately; unsupported capability => `unsupported` / `LSP_CAPABILITY_UNSUPPORTED`. No approved executable or failed spawn => `unavailable` / `LSP_NOT_CONFIGURED` or `LSP_START_FAILED`; unexpected protocol/transport error => `error` / `LSP_PROTOCOL_ERROR`; deadline => `timeout` / `LSP_REQUEST_TIMEOUT`; cancellation => `cancelled` / `REQUEST_CANCELLED`. Return no guessed semantic locations.

`textDocument/definition` and `textDocument/implementation` may produce `null`, a single `Location`, `Location[]` or `LocationLink[]`; `references` produces `null` / `Location[]`. Normalize `null` to empty `[]` with `status:'ok'` (not unsupported). For `Location` take `uri` and `range`; for `LocationLink` take `targetUri` and **`targetSelectionRange`**, verifying its inclusion inside `targetRange`. Invalid mixed/unknown shapes => `error` / `LSP_PROTOCOL_ERROR`. Validate each result as an existing, nonexcluded in-worktree file and current range, deduplicate and sort, then apply bounded-result/truncation rules from `5–6`. Out-of-root/excluded locations are omitted with explicit `excludedResultCount` and `sourceValidation:'partial'`; do not claim exhaustive results.

### 7.3 Server-originated messages — F-002

Set inbound request handlers **before** `connection.listen()` and deny by default:

- `workspace/configuration`: supported read-only handler, reply with one `null` per requested configuration item (no env/config/secrets disclosed); advertise `workspace.configuration=true`.
- `workspace/workspaceFolders`: reply with the **single canonical current worktree** and no sibling roots.
- `workspace/applyEdit`: always respond `{ applied: false, failureReason: 'Nexus LSP is read-only' }`. No workspace edit or source mutation.
- `window/showMessageRequest`: respond `null` without a UI.
- `window/showDocument`: respond `{ success: false }`; do not launch a UI.
- `client/registerCapability`, `client/unregisterCapability`, unsolicited progress-creation, and unknown/unadvertised server requests: reject with JSON-RPC `MethodNotFound`. Dynamic registration is not advertised.
- `textDocument/publishDiagnostics`, `window/logMessage`, `window/showMessage`, `$/progress` notifications: safely consume/ignore with sanitized diagnostics; no side effects.

Server-initiated commands/file operations must never be executed. Refusal or protocol failure is LSP-local and cannot stop existing non-LSP tools.

### 7.4 Config structure, precedence and lifecycle — F-003

Add `lsp: LspConfig` to the existing `Config` type in `src/types/index.ts` and load/validate it through `src/config/index.ts`. Exact designed shape:

```typescript
interface LspConfig {
  enabled: boolean; // default false
  typescript: {
    executable: string | null; // default null; absolute path only
    args: string[];            // default ['--stdio']
  };
  startupTimeoutMs: number; // default 10000, accepted 1..60000
  requestTimeoutMs: number; // default 10000, accepted 1..60000
  idleTimeoutMs: number;    // default 60000, accepted 1000..3600000
}
```

`.nexus.json` structure (a config request, **not** owner execution approval):

```json
{
  "lsp": {
    "enabled": true,
    "typescript": {
      "executable": "/opt/nexus-lsp/bin/typescript-language-server",
      "args": ["--stdio"]
    },
    "startupTimeoutMs": 10000,
    "requestTimeoutMs": 10000,
    "idleTimeoutMs": 60000
  }
}
```

**Per-field precedence:** process env > `.nexus.json` > defaults (existing `loadConfig` convention). Exact environment variable names: `NEXUS_LSP_ENABLED` (strict true/false), `NEXUS_LSP_TYPESCRIPT_EXECUTABLE`, `NEXUS_LSP_TYPESCRIPT_ARGS_JSON` (JSON array of strings), `NEXUS_LSP_STARTUP_TIMEOUT_MS`, `NEXUS_LSP_REQUEST_TIMEOUT_MS` and `NEXUS_LSP_IDLE_TIMEOUT_MS`. A configured alternative `LoadConfigOptions.configFileName` retains the file tier. LSP-only invalid config is `unavailable` / `LSP_CONFIG_INVALID` without failing existing search tools. Neither env nor `.nexus.json` can override independent Owner trust (`8.1`).

Manager ownership is **per NexusRuntime/projectRoot**. Construct with `src/server/runtime-assembly.ts`, hold via internal `NexusRuntimeOptions`, and close in runtime `close()` and initialization rollback. Before spawning: validate input/target, effective config, approved executable and trusted worktree. Launch lazily (`shell:false`, root cwd); coalesce starts; initialize; sync on-disk document; capability-check; navigate; verify results. One TS/JS process per runtime; no cross-worktree sharing. On idle timeout/exit/crash close open documents where possible, send shutdown/exit, clean child and timers with bounded termination; cancelled request IDs must not be reused against late responses. No auto-install, `npx` fallback, command lookup from PATH, Global Manager or new repository identity.

## 8. Security and failure isolation

LSP can load code/plugins/configuration and access local files: **LSP is not an OS sandbox**. The following decisions are fail-closed, independent of `.nexus.json` and env.

### 8.1 Trusted worktree + Owner-approved executable — F-003

Before each lazy spawn require both:

1. Canonical `realpath(projectRoot)` exactly appears in an owner-controlled trust store **outside all project/worktree roots**. Linked worktrees need separate exact-root approvals; never trust by branch name or shared Git metadata.
2. Configured executable is an **absolute** path to an existing regular executable, canonicalized through `realpath`, and its canonical path, SHA-256 of executable file bytes, exact ordered `args` and approved server version match the trust entry. No arbitrary PATH lookup or shell resolution.

Trust-store path on POSIX: `$XDG_CONFIG_HOME/nexus/lsp-trust.json` (fallback `$HOME/.config/nexus/lsp-trust.json`); require ownership by current user, file mode `0600`, secure non-group/world-writable parent directories, and reject symlink trust-store or parent escape. On Windows use `%APPDATA%/Nexus/lsp-trust.json` only if equivalent restrictive owner-only ACL checks are implemented; otherwise LSP is unavailable. Nexus **reads** this store only; owner provisions/updates it out of band. No new approval-writing CLI, automatic permission prompt, or implicit worktree approval. Project-local `.nexus.json` cannot serve as a trust record.

```json
{
  "version": 1,
  "approvals": [
    {
      "projectRoot": "/absolute/canonical/worktree",
      "executable": "/absolute/canonical/typescript-language-server",
      "executableSha256": "<64 lowercase hex characters>",
      "args": ["--stdio"],
      "serverVersion": "6.0.2"
    }
  ]
}
```

**F-003 — Owner-approved version-assurance boundary:** Before **any execution**, validate the canonical worktree root, absolute executable path and canonical target, executable-byte SHA-256, exact ordered args, and Owner-maintained `serverVersion: "6.0.2"` metadata against the trusted approval record. The approved version is an **Owner assertion bound to the reviewed executable digest**, not an independently observed runtime version; no unapproved `--version` probe is allowed. Missing/unreadable/unsafe trust data => `unavailable` / `LSP_TRUST_REQUIRED`; path/digest/args/approval-version mismatch => `unavailable` / `LSP_EXECUTABLE_NOT_APPROVED`. No child starts on denied approval.

After the Owner-approved launch, `RuntimeLocalLspManager` passes `ApprovedLspLaunch.serverVersion` unchanged as `ILspProvider.start({ rootUri, expectedServerVersion: '6.0.2', signal })`. The `ILspProvider` protocol client examines the LSP `initialize` response **before returning capabilities or allowing navigation**: successful protocol initialization, negotiated UTF-16 and advertised capabilities are still required. **Do not require `InitializeResult.serverInfo.version`: `typescript-language-server@6.0.2` does not provide that field.** The exact three outcomes are: (1) `serverInfo.version === expectedServerVersion` -> version check passes; (2) `serverInfo` or its `version` property is missing -> version check passes without claiming an independent version attestation; (3) `version` is explicitly present but differs from the approved value or is not a valid string -> the client throws `LspServerVersionMismatchError` (`reasonCode: 'LSP_EXECUTABLE_NOT_APPROVED'`), and the manager closes the child and returns `unavailable` / `LSP_EXECUTABLE_NOT_APPROVED`. No successful provider acquisition or navigation is permitted on mismatch. This error is **not** reported as `error/LSP_PROTOCOL_ERROR` or `unsupported`.

The former unconditional post-launch independent running-server-version attestation requirement is **withdrawn by Human Owner decision**; no weaker prelaunch root/path/digest/args/Owner-version check or postlaunch protocol/encoding/capability check is permitted.

**Residual risk:** SHA-256 pins only the approved executable file, not its transitive Node packages, imported project TypeScript modules, plugins or other runtime dependencies. The trust-store version string plus protocol/capability validation **cannot prove the loaded server code is exactly v6.0.2** or that dependencies are immutable. Treat the worktree and dependency installation as trusted input; LSP remains outside an OS sandbox. This documented limit does not authorize unsafe execution, automatic approval, or guessing capability support. Other Nexus retrieval stays operational.

### 8.2 Child process environment and isolation — F-003

Spawn `shell:false` with canonical project-root cwd and an **explicit child environment allowlist**, never raw `process.env`. Initial allowed names: `HOME`, `TMPDIR`, `LANG`, `LC_ALL` and a fixed safe `PATH` containing the trusted Node runtime directory and vetted system directories. Deny `NODE_OPTIONS`, `NODE_PATH`, credentials, API keys, SSH/cloud tokens, proxy environment, arbitrary `NEXUS_*` values, and project-provided environment overrides. Do not inherit ambient PATH for executable selection. Child environment minimization is **not** security isolation against reading credentials from disk; untrusted repositories require a separately approved sandbox.

Reject escaping file paths/symlinks and unapproved file: URIs; honor existing ignore/exclusion rules. Bound process count, requests, result size, timeouts, diagnostics and stderr retention, and sanitize public/logged errors. A failed LSP launch, untrusted root, malformed LSP config, unsupported capability, crash, timeout or rejected server write request must affect **only LSP**. `semantic_search`, `hybrid_search`, `grep_search`, `get_context` and Structured Catalog retrieval continue independently. No source mutation, semantic graph persistence, install/download, or shell command is authorized.

## 9. Validation and acceptance evidence

Test implementation in small, executable units; no broad review/repair cycle is mandated by this design.

**Unit / protocol tests**

- Neutral v1 and v2 schema adapters accept `character: 0` and reject malformed or mixed target shapes.
- `resolveVerifiedNavigationTarget` reuses private verification; TS AST selects a unique identifier, while stale/retired/pending/missing/nonexact/ambiguous identity and changed generation/hash fail closed.
- LSP capability flags are independently respected; an `ok` empty result differs from unsupported/unavailable.
- UTF-16/non-BMP/CRLF/zero positions and LSP URI/range conversions are correct.
- Microsoft protocol/JSON-RPC 3.18.4/9.0.3 covers initialize/initialized, didOpen/didChange/didClose, all three navigation requests, cancel, shutdown/exit, null/Location/LocationLink, and distinct unsupported/error statuses. F-006: protocol-stub tests assert `syncDocument({uri,languageId,text})` has no caller kind/version, first open=version 1, unchanged same-URI sync is a no-op (no duplicate didOpen), changed text produces version 2→3, Full (1) sends unranged `[{text}]` and Incremental (2) sends previous-text full-range `[{range,text}]`, including CRLF/non-BMP UTF-16 EOF. Verify concurrent per-URI operations and navigation FIFO, `closeDocument({uri})` idempotence, local send failure blocks navigation, and a fresh process/Connection restarts with didOpen version 1. Missing/None/unsupported sync and options-based `openClose:false` **or omitted** throw `LspSyncUnsupportedError`, mapped to `unavailable/LSP_SYNC_UNSUPPORTED` with zero navigation; no extra Task series. F-007: verify one Protocol Client Connection and one `listen()` per child, never Manager-created or duplicated.
- Server-originated config/folders are read-only; workspace/applyEdit, showDocument, dynamic registration and unknown requests never mutate files.
- LSP config env > file > defaults; invalid config, disabled LSP, missing trust, mismatched executable SHA/args/Owner-approved version metadata, different worktree, weak trust-store permissions and child-environment secret injection fail closed only for LSP.
- With a protocol stub emulating `typescript-language-server@6.0.2`, cover the exact approved-version comparison outcomes: explicit matching `serverInfo.version` and missing `serverInfo.version` are accepted **only after** approved path/digest/args/root validation and capability/encoding checks; explicit mismatching or malformed version fails closed as `unavailable/LSP_EXECUTABLE_NOT_APPROVED`. Bad capability and bad digest also fail closed. Document that transitive dependencies are not pinned by the executable digest.
- `didOpen` emits the exact four LSP document IDs for `.ts`/`.mts`/`.cts`, `.tsx`, `.js`/`.mjs`/`.cjs`, `.jsx` for **both** navigation target forms; an unknown extension is `unsupported`.
- Startup is coalesced; idle cleanup, abrupt exit, timeout, cancellation, and runtime shutdown close processes.
- Out-of-root, symlink, excluded, deleted, and changed-during-request sources are never represented as verified current locations.

**Integration tests (pinned, installed TypeScript server in controlled test environment)**

- `get_definition`, `get_references`, and `get_implementations` return current TS/JS locations in a small multi-file project.
- Saved uncommitted edits are observed through explicit file/position requests without waiting for structured reindexing.
- A stale catalog `symbolId` is refused and cannot be silently remapped.
- Two divergent sibling worktrees with the same relative file paths receive no cross-worktree document/process/result state.
- A controlled trusted worktree with an Owner-approved `typescript-language-server@6.0.2` executable demonstrates the three operations and safe config/approval flow; no unsupported post-launch server-version assertion is required. F-006: assert numeric Incremental (2) is recognized; the first navigation causes exactly one didOpen (version 1), successive saved on-disk changes produce previous-document-full-range didChange (versions 2→3) and no duplicate didOpen, and navigation occurs only after successful synchronization. Verify correct UTF-16/CRLF behavior and new didOpen version 1 after a controlled new process/Connection. These are future authorized implementation acceptance tests, not tests executed by this document correction.
- Test source files for all eight supported extensions verify the actual `textDocument/didOpen` `languageId`, for both `symbolId`-resolved and explicit file/position inputs where available.
- Failure or absence of TypeScript LSP, invalid trust/config, and rejected server edit requests do not fail unrelated retrieval tools.
- Existing MCP tool registration, verification and runtime-shutdown tests remain compatible with three added tool names.

After the first implementation exists, #320 may incorporate deterministic LSP current-worktree cases and a direct/live LSP baseline. #299 may separately measure startup/request/process overhead. Those are **separate, explicitly authorized tasks**, not additional blockers automatically triggered by this design.

## 10. Documentation, completion, and stopping rules

Update `docs/mcp-tools.md` with the three public contracts and documented statuses as part of implementation, plus language-server prerequisite/config/security guidance. Keep `SPEC.md §6` authoritative and change it only if a concrete inconsistency requires clarification.

The initial implementation meets #298's bounded goal when TS/JS navigation works for all three operations with demonstrated current-worktree behavior, predictable lifecycle, explicit unsupported/unavailable/error statuses, worktree isolation, and preserved non-LSP retrieval. Python is not an initial completion gate.

**Stop / fail closed:** on source-identity ambiguity, out-of-root access, untrusted/unknown executable policy, or unverifiable requested identity, do not invoke or report guessed semantic relationships. A failure isolated to LSP does not halt unrelated search.

**Owner checkpoint:** when implementation evidence and any directly relevant findings are available, the Human Owner decides whether to adopt, make a limited correction, or defer. New findings do not automatically authorize further independent reviews, implementation changes, or follow-on tasks.

## 11. Decision log

- **2026-11-08:** Human Owner selected TypeScript/JavaScript-first, Python second. Generic provider plus runtime-local lazy LSP manager selected. No persistent semantic graph or automated installation.
- **R0.1.1 limited correction:** F-001: verified symbol navigation API/AST token; F-002: pinned protocol/server and complete message responsibilities; F-003: config precedence, independent owner trust and child process limits. This correction is not owner adoption or implementation authorization.
- **R0.1.2 earlier correction (historical):** Human Owner approved withdrawing independent post-launch running-version attestation while preserving SHA-256/Owner trust and protocol/capability checks (F-003); specified four extension-derived LSP `languageId` values (F-005), and corrected Plan Task 1/5 dependency order (F-004). Design R0.1.2 and Plan R0.1.1 were subsequently committed/pushed to the feature branch, culminating in reviewed HEAD `7b3c13f7c0512070c138d79fa0dde03d15220d97` (Design blob `ccd702d4e148a66ecbe3ba99d7dcf0cf8dc81361`, Plan blob `10c995d5c1a204e77bb807ad946b38eedd400b39`). Earlier local/uncommitted notes described their state **at preparation time**, not the committed baseline.
- **F-006–F-008 earlier correction (historical):** Incremental sync, Protocol Client Connection ownership and GitHub baseline accuracy were committed to the feature branch at HEAD `9cb0500b8ca3c96a01cca7a2951645a4cc525d90` (Design blob `683833f310d0f91dcf64c21ae913a73e3b33b064`; Plan blob `c470e37637663b28b5be628665d25140172ebcdc`).
- **F-006 synchronization-contract-only correction:** Human Owner selected Protocol Client-owned didOpen/didChange/didClose and version decisions. The two documentation files may be committed/pushed by explicit Owner authorization; this is not formal design adoption, implementation GO, or evidence of an executed test. F-001–F-005 and F-007/F-008 decisions remain closed.
