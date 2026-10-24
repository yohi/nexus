# READ-005 Capability Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the approved READ-005 ownership boundary into a new isolated harness candidate and submit source-only evidence for independent review.

**Architecture:** Retain raw Registry, SDK, observer, and publication capabilities in trusted composition. Ordinary cases receive a narrowly projected facade, opaque request/session handles, and data-only results. Preserve actual Initialize/dispatch identity, synchronous final admission, and existing experiment blockers.

**Tech Stack:** Existing JavaScript ESM harness, Node.js >=24, installed TypeScript AST/compiler tooling, Python standard-library archive checks; no dependency installation.

**Spec:** [Approved boundary design](../specs/2026-10-23-read005-capability-boundary-design.md), approved in conversation after creation.

## Global constraints

- Baseline HEAD: `4fd4872d4baa4394dd3828040f4d52ac9cc9e02d`.
- Original archive SHA-256: `f98094211e2962ea21afd4187a2f1a93b80150cef7d6701c191f6aed27fff0ef`.
- Keep original archive, baseline, prior candidate, frozen reference files, and historical attestations unchanged.
- Pins: SDK `1.29.0`, server/node packages `2.0.0`; SDK Web Transport JS SHA-256 `177d73106a8dbed5950e26e326bad5864817dc54c571959b070a95d502ba08a6`.
- Preserve `R3_FROZEN_COMMAND_MANIFEST.json`, `R3_T05_ORACLE_IMPLEMENTATION_MATRIX.json`, `src/readiness/scenario-catalog.json`, and `R3_EXECUTION_GATE_STATUS.json` byte-for-byte: 234 bindings, Safe117/Negative117, 61 oracle cells.
- R3 Execution Gate=`NOT_AUTHORIZED`; R3=`NOT_EXECUTED`; Section4.1=`BLOCKED`; R1-001-04=`UNRESOLVED`; 234 Binding=`BLOCKED/NOT_EXECUTED`.
- No harness/test/SDK imports or dynamic tests, network, native I/O, fault scenarios, dependency updates, product-code edits, GitHub changes, or execution-gate changes.
- Verification executes preparation tooling only: AST parsing, `node --check`, compile-only probes, hashing, and archive checks. Oracle source is never executed. Static success is at most `PASS_STATIC_ONLY`; observations remain `UNKNOWN`.
- No commit/push is authorized. Stop after source-evidence submission. Independent review and experiment authorization remain separate.
- This is capability distribution, not a sandbox. If arbitrary case imports, prototype replacement, or trusted-bootstrap injection cannot be excluded by the venue, report the boundary as unproven.

## Review focus

1. Nested aliases through results/errors/getters/provider spreads must not expose raw authority: Task 2 projection oracles.
2. Reused/cloned/cross-run request and session handles must not bypass current admission: Task 4 handle oracles.
3. Internal Server construction must not connect early or retain a case-supplied factory: Task 3 ownership/order oracles.
4. A valid-looking artifact digest without independent context/provenance must not become identity proof: Task 5 evidence oracles.
5. Authorization revoked after scenario preparation must prevent later dispatch, including the second replay: Tasks 4 and 6 revocation oracles.

## Workspace and file structure

Execution starts by following `using-git-worktrees` for repository edits. The
untracked evidence tree will not automatically follow a worktree checkout.
Read and verify it in the source workspace, then create a separate sibling
`evidence/read001-read005/candidate-boundary/` only when executing this plan.
Copy the prior `candidate/` byte-for-byte; never use a generated replacement as
the baseline. Refuse an existing destination rather than overwrite it.

All harness paths below are relative to that **new candidate root**. Use
`REPO` for the repository containing the installed toolchain, `PREVIOUS` for
the verified prior candidate, and `NEXT` for the new candidate. Keep absolute
machine paths out of source and evidence. Initial reports record hashes and
relative artifact names, not local directory names.

| File                                                                                               | Responsibility                                                              |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `preparation/verify-case-boundary.mjs`                                                             | AST-only contract, imports, source inventory, and regression checks         |
| `preparation/boundary-checks.mjs`                                                                  | Structural predicates used only by the checker                              |
| `src/case-context/projection.mjs`                                                                  | Data-only output/error projection; no SDK dependency                        |
| `src/case-context/bootstrap.mjs`                                                                   | Trusted construction, request enrollment, and case facade issuance          |
| `src/case-context/facade.mjs`                                                                      | Four permitted case operations; no arbitrary target/provider input          |
| `src/case-context/evidence.mjs`                                                                    | Private receipt/artifact validation and public evidence projection          |
| `src/adapters/mcp.mjs`                                                                             | Separate unconnected Server construction from existing connection helper    |
| `src/replay/assembly.mjs`, `initialize-driver.mjs`                                                 | Internal Server setup and unchanged owner registration sequence             |
| `src/replay/main-session-owner.mjs`, `session-observer.mjs`                                        | Narrow trusted observer access; preserve actual equality and final dispatch |
| `src/readiness/scenario-runner.mjs`                                                                | Keep provider run private; return only a scoped scenario facade             |
| `tests/case-boundary.test.mjs`                                                                     | New source-only adversarial oracles and explicit venue fixture contract     |
| `tests/main-owner-capability.test.mjs`, `source-closure.test.mjs`, `readiness-boundaries.test.mjs` | Adapt boundary-facing fixtures; retain trusted observations separately      |
| `preparation/package-case-boundary.mjs`                                                            | Revised diff, checksums, manifests, and evidence archive                    |

Keep new modules focused and below 250 implementation lines. Do not modify the
global Registry method semantics to sanitize trusted internal receipts.

## Shared interfaces

These are **new harness interfaces**, not SDK APIs. Use JSDoc in `.mjs` files.

- `Data`: null, boolean, finite number, string, arrays of Data, or own-data-property records of Data; no functions, symbols, accessors, cycles, or custom prototypes.
- `RequestHandle` and `MainHandle`: empty frozen null-prototype objects, recognized by private WeakMaps in the issuing bootstrap/owner. IDs and serialized copies confer no registration.
- `CaseResult`: frozen data record `{ ok: true, operation, requestKey, evidenceRef }` or `{ ok: false, code }`. `operation` is `route` or `reconnect`; request/evidence references must come from trusted execution, not fabricated defaults.
- `MainCaseFacade`: exactly `initialize(requestHandle) -> Promise<MainHandle>`, `route(mainHandle, requestHandle) -> Promise<CaseResult>`, `reconnect(mainHandle, requestHandle) -> Promise<CaseResult>`, `snapshot(mainHandle) -> Promise<Data>`.
- `createCaseBoundary({ drivers, modules, registry, serverSetup, authorize }) -> TrustedBoundary`: called only by trusted bootstrap; synchronous `authorize() -> void` performs the existing current execution-authorization check and throws on failure. A Promise-returning authorizer is rejected.
- `TrustedBoundary`: exactly `bindRequest(request, externalContext) -> Promise<RequestHandle>` and `issueCase() -> MainCaseFacade`. The trusted shell must not be passed to cases. Each issued facade has a private issuance identity used when binding its first session; foreign-facade sessions are rejected.
- `serverSetup`: trusted-only `{ waitHandler }` used to configure the existing `synthetic` fixture tool. No case-supplied callbacks, Server, SDK, registry, writer, or envelope enter facade signatures.

`bindRequest` calls the existing `IngressBridge.bindWeb`; cases cannot invoke it
or attach external context. Resolve the request's target internally using
`targetFor(request)` and forward the original bound Request, preserving ingress
identity. Request handles do not cache authentication, targets, grants, or ACTIVE
admission. Resolve/check these on every operation.

The trusted adapter invokes internal `actualSDKWeb`/ReplayBroker and publication
operations; cases never receive their private plans, streams, response writers,
Buffer frames, or raw errors. Preserve their existing publication behavior.
`CaseResult` is an operation outcome, never proof of external P.

For a normal route, call the internal driver's `route(request, target,
request.signal)` and send its `privatePlan` through
`publishActualHTTP(drivers, { ...target, plan: privatePlan, publicationMode: 'NEW' })`
inside trusted code. A ReplayBroker result has already taken the replay
publication path and must not be published again. Bind projected request/evidence
references to that operation's trusted target and independently observed artifact;
missing artifact integration produces a blocked result, not a synthetic reference.

### Task 1: Establish the revision and failing static boundary checks

**Files:** Create `preparation/verify-case-boundary.mjs`, `preparation/boundary-checks.mjs`, `BOUNDARY_INPUT_VERIFICATION.json`; preserve all original inputs.

**Interfaces:** Checker CLI: `node preparation/verify-case-boundary.mjs REPO [SOURCE_ROOT]`; default root is the script's candidate. Print JSON `{ status, checks, sourceHashes, experimentalImports: 0, testsExecuted: 0 }`; exit 1 for failed structural checks, 0 otherwise. Import only Node builtins, installed TypeScript, and preparation helpers.

- [ ] Verify baseline HEAD, original archive hash, CRC, all internal sums, and the prior candidate's `READ005_SOURCE_MANIFEST.json` source hashes. Record prior candidate archive/hash linkage. Any disagreement is `BASELINE_DRIFT`; stop without repairing the baseline.
- [ ] Create the new candidate copy and verify every copied byte against the prior candidate before editing it. Record the immutable-file list from Global constraints plus all `reference/` files.
- [ ] Write AST predicates for the exact facade keys, no provider-result spread, private request/session maps, internal Server construction, output/error projection, final synchronous verify/guard/SDK call, and the unchanged 234/61 catalog. Missing new modules must be reported as failed checks, not a checker crash.
- [ ] Add a restricted-import check rooted at `tests/fixtures/ordinary-main-case.mjs` (created in Task 2); follow its complete static import closure. A missing entry is a failure, not an empty successful scan. Reject dynamic imports, `eval`, `Function`, and imports into trusted driver/registry/SDK/preparation modules. Classify existing `src/cases.mjs` and intervention drivers as trusted orchestration, not automatically isolated ordinary-case code; mark their external context binding unresolved. The fixture scan does not attest the venue's actual case loader or entry hashes, which remain a separate enrollment blocker.
- [ ] Run the checker against `PREVIOUS`. Expected exit 1 with failures identifying the Registry/run spreads and absent facade; record this as the static red baseline, never as a failed behavioral test. No runtime oracle executes.

### Task 2: Define data-only results and adversarial source oracles

**Files:** Create `src/case-context/projection.mjs`, `tests/case-boundary.test.mjs`, `tests/fixtures/ordinary-main-case.mjs`; extend the preparation checker.

**Interfaces:** `projectData(value: unknown) -> Data`, `projectCaseError(error: unknown) -> { ok: false, code: string }`, `projectCaseResult(operation, raw) -> CaseResult`. Use own property descriptors and explicit field selection; reject unsafe values with `CASE_RESULT_UNSAFE`. Unknown errors map to `CASE_OPERATION_FAILED`; do not copy `.message`, `.cause`, stacks, or arbitrary fields.

For errors, inspect only own data descriptors named `code` or `message` without
invoking getters. Preserve a string only when it exactly equals one of:
`CASE_RESULT_UNSAFE`, `CASE_REQUEST_HANDLE_REQUIRED`, `MAIN_OWNER_HANDLE_REQUIRED`,
`MAIN_OWNER_CLOSE_AUTHORITY_UNSPECIFIED`, `R3_EXECUTION_NOT_AUTHORIZED`,
`R3_EXECUTION_AUTHORIZATION_REVOKED`, `MAIN_REQUEST_AUTHORITY_DENIED`,
`OWNER_TARGET_MISMATCH`, `REPLAY_ENTITLEMENT_UNPROVEN`, or
`IDENTITY_EVIDENCE_UNAVAILABLE`. All other values map to `CASE_OPERATION_FAILED`.

- [ ] Write source-only oracle `projectionRejectsLiveValues(venue)`: assert rejection of nested transport/server, bound methods, functions, accessors, symbol keys, custom prototypes, cycles, and nonfinite numbers. Getter bodies must not run. Document proxy traps as outside the approved hostile-code threat model, not solved by descriptor inspection.
- [ ] Write the source-only ordinary-case fixture `exerciseMainCase(facade, { initializeRequest, followupRequest })`: initialize using the first opaque request handle, route with the resulting main handle and second request handle, then request a snapshot. It imports nothing and receives no trusted venue helpers. Its use of only those three facade operations is checked statically; do not execute it.
- [ ] Write `errorProjectionDoesNotLeak(venue)`: thrown providers with capability-bearing cause/custom properties produce only `{ ok: false, code }`; an arbitrary provider message cannot become the code. Allow existing stable denial codes only through an explicit bounded allowlist.
- [ ] Implement detached recursive copying/freezing of allowed data and field-by-field case-result projection. Do not traverse or freeze raw SDK graphs. Missing trusted request/evidence references fail closed; do not invent zero counters or proof strings.
- [ ] Run `node --check` for the new module/test and AST checker. Expected projection-related checks `PASS_STATIC_ONLY`; unrelated pending tasks may still fail. Record each check rather than claim overall closure.

### Task 3: Move Server construction into trusted initialization

**Files:** Modify `src/adapters/mcp.mjs`, `src/replay/assembly.mjs`, `src/replay/initialize-driver.mjs`, `preparation/verify-frozen-api.mjs`; update `tests/source-closure.test.mjs` and new boundary oracle source.

**Interfaces:** Add `createPrivateMcpServer({ McpServer, z }, waitHandler) -> McpServer` to the existing adapter; it registers the existing `synthetic` tool without connecting. Existing `privateMcpServer(modules, transport, waitHandler)` delegates to it then connects. `initializeMainSession` consumes trusted `serverSetup` instead of caller `server`; the trusted assembly closes over `bindings.mainServerSetup`.

- [ ] Write `caseCannotSupplyServerOrFactory(venue)` and `initializeConnectsAfterObservation(venue)`: ordinary input cannot inject Server/factory/callback; a separately authorized future observation must show construct/configure, observer enrollment, then connect once, followed by Initialize. Same actual objects reach later owner dispatch.
- [ ] Split the existing helper without altering its name/version, tool schema, wait behavior, or existing private-client/stdio contracts. Missing enrolled trusted setup fails with `VENUE_CAPABILITY_UNENROLLED:MAIN_SERVER_SETUP`; do not insert a no-op handler that removes barriers.
- [ ] Replace the `server` argument in main initialization with internally constructed Server. Explicitly enumerate trusted arguments at the assembly call site; remove spreading arbitrary Initialize inputs into the trusted constructor path.
- [ ] Preserve callbacks, final Initialize publication, ACTIVE commit/readback, owner registration, and failure cleanup ordering. Keep early failure from exposing a partial Server or Transport; retain fail-closed cleanup errors internally.
- [ ] Run syntax/AST checks. Extend compile-only frozen API probes for the captured public McpServer constructor, registerTool, and connect signatures **only if their declarations are captured**. If absent, record `SDK_API_CONTRACT_BLOCKED:MAIN_SERVER_CONSTRUCTION`; do not import a real SDK or fabricate declarations.

### Task 4: Issue the main case facade and opaque request handles

**Files:** Create `src/case-context/bootstrap.mjs`, `src/case-context/facade.mjs`; modify trusted composition in `src/drivers/integration.mjs` and `preparation/verify-main-owner-capability.mjs`; extend `tests/case-boundary.test.mjs`.

**Interfaces:** Implement the Shared interfaces. `assembleDrivers()` remains trusted-only; an ordinary case receives only `issueCase()` output. Main handles retain the owner's existing WeakMap registration plus facade issuance binding. Unknown request/session handles fail with `CASE_REQUEST_HANDLE_REQUIRED` / `MAIN_OWNER_HANDLE_REQUIRED`.

- [ ] Write `caseFacadeHasOnlyApprovedOperations(venue)`: exact four own keys, null prototype, frozen surface, no reachable Registry/observer/server/transport/provider/root. Audit success, rejection, snapshot, reflection, destructuring, and serialization surfaces.
- [ ] Write `requestAndSessionCopiesDoNotAuthorize(venue)`: clone/spread/JSON/prototype/string handles, foreign bootstrap/facade handles, and forged targets cannot dispatch. Repeated use of a genuine handle requires fresh current admission; it does not acquire a permanent grant.
- [ ] Implement trusted request enrollment and facade closures. Check `authorize()` before each operation and after asynchronous setup before entering existing owner admission; preserve the owner's final synchronous guard/dispatch boundary. Do not expose target or externalContext parameters.
- [ ] Route normal operations through the existing internal driver and trusted publication path, reconnect through its authenticated Broker path, and return Task 2 projections. Do not expose internal `plan`, `close`, `register`, `admit`, or raw `Response` objects to cases. Block unavailable publication integration rather than label private completion as P.
- [ ] Write revocation controls for principal, ACTIVE commit, boot, grant, ownership, and authorization changes between request enrollment and invocation. Assertions require unauthorized SDK/final-write deltas zero; measurement helpers belong to trusted oracle fixtures, never Case Context.
- [ ] Run syntax/AST checks plus the original owner checker in the new candidate. Preserve its 20 conditions or strengthen equivalent AST predicates with an explicit before/after mapping; never remove final admission checks just to turn the checker green.

### Task 5: Separate identity observations from public evidence

**Files:** Create `src/case-context/evidence.mjs`; modify `src/replay/session-observer.mjs`, `main-session-owner.mjs`; extend source-only identity/forgery oracles.

**Interfaces:** `MainSessionObserver.bootId` is a scalar getter; `verifyMainDispatchSync(input)` delegates to its private Registry and returns the internal receipt only to trusted owner code. The observer accepts trusted constructor option `{ authorizeMainDispatchSync }` from `bindings.authorizeMainDispatchSync` in assembly. Trusted bootstrap supplies the same synchronous authorizer before calling `assembleDrivers` and later `createCaseBoundary`; no post-construction dependency replacement is permitted. Missing authorizer fails with `R3_EXECUTION_NOT_AUTHORIZED`. The observer invokes it immediately before existing Registry verification. Replace `.observer.registry` owner accesses with these narrow trusted members. `projectIdentityEvidence({ receipt, artifact, proof, expected }) -> Data` returns only versioned identity metadata and artifact references/hashes after validation.

- [ ] Write `publicReceiptCannotAuthorizeDispatch(venue)`: forged/copied valid-looking snapshots never authorize an owner dispatch. Wrong digest, observer, run, boot, session, attempt, active token, or request/principal binding cannot pass the independent identity oracle.
- [ ] Keep the Registry in a private observer field. Preserve actual receipt/Transport/Server equality checks inside the observer and owner, including the final input to `verifyMainDispatchSync`. Do not globally sanitize the Registry or replace actual comparisons with IDs/hashes.
- [ ] Project exactly `schemaVersion: 1`, `kind`, `runId`, `bootId`, `sessionId`, `transportId`, `attemptNonce`, `activeCommitToken`, `independentObserverRef`, `enrollmentRef`, `rawArtifactRef`, `rawArtifactSha256`, and, for dispatch only, `requestIdentity` and `principalKey`. Records use own data fields only; no auth tickets, body, callable, or raw receipt passes through.
- [ ] Require actual independently produced artifact bytes, their computed SHA-256, non-self origin, and enrolled verification through existing `rawEvidence.verifyArtifactSync`. Bind the proof to the expected run and identity observation, not merely a matching digest. This is a harness expectation on a venue provider, not a new SDK method.
- [ ] If the supplied provider cannot attest that observation/context, return a projected blocked result `IDENTITY_EVIDENCE_UNAVAILABLE` and retain a named venue blocker. Never synthesize equality booleans, fabricate a verifier, or report identity PASS from static checks. Snapshot access rechecks current principal/session ownership before projecting.
- [ ] Run syntax/AST and compile-only checks. Update the final-boundary predicate to require the new trusted observer call, unchanged actual equality guards, and immediate SDK dispatch without an intervening await/case callback.

### Task 6: Remove scenario-result escape paths and adapt oracle fixtures

**Files:** Modify `src/readiness/scenario-runner.mjs`, `tests/main-owner-capability.test.mjs`, `tests/source-closure.test.mjs`, `tests/readiness-boundaries.test.mjs`; add `src/case-context/scenario-facade.mjs` if needed for module size.

**Interfaces:** `ScenarioVenue.prepareRealScenario(caseId, scenario)` returns only an opaque prepared handle with `executeWithRegisteredBarriers() -> Promise<ScenarioResult>`. Raw provider run stays in `#runs`. `ScenarioResult` is `{ runId, caseId, scenario, executionRef }` projected from genuine execution; the raw outcome is retained privately for collection. `collectIndependentRaw(prepared)` uses that stored outcome and returns verified data, not the run/provider graph.

- [ ] Write `scenarioRunCannotEscape(venue)`: an extra nested transport, getter, error cause, broker method, or Registry in the provider's run never reaches the prepared handle/result. Do not rely on shallow freeze or hidden top-level fields.
- [ ] Replace `{ ...run }` with the exact prepared surface. Keep actual requests, targets, broker, drivers, initialization inputs, barrier hooks, and raw outcomes private to trusted intervention code. Missing concrete operation inputs remain blocked.
- [ ] Keep RP-19's two genuine nonempty replay calls in `executeIntervention`, with authorization revalidation between them and existing same-owner/fresh-renderer assertions. Change boundary-facing oracle source to invoke the prepared operation, rather than retrieve `run.broker` and raw targets.
- [ ] Retain hostile target injection and raw identity assertions as **trusted oracle controls** using genuine independently enrolled venue fixture operations. Document those fixture requirements in the new test file; unavailable controls are explicit unexecuted blockers, not newly implemented private venue APIs.
- [ ] Update READ-005 N5 to test absent Registry/provider access through the ordinary facade; keep the old exploit path as a documented baseline counterexample. Preserve close denial, clone denial, replay-only routing, C0/F1/P, INV-01–07, terminal claims, and close/crash/request-abort distinctions.
- [ ] Run the new AST checker and all three existing preparation checks **in NEXT only**. Existing `verify-source-closure.mjs` and `verify-frozen-api.mjs` write reports: never run them against the historical candidate. Expected static checks pass or list concrete unresolved API/venue blockers, with no oracle execution.

### Task 7: Package traceable source-only evidence and stop

**Files:** Create `preparation/package-case-boundary.mjs`, `BOUNDARY_SOURCE_DIFF.patch`, `BOUNDARY_SOURCE_MANIFEST.json`, `BOUNDARY_STATIC_VERIFICATION.json`, `BOUNDARY_IMMUTABILITY_COMPARISON.json`, `BOUNDARY_ORACLE_MATRIX.json`, `BOUNDARY_CLOSURE_REPORT.md`, `BOUNDARY_REMAINING_BLOCKERS.md`, `BOUNDARY_INDEPENDENT_REVIEW_REQUEST.md`; revise NEXT's README to route to them.

**Interfaces:** Packaging CLI: `node preparation/package-case-boundary.mjs REPO PREVIOUS`. Compare sources to the verified prior candidate, enforce this plan's explicit source allowlist, and leave all `READ005_*` historical reports unchanged. Write `nexus305-read005-boundary-evidence.zip` plus external SHA-256 manifest; refuse overwriting an existing archive.

- [ ] Run and capture `node preparation/verify-case-boundary.mjs "$REPO"`, `node preparation/verify-main-owner-capability.mjs "$REPO"`, `node preparation/verify-source-closure.mjs "$REPO"`, and `node preparation/verify-frozen-api.mjs "$REPO"` from NEXT. Capture exit status, tool versions, checks, hashes, and explicit static limitations; do not count expected negative API-probe diagnostics as API availability.
- [ ] Inventory every changed/new source and all transitive boundary paths. Generate previous/current SHA-256 and source diff; compare all frozen files and original archive hashes. Record all nine design verification classes and five Review Focus items against exact unexecuted oracle exports; do not add or promote frozen binding IDs.
- [ ] Add the trusted/untrusted import classification and residual venue assumptions to the report. Distinguish fixed source paths from unresolved runtime isolation, identity artifact, API, and execution evidence. Preserve READ-002 and existing READ-003/004/ENV gaps.
- [ ] Assign `SOURCE_FIX_READY_FOR_INDEPENDENT_REVIEW` only when all planned source integrations and static checks pass. Otherwise use `PARTIALLY_INTEGRATED`, `DESIGN_CLARIFICATION_REQUIRED`, or `BASELINE_DRIFT` with concrete reasons. Never self-CLOSE READ-005 or declare Gate PASS.
- [ ] Build the evidence ZIP with internal `SHA256SUMS` excluding itself; hash the final ZIP externally. Independently reopen it, check CRC, every listed digest, complete file coverage without unsafe member paths, frozen byte identity, and source-manifest/patch consistency. Keep parent archive references resolvable in the delivery set without rewriting their bytes.
- [ ] Submit report/archive paths, static commands/results, unexecuted oracle inventory, and remaining blockers. Stop. No experiment launcher or follow-on environment provisioning is part of this plan.

## Plan review and execution choice

Tasks 1–7 are ordered: interface/projection decisions feed trusted initialization,
facade issuance, identity evidence, scenario integration, and packaging. No runtime
red/green cycle is authorized; preparation tooling provides a static red/green
cycle, while all behavioral assertions remain source-only and unexecuted.

Recommend **Native** execution in this session because the tasks share one
ownership boundary and source-only evidence chain. A fresh independent review
must respect the same no-execution limits and must not be represented as a
Finding CLOSE or execution approval. Subagent-driven execution is also possible
if selected; task implementers must receive both this plan and the approved spec.

Review this written plan and choose Native or Subagent-driven before implementation.
