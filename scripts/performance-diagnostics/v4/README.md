# Performance Diagnostics Kit v4

This source directory is a versioned successor to the existing v3 archive. The v3 ZIP files are left untouched. Nothing in this directory is enabled by the normal performance runner.

## Files

- `clock_conformance.py` launches only a short-lived Node clock probe. Capture a `start` record before a future diagnostic and an `end` record after it using the same Node executable. The TypeScript clock-domain parser and calibrator compare their boot ID, source, resolution, minimum-round-trip offset intervals, and uncertainty. This helper does not launch Vitest or a benchmark worker.
- `worker_profile_preload.cjs` is an opt-in Node preload. It does nothing unless `NEXUS_PERF_DIAGNOSTIC_REQUEST_FILE` names a valid request. The runner must create a mode-0600 request file and an owned mode-0700 run directory before enabling it.
- `profile-event-sink.cjs` writes process-specific mode-0600 event and profile files under the validated run directory. It bounds event JSONL to 4,096 events/8 MiB and profile files to 64 MiB per segment. `profile-run-budget.cjs` serializes profile writes using an exclusively created run-owned lock and checks the total profile directory size against 512 MiB. A present or stale lock fails closed without deleting it. The supervisor must independently verify the run-wide budget and cleanup before admitting evidence.
- `summarize_profiles.py` validates one profile under the 64 MiB segment limit and emits only sample counts and fixed source categories. It does not output function names, URLs, paths, or raw profile content.

## Status and evidence limits

Profile lifecycle events carry a segment ID and monotonic timestamp for start, stop request, stop completion, and write completion/failure. Start and stop failures are distinct from write failures. `profilesMissing` counts distinct observed segment failures; it does not imply that abrupt exits or lost lifecycle events are complete. The terminal event's `profilesMissingExact` is false when the bounded missing-segment identity set overflows; the numeric count is then a lower bound. Dropped events are reported separately. The worker's terminal event is always provisional and non-admissible. Only a supervisor that independently verifies process identity, clock alignment, trace completeness, audit/state integrity, and cleanup may finalize diagnostic admissibility.

Raw `.cpuprofile` files are confidential local artifacts. Profile presence alone does not prove CPU-active worker execution, stage attribution, root cause, or baseline validity. Do not use these scripts to start a performance run until the separate diagnostic runner and its host/safety gates are implemented and reviewed.

The shared lock is cooperative and assumes the owned run directory is not modified by unrelated same-user processes. A partial profile remains in the owned directory after a failed write and counts toward the next budget check; it is not successful profile evidence. If lock identity cannot be verified, the lock is left in place and later writes fail closed. The supervisor must check ownership, partial artifacts, and lock integrity independently.
