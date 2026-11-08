# Nexus LSP Semantic Navigation Implementation Plan — Limited Revision R0.1.1

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` **only after a separate Human Owner authorization for implementation**. Steps use checkbox (`- [ ]`) syntax for tracking. **Do not auto-dispatch any tasks or reviewers from this plan.**

**Goal:** Add live current-worktree `get_definition`, `get_references`, and `get_implementations` MCP operations for TypeScript/JavaScript while keeping Structured Catalog limited to stable symbol identity and location.

**Architecture:** An MCP navigation handler calls `LspNavigationService`, which verifies a `symbolId` through `SymbolRetrievalService` or reads an explicit current-source file/position, then calls a runtime-local lazy `ILspProvider` backed by a Microsoft LSP/JSON-RPC stdio client. A separate trust guard authorizes an executable before spawning it; returned locations are validated against the current worktree and never stored as semantic edges.

**Tech Stack:** TypeScript 5.9.x, Node.js >=24, existing MCP v1/v2 registry and Vitest, TypeScript compiler AST, `vscode-languageserver-protocol@3.18.4` (transitive compatible `vscode-jsonrpc@9.0.3`), externally installed `typescript-language-server@6.0.2` for controlled integration tests.

**Spec:** `docs/superpowers/specs/2026-11-08-nexus-lsp-semantic-navigation-design.md`, Design R0.1.2 **local correction** (F-003/F-005); its R0.1.1 source blob is `932587eecab736a7cbad56c15727687b31905783` on `feature/nexus-lsp-semantic-navigation-design-20261108` at reviewed HEAD `b07f5337b3c0f03b444a7a58cb7cca0227aa948e`. Do not infer that revised documents are already on GitHub.

**Related:** Issue [#298](https://github.com/yohi/nexus/issues/298), `SPEC.md` §6; #296 is completed; #297 is related validation, not a prerequisite for this implementation.

**Plan status:** `DRAFT_FOR_OWNER_DECISION` (F-003–F-005 limited local correction). Design R0.1.2 formal adoption is `NOT_VERIFIED`; implementation remains `BLOCKED`. This corrected local copy is **not committed**, not a test result, and not authorization to execute; the original R0.1.1 plan exists at HEAD `b07f5337b3c0f03b444a7a58cb7cca0227aa948e`.

## Global Constraints

- Initial language family: TypeScript/JavaScript **only**. Python/basedpyright is later and is not part of the initial exit criteria.
- Three MCP tools: `get_definition`, `get_references`, `get_implementations`. `symbolId` **or** project-relative `filePath` + 1-based `line` + 0-based UTF-16 `character`; reject mixed and partial targets.
- No persisted reference/definition/implementation/call/type graph; no Global Manager, new repo/revision identity, language server auto-install, shell execution, Python implementation, or ambient PATH resolution.
- LSP is local to the **canonical runtime/projectRoot**, independent of all sibling worktrees. Saved dirty disk files are valid explicit-position inputs; stale `symbolId` must fail closed.
- Use `vscode-languageserver-protocol@3.18.4` through its Node exports and the compatible JSON-RPC 9.0.3 dependency family. Do not build custom framing or add a second incompatible JSON-RPC dependency.
- Server: approved `typescript-language-server@6.0.2` / major 6; Node >=24 in Nexus. No unapproved executable is launched.
- LSP configuration is per-field **environment > `.nexus.json` > defaults**, but execution approval is **outside both**. Default `enabled: false`; `startupTimeoutMs=10000`, `requestTimeoutMs=10000`, `idleTimeoutMs=60000` with spec bounds.
- Trust store is read-only to Nexus and outside worktrees. Before spawn validate canonical root, canonical executable, executable-byte SHA-256, exact argv and Owner-approved `serverVersion: "6.0.2"` metadata, owner and permissions; no implicit trust or approval-writing CLI. No runtime `serverInfo.version` is required; after launch validate LSP protocol, UTF-16 encoding and advertised capabilities. Missing/invalid approval makes only LSP unavailable; the digest does not pin transitive runtime packages.
- Spawn with `shell:false`, canonical cwd and allowlisted child env; do not forward secrets. Child access to disk remains a residual risk, not an isolation claim.
- Incoming `workspace/applyEdit`, `window/showDocument`, dynamic capability registration and unknown server-initiated requests do not mutate files; reject/deny as specified in Design §7.3.
- Fail closed for ambiguous declaration identity, escaping paths, unverified positions, races and unsupported capability. Public statuses/`reasonCode` must be distinct from successful empty results.
- Before **any actual implementation**, Human Owner must authorize a concrete task scope. One bounded verification and Owner checkpoint after implementation; do not automatically start repeated independent review/fix/review loops.

## Review Focus (tests mapped to owning tasks)

1. **Uncommitted TS edit after indexing:** an old `symbolId` is refused; explicit current file/position still navigates. Covered in Task 3 and Task 8.
2. **Confusable declaration / Unicode position:** overloaded/default export or similarly named nested symbol must not be guessed; `character:0`, non-BMP, and CRLF must survive conversions. Covered in Task 1, Task 3, Task 4.
3. **Server attempts to change files:** `workspace/applyEdit`, capability registration and unknown incoming requests must never cause a workspace mutation. Covered in Task 5 and Task 8.
4. **Approved executable changed or untrusted linked worktree:** deny launch before `spawn`; ambient environment must not reveal secrets. Covered in Task 2 and Task 6.
5. **Concurrent request during shutdown/change:** only one startup, no wrong-worktree result, no stale-as-fresh claim, and existing grep/structured/search still work. Covered in Tasks 4, 6, 7, and 8.

---

## File map and dependency order

| Task | Area | Production files | Verification / docs |
| --- | --- | --- | --- |
| 1 | Public/internal types, pinned protocol dependency and zero-based field validation | Create `src/lsp/contracts.ts`; modify `src/server/tools/registry/adapters/v2-adapter.ts`, `package.json`, `package-lock.json` | `tests/unit/server/tools/registry/adapters/{v1-adapter,v2-adapter}.test.ts` |
| 2 | LSP config and owner trust | Create `src/lsp/trust-policy.ts`; modify `src/types/index.ts`, `src/config/index.ts` | `tests/unit/config/index.test.ts`, create `tests/unit/lsp/trust-policy.test.ts` |
| 3 | Verified `symbolId` to identifier | Create `src/lsp/identifier-locator.ts`; modify `src/structured/retrieval-service.ts` | `tests/unit/structured/retrieval-service.test.ts`, create `tests/unit/lsp/identifier-locator.test.ts` |
| 4 | Explicit position and result validation | Create `src/lsp/target-resolver.ts`, `src/lsp/result-validator.ts` | Create `tests/unit/lsp/{target-resolver,result-validator}.test.ts` |
| 5 | Typed LSP stdio protocol client | Create `src/lsp/protocol-client.ts`; consume the dependency installed in Task 1 (no further package/lockfile edits) | Create `tests/unit/lsp/protocol-client.test.ts`, test-only stub under `tests/fixtures/lsp/` |
| 6 | Runtime-local lazy process manager | Create `src/lsp/process-manager.ts` | Create `tests/unit/lsp/process-manager.test.ts` |
| 7 | Navigation orchestration and three MCP tools | Create `src/lsp/navigation-service.ts`, `src/server/tools/get-lsp-navigation.ts`; modify `src/server/tools/{types,tool-support}.ts`, `src/server/tools/registry/definitions.ts` | Create `tests/unit/lsp/navigation-service.test.ts`; update tool registry/adapter/MCP tests |
| 8 | Runtime integration, real TS/JS fixture, documentation | Modify `src/server/runtime-assembly.ts`, `src/server/index.ts`, `docs/mcp-tools.md`, `scripts/verify-mcp-tools.mjs` as needed | Create `tests/integration/lsp-navigation.test.ts`; extend runtime-shutdown regression tests |

Task dependencies: **1 (including protocol dependency) → 3,4,5; 2 → 6; 3+4+5+6 → 7 → 8**. Keep the interface unchanged across tasks unless an implementation blocker is demonstrated; such a blocker needs an Owner decision, not automatic scope expansion. Task 2 and Tasks 3–5 may be prepared independently once Task 1 types exist.

## Task 1: Core contracts and `character: 0` parity

**Files:** Create `src/lsp/contracts.ts`; modify `src/server/tools/registry/adapters/v2-adapter.ts`, `package.json`, `package-lock.json`; test `tests/unit/server/tools/registry/adapters/v1-adapter.test.ts`, `tests/unit/server/tools/registry/adapters/v2-adapter.test.ts`. Introduce only the Design-specified direct `vscode-languageserver-protocol@3.18.4` dependency with a compatible transitive `vscode-jsonrpc@9.0.3`; no other dependency upgrades.

**Interfaces:** Export the exact Design §4 `LspNavigationKind`, `ILspProvider` and §5 `NavigationToolArgs`, `NavigationLocation`, `NavigationResponse` plus Design §6.1 `VerifiedSymbolNavigationTarget` / `VerifiedSymbolNavigationResult` in a shared internal types module (type-only `Location|LocationLink` import). Keep invalid-argument handling separate from expected `NavigationResponse` statuses. `maxResults` is accepted for references only (default 100, max 1000); define a stable internal bound for the other two operations, with explicit `truncated` output.

- [ ] **1.1 Dependency prerequisite (authorized implementation only):** add `vscode-languageserver-protocol@3.18.4` to `package.json` and `package-lock.json` using the repository's pinned npm workflow, confirm the resolved `vscode-jsonrpc@9.0.3` family, and reject unrelated lockfile churn. This must precede compiling the Task 1 type-only `Location`/`LocationLink` imports.
- [ ] **1.2 Failing tests:** in the v1/v2 adapter tests, confirm `minimum:0` accepts `character:0` and rejects `-1`/noninteger; ensure a field with no declared minimum still rejects zero. The v1 adapter already has a zero-minimum regression test; preserve it.
- [ ] **1.3 Red check:** `./node_modules/.bin/vitest run tests/unit/server/tools/registry/adapters/v1-adapter.test.ts tests/unit/server/tools/registry/adapters/v2-adapter.test.ts`; new v2 zero case must fail before the validation fix (with dependency already installed).
- [ ] **1.4 Code:** in `toZodV4Field()` make integer zero valid **only** if the explicit schema minimum is zero; preserve the existing default-positive behavior and v1/v2 schema parity. Add exported internal contracts, including `LspDocumentLanguageId` as the four-value union from Design §4; **do not register new tools yet** (existing `buildToolHandlers` must stay complete).
- [ ] **1.5 Green check:** rerun the same targeted tests, then `npm run build`; expected PASS with no newly registered tool. Confirm the lockfile still contains only the intended new package family.
- [ ] **1.6 Authorized implementation commit only:** `git add package.json package-lock.json src/lsp/contracts.ts src/server/tools/registry/adapters/v2-adapter.ts tests/unit/server/tools/registry/adapters && git commit -m "feat(nexus): define LSP navigation contracts"`.

## Task 2: Config parsing, trust policy, and secret-safe launch approval

**Files:** Modify `src/types/index.ts` (`Config`), `src/config/index.ts`; create `src/lsp/trust-policy.ts`, `tests/unit/lsp/trust-policy.test.ts`; modify `tests/unit/config/index.test.ts` and only affected typed config fixtures.

**Interfaces:** `Config.lsp: LspConfig` exactly as Design §7.4; `loadConfig()` resolves specified environment variables, project file and defaults, and reports invalid LSP config as LSP-only `LSP_CONFIG_INVALID` rather than rejecting unrelated retrieval. A separate internal diagnostic on the loaded configuration is permitted solely to distinguish invalid configuration from intentionally disabled LSP; do not alter the public `LspConfig` fields. Define:

```typescript
type ApprovedLspLaunch = {
  readonly executable: string; readonly args: readonly string[];
  readonly cwd: string; readonly env: NodeJS.ProcessEnv;
  readonly serverVersion: '6.0.2';
};
type LspLaunchDecision =
  | { readonly status: 'ok'; readonly launch: ApprovedLspLaunch }
  | { readonly status: 'unavailable'; readonly reasonCode:
      'LSP_CONFIG_INVALID' | 'LSP_NOT_CONFIGURED' |
      'LSP_TRUST_REQUIRED' | 'LSP_EXECUTABLE_NOT_APPROVED' };
async function resolveApprovedLspLaunch(input: {
  projectRoot: string; lsp: LspConfig; env: NodeJS.ProcessEnv;
  configError?: 'LSP_CONFIG_INVALID';
}): Promise<LspLaunchDecision>;
```

- [ ] **2.1 Failing tests:** defaults (disabled/null/`['--stdio']`/10000/10000/60000), all six env keys, precedence by field, exact numeric bounds, strict env boolean, malformed JSON argument list, and invalid-LSP-only isolation. For POSIX trust: missing trust file, directory symlink, file owner/mode, changed executable digest, argv mismatch, untrusted sibling projectRoot, missing/mismatched **Owner-approved version metadata** (not an independent runtime version probe). Assert `spawn` is not called on refusal and child env contains none of `AWS_*`, `GH_TOKEN`, `SSH_AUTH_SOCK`, `NODE_OPTIONS` or ambient `NEXUS_*`.
- [ ] **2.2 Red check:** `./node_modules/.bin/vitest run tests/unit/config/index.test.ts tests/unit/lsp/trust-policy.test.ts`; new assertions fail before production changes.
- [ ] **2.3 Code:** implement Design §7.4/§8.1–8.2 parsing, owner-controlled trust store, secure canonical-root/executable SHA/args/version-**metadata** checks and allowlisted env. Treat `serverVersion:'6.0.2'` as Owner-maintained metadata bound to the approved digest; it is not proof of the running server's version. Do **not** add an approval-writing command, allow PATH lookup, run unapproved version probes or silently accept invalid trust. On unsupported Windows ACL checking return LSP unavailable.
- [ ] **2.4 Green check:** rerun both tests and `npm run build`; assert other `loadConfig()` behavior is unchanged. Test helpers using constructed `Config` objects must receive safe `lsp` defaults without changing embedding/indexing semantics.
- [ ] **2.5 Authorized implementation commit only:** `git add src/types/index.ts src/config/index.ts src/lsp/trust-policy.ts tests/unit/config/index.test.ts tests/unit/lsp/trust-policy.test.ts && git commit -m "feat(nexus): require LSP config and owner trust"` (stage any necessary config fixture updates explicitly).

## Task 3: `symbolId` → verified AST identifier position (F-001)

**Files:** Modify `src/structured/retrieval-service.ts`; create `src/lsp/identifier-locator.ts`, `tests/unit/lsp/identifier-locator.test.ts`; update `tests/unit/structured/retrieval-service.test.ts`.

**Interfaces:** Implement the exact Design §6.1 method signature `SymbolRetrievalService.resolveVerifiedNavigationTarget(input: {symbolId:string; signal?:AbortSignal}): Promise<VerifiedSymbolNavigationResult>`. Retain the Structured Catalog's `languageId:'typescript'|'javascript'` in `VerifiedSymbolNavigationTarget` (not the LSP document ID). Keep private `verifySymbol()`: extend its internal successful result with the checked active generation id where necessary. `src/lsp/identifier-locator.ts` exports `resolveTsIdentifierPosition(input: {bytes:Uint8Array; declaration:StructuredDeclaration; filePath:string}): {line:number;character:number} | null` and uses the existing TypeScript parser's `describeDeclaration()`, `signatureFor()`, `declarationStart()` conventions where applicable.

- [ ] **3.1 Failing tests:** `export function`, methods/nested names, overloads and repeated names, Unicode, default anonymous constructs without an unambiguous identifier, nonexact/partial declaration, stale file, retired/pending symbol, changed generation, excluded path and escaping symlink. Check exact `status`/`reasonCode` table in §6.1. No fall-through to a same-name symbol.
- [ ] **3.2 Red check:** `./node_modules/.bin/vitest run tests/unit/structured/retrieval-service.test.ts tests/unit/lsp/identifier-locator.test.ts`; new API/identifier assertions fail.
- [ ] **3.3 Code:** reuse private catalog/hash verification, require exact declaration, obtain generation id, identify the AST *name token* inside the verified declaration slice, check the current canonical file and re-read/hash/re-resolve generation before returning. Unsupported/ambiguous identifier shapes return `degraded/IDENTIFIER_TOKEN_UNRESOLVED`, not guessed locations.
- [ ] **3.4 Green check:** rerun targeted tests and `npm run build`; existing `get_symbol_source` and `get_symbol_context` behavior unchanged.
- [ ] **3.5 Authorized implementation commit only:** `git add src/structured/retrieval-service.ts src/lsp/identifier-locator.ts tests/unit/structured/retrieval-service.test.ts tests/unit/lsp/identifier-locator.test.ts && git commit -m "feat(nexus): verify LSP symbol navigation targets"`.

## Task 4: Current-source target and location validation

**Files:** Create `src/lsp/target-resolver.ts`, `src/lsp/result-validator.ts`, `tests/unit/lsp/target-resolver.test.ts`, `tests/unit/lsp/result-validator.test.ts`. The target resolver owns `lspDocumentLanguageIdForPath(filePath: string): LspDocumentLanguageId | null` (Design §4).

**Interfaces:**

```typescript
type ResolvedNavigationTarget = {
  readonly uri: string; readonly filePath: string;
  readonly position: {line:number; character:number}; // LSP zero-based UTF-16
  readonly text: string; readonly fileSha256: string;
  readonly languageId: LspDocumentLanguageId; // derived from file extension, not Catalog languageId
};
async function resolveNavigationTarget(input: {
  args: NavigationToolArgs; symbols: SymbolRetrievalService;
  sanitizer: PathSanitizer; isExcluded: (filePath:string)=>boolean|Promise<boolean>;
  signal?: AbortSignal;
}): Promise<{status:'ok';target:ResolvedNavigationTarget} | NavigationResponse>;
async function validateNavigationResults(input: {
  raw: null|readonly (Location|LocationLink)[];
  sanitizer: PathSanitizer; isExcluded:(path:string)=>boolean|Promise<boolean>;
  maxResults:number; signal?:AbortSignal;
}): Promise<Pick<NavigationResponse,'locations'|'truncated'|'sourceValidation'|'excludedResultCount'> | {status:'error'|'stale'|'cancelled';reasonCode:string}>;
```

- [ ] **4.1 Failing tests:** saved dirty file with no catalog, invalid/mixed target, path traversal, linked symlink escape, excluded files, out-of-bounds line/UTF-16 offsets, `character:0`, CRLF, surrogate pairs, deleted/changed target during request, `null`/`Location`/`LocationLink`, invalid range or URI, deterministic dedupe/sort, capped and omitted results with `partial` status metadata. Validate the **same** extension mapping for `symbolId` and explicit file/position inputs: `.ts/.mts/.cts→typescript`, `.tsx→typescriptreact`, `.js/.mjs/.cjs→javascript`, `.jsx→javascriptreact`; unknown extension returns `unsupported`.
- [ ] **4.2 Red check:** `./node_modules/.bin/vitest run tests/unit/lsp/target-resolver.test.ts tests/unit/lsp/result-validator.test.ts`; new tests fail.
- [ ] **4.3 Code:** keep path and source snapshots local to canonical worktree, use `PathSanitizer` for lexical and realpath containment, derive `LspDocumentLanguageId` **only from the validated file extension** with the shared `lspDocumentLanguageIdForPath()` function for both target types, verify current UTF-8 bytes/UTF-16 offsets and reply with explicit `stale`, `excluded`, `not_found`, `unsupported` or `error` as specified. Normalize `LocationLink.targetSelectionRange` only after containment inside `targetRange`. Do not claim global LSP graph freshness.
- [ ] **4.4 Green check:** rerun targeted tests and `npm run build`.
- [ ] **4.5 Authorized implementation commit only:** `git add src/lsp/target-resolver.ts src/lsp/result-validator.ts tests/unit/lsp/target-resolver.test.ts tests/unit/lsp/result-validator.test.ts && git commit -m "feat(nexus): validate current-source LSP targets and locations"`.

## Task 5: Microsoft LSP/JSON-RPC protocol client and inbound-deny policy (F-002)

**Files:** Create `src/lsp/protocol-client.ts`, `tests/unit/lsp/protocol-client.test.ts`, `tests/fixtures/lsp/stub-language-server.mjs`. **Do not modify** `package.json` or `package-lock.json`: Task 1 already added `vscode-languageserver-protocol@3.18.4` and its compatible transitives.

**Interfaces:** `createLspProtocolClient(input:{stdin:NodeJS.WritableStream;stdout:NodeJS.ReadableStream;rootUri:string}): ILspProvider`; it implements the Task 1 provider contract and uses protocol Node exports for typed request/notifications. The provider receives streams; **it does not spawn processes**. Its `start()` yields the server's independently negotiated definition/references/implementations capabilities and UTF-16 support.

- [ ] **5.1 Failing tests (stream-backed stub):** initialize → initialized order and root folder; didOpen/change/close document versions and four extension-derived LSP IDs; definition/references/implementation and `includeDeclaration:true`; `null`/single `Location`/`LocationLink[]`; unsupported capabilities; cancellation request ID, request timeout and late reply; clean shutdown/exit. Inject incoming `workspace/configuration`/`workspace/workspaceFolders` (read-only) and `workspace/applyEdit`, `showDocument`, registerCapability and unknown methods (refused). Assert **no file edits**.
- [ ] **5.2 Red check:** `./node_modules/.bin/vitest run tests/unit/lsp/protocol-client.test.ts`; newly written test fails.
- [ ] **5.3 Code:** consume the already installed pinned protocol dependency from Task 1; build a `createMessageConnection` using `StreamMessageReader` and `StreamMessageWriter`; register request handlers *before* `listen()`. Implement exactly Design §7.2/§7.3 without independent protocol framing or executing server commands. Map malformed replies to sanitized `LSP_PROTOCOL_ERROR`.
- [ ] **5.4 Green check:** rerun the targeted test and `npm run build`; verify the Task 1 dependency/lockfile selection remains unchanged (no Task 5 package/lockfile edits).
- [ ] **5.5 Authorized implementation commit only:** `git add src/lsp/protocol-client.ts tests/unit/lsp/protocol-client.test.ts tests/fixtures/lsp/stub-language-server.mjs && git commit -m "feat(nexus): add read-only LSP protocol client"`.

## Task 6: Lazy runtime-local process manager (F-003)

**Files:** Create `src/lsp/process-manager.ts`, `tests/unit/lsp/process-manager.test.ts`.

**Interfaces:**

```typescript
type LspProviderAcquisition =
  | {readonly status:'ok';readonly provider:ILspProvider;
     readonly capabilities:Awaited<ReturnType<ILspProvider['start']>>}
  | {readonly status:'unavailable'|'timeout'|'cancelled'|'error';readonly reasonCode:string};
class RuntimeLocalLspManager {
  acquire(input?: {signal?:AbortSignal}): Promise<LspProviderAcquisition>;
  close(): Promise<void>;
}
```

Constructor dependencies: canonical `projectRoot`, `LspConfig`, `resolveApprovedLspLaunch()` from Task 2, a typed process-spawn seam and Task 5 `createLspProtocolClient()`; make safe test injection explicit instead of changing exported public runtime APIs.

- [ ] **6.1 Failing tests:** `enabled:false`, no/invalid trust and executable digest or Owner version metadata, unsafe env; assert **zero spawned children**. When approved, an `initialize` response **without** `serverInfo.version` succeeds only if protocol/UTF-16/capabilities pass; if serverInfo.version contradicts Owner metadata, refuse navigation (`unavailable/LSP_EXECUTABLE_NOT_APPROVED`). Do not claim transitive dependencies are authenticated. Concurrent first use starts exactly once; cache isolated by different canonical roots; child stdin/out and stderr are bounded/sanitized; initialization startup timeout, crash, cancellation and idle close reclaim processes; shutdown emits `didClose`/`shutdown`/`exit` before bounded kill; delayed response cannot affect a later request.
- [ ] **6.2 Red check:** `./node_modules/.bin/vitest run tests/unit/lsp/process-manager.test.ts`; new cases fail.
- [ ] **6.3 Code:** gate `spawn()` on approved launch, use `shell:false`, approved absolute executable/argv and allowlisted env; after startup verify the LSP protocol, UTF-16 and advertised capabilities **without requiring an independent runtime version probe or `serverInfo.version`**; track one process per runtime (TS/JS share it), in-flight startup and active request/document lifecycle. Do not create a process for untrusted sources. Return stable LSP-local failure codes.
- [ ] **6.4 Green check:** rerun targeted tests, `npm run build` and `npm run lint`.
- [ ] **6.5 Authorized implementation commit only:** `git add src/lsp/process-manager.ts tests/unit/lsp/process-manager.test.ts && git commit -m "feat(nexus): manage per-worktree LSP lifecycle"`.

## Task 7: Navigation service and MCP registry integration

**Files:** Create `src/lsp/navigation-service.ts`, `src/server/tools/get-lsp-navigation.ts`, `tests/unit/lsp/navigation-service.test.ts`; modify `src/server/tools/types.ts`, `src/server/tools/tool-support.ts`, `src/server/tools/registry/definitions.ts`; update `tests/unit/server/tools/registry/definitions.test.ts`, `tests/unit/server/tools/registry/adapters/{v1-adapter,v2-adapter}.test.ts`, `tests/integration/mcp-protocol.test.ts`, `tests/shared/create-test-nexus-options.ts` as needed.

**Interfaces:**

```typescript
class LspNavigationService {
  navigate(input: {
    kind:LspNavigationKind; args:NavigationToolArgs;
    signal?:AbortSignal;
  }): Promise<NavigationResponse>;
}
```

Add optional `lspNavigationService?: LspNavigationService` to `NexusServerOptions` as an internal assembly seam. The three `ToolDefinition`s use common flat fields; `get_references` alone accepts `maxResults`; each handler returns the existing `toolResult()` structured wrapper, and a missing service returns `unavailable/LSP_NOT_CONFIGURED` without disturbing other tools.

- [ ] **7.1 Failing tests:** registry lists 12 tool names in stable order; v1/v2 argument parsing is equivalent, `character:0` valid, partial/mixed target rejected *before* calling provider; `get_definition`, `get_references`, `get_implementations` dispatch independently; null→`ok` empty, unsupported→`unsupported`, missing trust→`unavailable`, stale ID→fail closed, `maxResults` truncation; no existing handler regression.
- [ ] **7.2 Red check:** `./node_modules/.bin/vitest run tests/unit/lsp/navigation-service.test.ts tests/unit/server/tools/registry/definitions.test.ts tests/unit/server/tools/registry/adapters/v1-adapter.test.ts tests/unit/server/tools/registry/adapters/v2-adapter.test.ts`; new tests fail.
- [ ] **7.3 Code:** resolve requested target (Task 3 or Task 4); acquire allowed provider (Task 6), synchronize exact current disk document, respect negotiated capability (Task 5), call typed navigation and validate locations (Task 4). Map expected failures to Design §5 statuses, preserve `sourceValidation` limitations, and maintain `withToolMetrics` + existing error sanitization. Do not persist navigation edges or add a dependency to unrelated search handlers.
- [ ] **7.4 Green check:** rerun targeted tests and `npm run build`, then `./node_modules/.bin/vitest run tests/integration/mcp-protocol.test.ts`.
- [ ] **7.5 Authorized implementation commit only:** explicitly stage Task 7 files and commit `feat(nexus): expose three LSP navigation tools`.

## Task 8: Runtime assembly, pinned TS/JS integration, and user docs

**Files:** Modify `src/server/runtime-assembly.ts`, `src/server/index.ts`, `docs/mcp-tools.md`, `scripts/verify-mcp-tools.mjs` if necessary; create `tests/integration/lsp-navigation.test.ts`, fixture sources under `tests/fixtures/lsp/`; extend `tests/unit/server/index.test.ts` and any runtime assembly tests actually affected.

**Interfaces:** The production `createRuntimeAssembly(config)` injects a runtime-local `LspNavigationService` and owns the manager through existing `onClose()` / rollback cleanup, without adding it to public `NexusRuntime` exports. LSP opt-in remains gated by Task 2 approval on *every* first launch, not by successful Nexus initialization alone.

- [ ] **8.1 Failing tests:** controlled real `typescript-language-server@6.0.2` + TypeScript 5.9.x fixture, explicit trusted temp worktree and pinned binary; TS and JS definition/references/implementation across files and **didOpen languageId for all eight extensions** (`.ts/.mts/.cts/.tsx/.js/.mjs/.cjs/.jsx`), with shared conversion for `symbolId` and file/position, dirty saved file/position after indexing, stale `symbolId` refused, primary/linked divergent worktrees, absent/unapproved server isolation, runtime close and init rollback cleanup. Separate protocol-stub tests remain deterministic in CI; real-server tests require an explicitly prepared pinned test executable and trusted fixture and must report skipped/not-run distinctly from PASS when unavailable.
- [ ] **8.2 Red check:** `./node_modules/.bin/vitest run tests/integration/lsp-navigation.test.ts`; new integration assertions must fail before wiring. Never silently convert missing LSP or trust into a passing integration test.
- [ ] **8.3 Code:** assemble and close LSP services through current runtime composition; make failures LSP-local, extend `docs/mcp-tools.md` with the three MCP schemas/statuses, trust setup/limitations and external prerequisites. Adjust the existing MCP verifier for a deterministic `unavailable` outcome when no approval exists, without changing unrelated tool expectations. Do not change `SPEC.md` except if an explicit contradiction is demonstrated and approved.
- [ ] **8.4 Green check:** `./node_modules/.bin/vitest run tests/integration/lsp-navigation.test.ts tests/unit/server/index.test.ts tests/integration/mcp-protocol.test.ts`; then `npm run build`, `npm run lint`, `npm test`, `npm run verify:mcp-tools`. Report every command's actual status, the real-server test setup and skips, and the resulting worktree isolation evidence. No claim of PASS without execution.
- [ ] **8.5 Authorized implementation commit only:** stage the Task 8 files explicitly and commit `feat(nexus): integrate worktree-local LSP navigation`.

## Completion / Owner checkpoint

Initial implementation is eligible for an **Owner decision**, not automatic adoption, only with:

- Three TypeScript/JavaScript MCP operations working with both supported inputs and explicit capability/error states.
- Verified current source, saved dirty files, no stale identity fallback, and no persistent semantic relationship graph.
- Lazy startup, cleanup, owner trust, bounded process behavior, secret-safe child env, and denial of server-requested edits.
- Worktree isolation and no regressions in existing text/vector/structured retrieval, supported by recorded tests (or explicit `NOT_RUN` / limitations).
- Documentation covering config, trust, executable prerequisites, API contracts and failure semantics.

**Stop conditions:** trust/path/source ambiguity, unapproved executable/hash/Owner version metadata, or incompatible LSP protocol/capability => stop **that LSP launch/request** and return an explicit failure; do not suspend unrelated retrieval. A confirmed security/data-integrity issue needing a new architectural choice returns to the Human Owner before broader work. Finding counts, blanket PASS and repeated independent reviews are **not** unconditional completion requirements.

**Deferred, separately authorized only:** Python/basedpyright, #320 LSP benchmarks, #299 performance measurements, further supported languages, PR/merge, deployment or any extra review round.

**Plan correction boundary:** This F-003–F-005 correction updates only Design and Plan drafts in the local working area. No implementation tasks, tests, commits, pushes, review gates, or runtime changes have been executed. Formal Owner adoption of Design R0.1.2 and this corrected Plan is still required before execution.
