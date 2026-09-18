# MCP Tool Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Nexus-specific command that starts the built CLI in an isolated temporary project and directly verifies all nine registered MCP tools.

**Architecture:** Keep `scripts/verify-mcp-tools.mjs` as the executable verifier and export only its pure result-validation helpers for fast unit tests. The runner uses the installed MCP client over stdio, a local Ollama embedding configuration, and two Nexus lifecycles so cold-start structured-index failures remain visible while restart recovery is also checked.

**Tech Stack:** Node.js ESM, `@modelcontextprotocol/client`, `@modelcontextprotocol/sdk` stdio transport, Vitest, local Ollama `bge-m3`, and the existing compiled `dist/bin/nexus.js`.

## Global Constraints

- Preserve Node.js `>=24.0.0` from `package.json`.
- Use the repository's npm/package-lock dependency set; do not add a new MCP client dependency.
- Use only a temporary project and local Ollama; never transmit project content to an external embedding service.
- Strip inherited `NEXUS_*` values before starting the child and do not print environment values or secrets.
- Treat a missing or failed tool response as a verifier failure; never skip a tool silently.
- Always close the MCP client, wait for the child and project lock to end, and remove the temporary directory in `finally`.
- Do not create agent configuration files or modify the user's project index.
- Do not commit or push as part of implementation unless explicitly requested.

---

### Task 1: Define Verifier Result Contracts

**Files:**
- Create: `tests/unit/scripts/verify-mcp-tools.test.ts`
- Create: `scripts/verify-mcp-tools.mjs`

**Interfaces:**
- Produces `EXPECTED_TOOL_NAMES`, `validateToolList(actualNames)`, `summarizeToolResult(phase, toolName, result)`, and `validateToolResult(toolName, result, marker?)` exports for unit tests and the executable runner.
- `summarizeToolResult` returns a sanitized JSON-compatible record containing the tool name, phase, pass/fail state, status/reason code, and bounded failure detail.
- `validateToolResult` returns `{ ok: true }` or `{ ok: false, reason: string }` and validates observable response fields rather than implementation details. When supplied, `marker` must appear in the relevant search, context, source, or symbol-context payload.

- [x] **Step 1: Write the failing unit tests**

  Cover these Given/When/Then cases:

  - Given the exact nine expected names, When validating the `tools/list` names, Then the result is successful.
  - Given a missing `get_symbol_context` name, When validating the list, Then the result identifies the missing name.
  - Given a `grep_search` result containing the fixture marker, When validating it, Then the result is successful.
  - Given `get_file_outline` with `status: "not_indexed"` and `reasonCode: "STRUCTURED_INDEX_MISSING"`, When validating it, Then the result fails instead of treating it as a skip.
  - Given successful outline, source, and context responses containing the fixture marker, When validating them, Then all three results succeed.

  Run: `npx vitest run tests/unit/scripts/verify-mcp-tools.test.ts`

  Expected: FAIL because `scripts/verify-mcp-tools.mjs` and its exported contracts do not exist.

- [x] **Step 2: Implement the minimum pure contracts**

  Add the nine-name constant in the current registry order. Implement validators for the tool-list shape, search/match presence, context marker presence, successful structured status, and completed reindex fields. Keep validation independent from the returned value used as the expected value.

- [x] **Step 3: Run the focused tests**

  Run: `npx vitest run tests/unit/scripts/verify-mcp-tools.test.ts`

  Expected: PASS for all contract cases.

### Task 2: Implement The Live MCP Runner

**Files:**
- Modify: `scripts/verify-mcp-tools.mjs`

**Interfaces:**
- Consumes the validators from Task 1 and the built CLI at `dist/bin/nexus.js`.
- Produces a command-line verifier with `--json` output and exit code `0` only when all required assertions pass.

- [x] **Step 1: Add temporary fixture and isolated environment setup**

  Create a unique temporary directory with `mkdtemp`, write `fixture.ts` containing one exported function with a unique marker, and write `.nexus.json` for Ollama `bge-m3` with dimensions `1024`, loopback base URL, zero retries, and a bounded timeout. Remove inherited `NEXUS_*` variables before constructing the child environment.

- [x] **Step 2: Add stdio lifecycle and readiness polling**

  Start `node dist/bin/nexus.js --project-root <temp-root>` with `StdioClientTransport`. Construct the MCP client with protocol auto-negotiation. Poll `index_status` until the pipeline is idle, `lastIndexedAt` is non-null, and both pipeline/index errors are absent; fail with a bounded timeout otherwise.

- [x] **Step 3: Invoke every tool in the first lifecycle**

  Call `tools/list`, `index_status`, `grep_search`, `semantic_search`, `hybrid_search`, `get_context`, `get_file_outline`, and `reindex` directly. Use these requests:

  - `grep_search`: `{ pattern: <marker> }`
  - `semantic_search`: `{ query: "function returning the verification marker", topK: 5 }`
  - `hybrid_search`: `{ query: "function returning the verification marker", grepPattern: <marker>, topK: 5 }`
  - `get_context`: `{ filePath: "fixture.ts", startLine: 1, endLine: 1, mode: "eager" }`
  - `get_file_outline`: `{ filePath: "fixture.ts" }`
  - `reindex`: `{ fullRebuild: true, reason: "manual" }`

  Record each response through the validators. Keep the cold-start outline failure as a reported failure.

- [x] **Step 4: Add restart recovery phase for structured tools**

  Close the first client and wait for the child and project lock to end. Start a second Nexus child against the same temporary storage, call `index_status`, then use the returned outline symbol ID to call `get_file_outline`, `get_symbol_source`, and `get_symbol_context` with `tokenBudget: 128`. Require `status: "ok"` and the fixture marker in source/context.

- [x] **Step 5: Add output, error handling, and cleanup**

  Emit one concise human-readable result per phase/tool by default. With `--json`, emit one JSON summary containing tool results, phase states, and sanitized errors. Set exit code `1` for any failed assertion, missing tool, timeout, child failure, or cleanup failure. Use `try/finally` for MCP transport closure, child termination, lock polling, and temporary-directory removal.

- [x] **Step 6: Run the live verifier**

  Run: `npm run build && node scripts/verify-mcp-tools.mjs --json`

  Expected on the current branch: all nine tools are invoked; search, reindex, and restart-phase structured retrieval pass; the cold-start structured-index assertion reports the known `STRUCTURED_INDEX_MISSING` behavior and the command exits `1`.

### Task 3: Integrate The Command And Document Usage

**Files:**
- Modify: `package.json:43-53`
- Modify: `docs/setup.md`
- Modify: `docs/mcp-tools.md`

**Interfaces:**
- Produces the discoverable command `npm run verify:mcp-tools`.
- Documents prerequisites, invocation, output modes, and the meaning of a cold-start structured-index failure.

- [x] **Step 1: Add the npm command**

  Add `"verify:mcp-tools": "npm run build && node scripts/verify-mcp-tools.mjs"` without changing the default `npm test` command.

- [x] **Step 2: Document prerequisites and interpretation**

  Add the command to the verification section of `docs/setup.md`, state that local Ollama with `bge-m3` is required, and document `--json`. Add a short MCP tools note to `docs/mcp-tools.md` explaining that the verifier invokes all nine tools and returns non-zero when a tool or lifecycle assertion fails.

- [ ] **Step 3: Check documentation formatting**

  Run: `npx markdownlint-cli2 docs/setup.md docs/mcp-tools.md docs/superpowers/specs/2026-09-18-mcp-tool-verification-design.md docs/superpowers/plans/2026-09-18-mcp-tool-verification.md`

  Current result: the repository-wide command reports 72 existing MD013/MD032 errors. No lint configuration or unrelated documentation was changed.

### Task 4: Run The Full Verification Matrix

**Files:**
- Verify: `scripts/verify-mcp-tools.mjs`
- Verify: `tests/unit/scripts/verify-mcp-tools.test.ts`
- Verify: `package.json`

- [x] **Step 1: Run the new command**

  Run: `npm run verify:mcp-tools`

  Expected: the command invokes all nine tools, reports the current cold-start structured-index failure if it remains unfixed, and cleans up its temporary project and child process.

- [x] **Step 2: Run static and unit/integration gates**

  Run: `npm run build`

  Run: `npm run lint`

  Run: `npx tsc --noEmit`

  Run: `npm test`

  Expected: each command exits `0`.

- [x] **Step 3: Run the existing E2E suite**

  Run: `npm run test:e2e`

  Expected: all existing E2E tests pass, including the nine-tool list and managed endpoint cleanup after the final bridge client disconnects.

- [x] **Step 4: Verify repository state**

  Run: `git status --short --branch`

  Expected: only the intended script, test, package, and documentation files are modified; no temporary project, credentials, or generated local state is present.
