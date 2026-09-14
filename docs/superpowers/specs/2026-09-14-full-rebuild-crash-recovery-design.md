# Full Rebuild Crash Recovery Design

**Goal:** Keep the SQLite structured catalog, LanceDB vector tables, and Merkle metadata at one rebuild generation after a process interruption.

**Decision:** SQLite remains the durable source of truth for the full-rebuild journal. The journal records the rebuild epoch, commit phase, vector artifact names, and the pre-commit Merkle snapshot. LanceDB temporary names are deterministic for the rebuild so startup can identify the exact artifacts without relying on process-local backup handles.

## Commit Protocol

The coordinator records these phases in order:

1. `prepared`: catalog backup and Merkle snapshot are durable.
2. `legacy-swapped`: the legacy `chunks` table has been promoted.
3. `structured-swapped`: the structured table has been promoted.
4. `catalog-activated`: SQLite active generations have been promoted.
5. `merkle-activated`: deferred Merkle mutations have completed.
6. `finalized`: all backups and journal rows have been removed.

An interruption before `merkle-activated` rolls all stores back to the recorded snapshot. An interruption at or after `merkle-activated` preserves the new generation and only finishes cleanup. A finalized rebuild never rolls back merely because cleanup artifacts remain.

## Startup

Metadata initialization identifies a journal by its durable phase and epoch rather than by arbitrary backup rows. The runtime startup reconciliation then resolves the vector artifacts, restores or completes the catalog and Merkle state, and removes all resolved temporary tables. Standalone vector-store initialization removes unreferenced shadow, replacement, and backup tables; journal-referenced artifacts are retained until coordinated reconciliation.

## Testing

Regression coverage includes phase-specific recovery decisions, stale backup rows from earlier epochs, cleanup after finalize failure, restart recovery of both vector tables, Merkle restoration, and deletion of all six temporary-table prefixes without deleting `chunks` or `structured_chunks`.
