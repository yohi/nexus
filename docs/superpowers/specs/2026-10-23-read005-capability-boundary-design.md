# READ-005 capability boundary clarification

## Status and purpose

Status: **APPROVED — IMPLEMENTATION PLAN REVIEW REQUIRED**.

The user approved developing the boundary design and subsequently approved this
written design on 2026-10-23. This document records that approved contract; it does
not amend frozen inputs, close a finding, authorize implementation before plan
review, or authorize an experiment.

Resume the existing READ-001/READ-005 harness work by preventing ordinary case
code from acquiring the main stateful SDK Transport, Server, or equivalent
authority through composition, observer receipts, or initialization inputs.
Preserve actual Initialize-to-dispatch object identity and the final synchronous
authorization boundary.

This proposal concerns the isolated evidence harness associated with #305.
It does not implement the embedding-cache fingerprint requested in the current
GitHub issue body, and harness completion is not acceptance of that product fix.

## Evidence baseline

- Repository HEAD: `4fd4872d4baa4394dd3828040f4d52ac9cc9e02d`.
- Original archive: `nexus305-r3-read001-004-source-closure-evidence.zip`.
- Original SHA-256:
  `f98094211e2962ea21afd4187a2f1a93b80150cef7d6701c191f6aed27fff0ef`.
- SHA-256, ZIP CRC, and all 509 internal checksum entries were verified.
- The existing candidate's 20 owner/driver structural checks were rerun with
  `verify-main-owner-capability.mjs`; all returned `PASS_STATIC_ONLY`.

Sources of the unresolved design boundary:

- [Handoff contract](../../../evidence/read001-read005/handoff/00_INSTRUCTIONS.md).
- [Capability closure report](../../../evidence/read001-read005/candidate/READ_005_CAPABILITY_CLOSURE_REPORT.md).
- [Remaining blockers](../../../evidence/read001-read005/candidate/READ005_REMAINING_BLOCKERS.md).
- [Escape-path inventory](../../../evidence/read001-read005/candidate/CAPABILITY_ESCAPE_PATH_INVENTORY.json).

The original archive, baseline extraction, existing reports, frozen proposal,
R3 plan, SDK pins, command bindings, and oracle catalog remain historical inputs.
A future candidate revision must have its own diff and manifests rather than
silently replacing earlier attestations.

## Current failure paths

Paths below are relative to `evidence/read001-read005/candidate/`.

| Source                                       | Exposure                                                                          | Required disposition                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/drivers/integration.mjs:34`             | `assembleDrivers()` returns the Registry                                          | Keep the assembly result trusted; create a separate case-facing view              |
| `src/replay/assembly.mjs:37`                 | Receipts, ledger, authorizer, and observer-related objects escape together        | Keep the graph private; expose individually approved operations                   |
| `src/adapters/capability-registry.mjs:51–66` | `entry()` exposes provider methods; `sync()` and `call()` return provider results | Registry operations and their raw results stay inside the trusted graph           |
| `src/replay/session-observer.mjs:7,65–68`    | Public Registry and active receipts provide a route to actual objects             | Keep observer access private and export data-only evidence separately             |
| `src/replay/assembly.mjs:38`                 | Initialize accepts a caller-held Server                                           | Construct the Server internally from trusted setup, with no case-supplied factory |
| `src/readiness/scenario-runner.mjs:48–55`    | Spreading a provider result can expose arbitrary nested capabilities              | Project explicit per-case fields and wrap approved operations                     |

These are source-level paths, not demonstrated external publication successes.
Hiding only the top-level `registry` property does not close nested aliases.

## Alternatives and decision

1. **Trusted assembly plus an explicit case facade — recommended.** Retain real
   provider operations internally and reduce the capabilities distributed to
   ordinary cases. This addresses the composition boundary without inventing
   missing SDK APIs.
2. **Sanitize every Registry result globally.** This would break internal
   identity checks that require actual references and force unrelated provider
   contract changes. It also leaves caller-held Server aliases unresolved.
3. **Put cases and the SDK owner in separate processes.** This provides a stronger
   isolation boundary, but introduces IPC, lifecycle, and execution-environment
   work beyond the present source-only handoff. Defer it unless the threat model
   requires isolation from arbitrary same-process code execution.

The selected proposal is option 1. It is an object-capability distribution
boundary, not a JavaScript sandbox. Case code must not have arbitrary module
loading, debugger access, process memory access, trusted bootstrap injection, or
the ability to replace trusted prototypes. If the venue cannot establish those
constraints, capability closure remains unproven and requires separate isolation
design; an empty or frozen object cannot establish that guarantee.

## Proposed ownership contract

### Trusted composition and initialization

The trusted bootstrap exclusively holds the Registry, enrolled providers,
observer, receipts, ledger, gate, raw publication targets, and SDK objects.
Internal assembly functions may communicate these objects only within that
trusted graph. Their return values are not ordinary Case Context values.

The bootstrap constructs and configures each Server using the pinned SDK and
trusted registration setup. Ordinary cases cannot supply a Server, a factory,
an arbitrary setup callback, or an SDK module. Object ownership cannot be
transferred safely by promising that an external caller discarded its alias.

Initialize consumes case request data through the trusted ingress and target
resolver. Caller-provided data never supplies a live response writer, provider,
barrier callback, event store, or owner envelope with independently conferred
authority. Such resources are resolved through trusted enrollment.

The same internally created Server and stateful Transport are retained for
Initialize and subsequent main dispatch. Existing completion, final publication,
durable ACTIVE readback, anchor, and mapping-cleanup conditions still apply.
No new SDK method or reflection-based transport discovery is introduced.

### Ordinary Case Context

Construct an explicit, per-case facade with only the operations required by that
case's existing contract. For the main Web path, the permitted surface is:

- Initialize using approved request data; return an opaque main-session handle.
- Route a request using that handle and trusted target resolution.
- Reconnect through the authenticated ReplayBroker route.
- Read a data-only diagnostic/evidence snapshot.

These are proposed harness-facing operations, not claims about existing SDK APIs.
Each invocation independently checks current execution authorization when
applicable, caller/principal, boot, session ownership, and the operation's existing
admission conditions. Possession of a facade or handle alone grants no bypass.

Do not expose `register`, Registry `entry/sync/call`, observer methods, raw
receipts, authority-mutating functions, raw publication functions, generic method
dispatchers, or arbitrary callbacks. Do not spread provider or scenario results.
An additional case operation needs an explicit contract and allowlist; absence
of that contract is a blocked case, not permission for a generic escape hatch.

Facade methods close over trusted objects. They neither return those objects nor
return functions bound to arbitrary provider methods. Public results are built
field by field from permitted data. Errors are projected to stable codes without
raw causes or attached capability-bearing objects.

Handles retain the existing empty, null-prototype, frozen-object representation
and private WeakMap identity. Cloning, serialization, string IDs, prototypes, and
cross-owner handles never recreate registration. Recursive output inspection
must reject unexpected functions, accessors, prototypes, and nested live objects;
freezing a raw result is not sanitization.

### Internal identity observation and public evidence

Keep actual Transport/Server reference comparison inside the trusted owner and
independently enrolled observer path. A provider may need those references within
that trusted path; neither its raw receipt nor a callable reference to that path
is distributed to cases.

Export a separate, data-only evidence projection containing its schema version,
observation kind, boot ID, session ID, transport ID, attempt nonce, active commit
token, relevant request/principal binding, observer enrollment reference, and raw
artifact reference plus SHA-256 digest. Only fields relevant to that observation
are included. Exclude raw objects, callbacks, authentication tickets, credentials,
and raw request bodies.

An independent observer must attest the actual equality observation and its
context. A third-party reviewer must be able to retrieve the referenced artifact,
verify its digest and enrolled provenance, and correlate it with the source and
run. A digest proves byte integrity, not observation truth or authorization.
Owner-generated booleans, hashes, or arbitrary strings are insufficient evidence.
The concrete venue issuer/verifier and artifact channel must be independently
enrolled before a runtime identity claim is accepted; this proposal does not
invent or attest that missing provider.

The exported receipt does not replace internal equality checks and is never an
admission credential. Forged or replayed public receipts cannot authorize dispatch.

### Synchronous dispatch and lifecycle

After all asynchronous admission work, preserve synchronous checks of current
principal, durable ACTIVE ownership, boot, lifecycle, authority, grant, actual
object identity, and `verifyMainDispatchSync`. No `await`, user callback, or
publication hook may appear between the final verification/guard and the actual
owner-internal SDK dispatch. Do not substitute the public receipt for this check.

Ordinary cases receive no main close operation. Existing driver `close()` remains
fail-closed with `MAIN_OWNER_CLOSE_AUTHORITY_UNSPECIFIED`; no general owner-close
contract is added. SDK lifecycle callbacks retain the existing synchronous denial
and fencing behavior before further dispatch, with existing durable state and
grant revocation behavior. Initialization failure cleanup remains internal.
Individual request abort is not session termination; process crash and restart
retain their existing suspension and fresh-Initialize requirements.

Replay stays on ReplayBroker and a fresh private stateless renderer. Its cleanup
does not close the main stateful Transport. DES-001–003, C0/F1/P, stored-auth
non-promotion, terminal claims, and INV-01–07 are not redefined.

## Verification contract

Implementation under the current handoff is source-only. Prepare oracle source
without importing or executing harness, SDK, scenario, or test modules.

| Oracle                | Required falsifiable assertion                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Identity              | Initialize and later dispatch use the same actual Server/Transport; independently observed artifacts bind that comparison            |
| Transitive escape     | No raw SDK/provider authority is reachable through case facades or their results; only approved operations and opaque handles remain |
| Handle forgery        | Clone, spread, JSON, string IDs, prototype manipulation, foreign owner, and foreign boot cannot authorize SDK dispatch               |
| Direct bypass         | Registry/provider methods, raw SDK methods, callback injection, and raw publication are unavailable to an ordinary case              |
| Current authorization | Wrong principal, expired/revoked ownership, stale ACTIVE token, changed boot, and revoked authority yield zero unauthorized dispatch |
| Final boundary        | AST inspection preserves synchronous final verification immediately before SDK dispatch                                              |
| Lifecycle             | Early close is denied; request abort, session close, restart, and renderer cleanup remain distinct                                   |
| Receipt forgery       | Copied or fabricated public evidence cannot authorize dispatch; missing artifact/provenance cannot pass identity verification        |
| Catalog preservation  | Frozen 234 bindings, Safe117/Negative117, and 61 oracle cells remain byte-identical and unexecuted                                   |

Static checks can establish structural conditions and syntax/API compatibility,
not actual object identity, venue trust, runtime non-reachability, or publication.
Each unrun oracle remains `NOT_EXECUTED`; negative observations remain `UNKNOWN`.
Static success is at most `PASS_STATIC_ONLY`.

## Review and implementation handoff

The following decisions were approved as one boundary contract:

1. Trusted-only assembly with explicitly projected per-case operations/results.
2. Internal Server construction without ordinary-case factories or retained aliases.
3. Private identity observation with separately verifiable public evidence.
4. Continued denial of main close and preservation of existing dispatch/lifecycle
   ordering and frozen experiment contracts.

After written-design approval, prepare an implementation plan for a new isolated
candidate revision. The plan must enumerate changed call sites and fixtures,
static checks, source-only oracles, compatibility changes, and new evidence
manifests. It must identify how the trusted bootstrap and case import boundary
are enforced, rather than assuming that changing a return shape proves isolation.
Any missing venue capability remains an explicit blocker.

Independent implementation review follows source integration. Its outcome cannot
be self-declared by the implementer. READ-002 remains `SDK_API_CONTRACT_BLOCKED`;
READ-003/004 and ENV-001–003 retain their existing unresolved evidence gaps.

Current state remains: **R3 Execution Gate=NOT_AUTHORIZED; R3=NOT_EXECUTED;
Section4.1=BLOCKED; R1-001-04=UNRESOLVED;
234 Binding=BLOCKED/NOT_EXECUTED**.
