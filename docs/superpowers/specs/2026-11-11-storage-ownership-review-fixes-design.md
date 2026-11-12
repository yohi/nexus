# Storage Ownership Review Fixes Design

## Goal

Address the confirmed review findings around storage ownership admission, filesystem identity, startup coordination, runtime shutdown, and the associated documentation. Preserve existing ownership decisions, error classifications, and operation ordering except where a finding requires stricter rejection or cancellation.

## Design

### Admission and claims

After resolving targets asynchronously, admission validation must re-check that the registered handle remains `ISSUED`, every required kernel lease remains held, and the resolved target fingerprint matches the admitted fingerprint. Handle state or lease loss is refused as `invalid_writer_admission`; witness absence or mismatch is refused as `incarnation_mismatch`.

Claim reads must open with `O_NOFOLLOW`, read through the opened handle, and confirm that the opened inode and size correspond to the regular file inspected before parsing. Coordination-root setup must validate parent ownership and permissions as well as root permissions. It must keep the verified parent/root identity stable through lock use using existing safe filesystem mechanisms.

Preflight ancestor-claim validation must require both the expected ancestor resource path and `directory` kind, consistent with writer admission. Invalid ancestor claims and path/kind mismatches are refused as `owner_unknown`; a different owner is `owner_conflict`; a witness-binding failure is `incarnation_mismatch`. Unclaimed empty bootstrap directories remain ownership-neutral: a failed admission does not award them to another owner, but a later owner may acquire them only after complete revalidation. Partial same-owner claims remain unavailable to a different owner.

### Startup and runtime lifecycle

The Bridge's endpoint polling receives cancellation; definite child failure cancels outstanding polling and releases its timers. Ownership preflight and waiting both observe cancellation.

Runtime close and lease-loss paths record a permanent terminal state. `NexusRuntime` exposes the optional `terminate?(): void` lifecycle hook used to enter that state synchronously. In-flight and subsequent initialization stop at asynchronous boundaries, including after index-stat reads, before metrics-port writes or startup-reindex metadata changes. Any watcher that has started is stopped as part of shutdown.

### Bounded log reads and complexity

Startup attempt logs are read from the end of the file up to the existing byte limit, without synchronously loading the entire file or allocating its full decoded string. Existing output content semantics and upper bounds are retained.

The specified complexity refactors extract focused helpers for directory ancestor discovery and post-create verification, `/proc/locks` line matching, preflight claim and unclaimed-directory evaluation, and witness bounded reads and JSON validation. Existing order, verdicts, validation rules, limits, and error behavior are preserved.

## Verification

Add or update focused tests for the race/cancellation and identity boundaries, rejection conditions, terminal runtime behavior, bounded log tail behavior, and refactored verdict/lock decisions. Then run the repository's TypeScript type check, lint, focused tests, and complete test suite.

## Scope

Affected implementation modules are `src/server/index.ts` (`buildNexusRuntime` and `NexusRuntime`), `src/server/runtime-assembly.ts`, `src/server/project-connector.ts`, and the applicable files under `src/server/storage-ownership/` (including admission, claim-format, claims, preflight, startup-gate, and witness). Also update the reviewed `SPEC.md` contract and focused tests. The optional `NexusRuntime.terminate?(): void` method is an intentional public interface change; cancellation signals threaded through private connector and ownership functions remain internal.
