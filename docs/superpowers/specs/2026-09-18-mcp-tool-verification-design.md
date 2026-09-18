# MCP Tool Verification Design

## Goal

Provide one repository-local command that starts the built Nexus CLI in an
isolated temporary project and directly invokes every registered MCP tool.
The command must report both successful tool behavior and lifecycle failures
without changing the user's project or persistent Nexus state.

## Scope

- Verify the nine tools currently registered by Nexus:
  `semantic_search`, `grep_search`, `hybrid_search`, `get_context`,
  `index_status`, `reindex`, `get_file_outline`, `get_symbol_source`, and
  `get_symbol_context`.
- Use the built CLI at `dist/bin/nexus.js` through the stdio MCP transport.
- Use a temporary TypeScript fixture and the local Ollama `bge-m3` embedding
  model so semantic and structured retrieval exercise the real runtime.
- Keep the verification Nexus-specific rather than introducing a generic MCP
  test framework or an agent skill.

## Non-goals

- Do not replace unit or E2E tests.
- Do not silently repair or skip a failed production behavior.
- Do not modify the caller's project, repository index, or global Nexus state.
- Do not add a project-level agent configuration file.

## Execution Flow

1. `scripts/verify-mcp-tools.mjs` checks that `dist/bin/nexus.js` exists.
2. The script creates a temporary project containing a TypeScript function with
   a unique marker and a local Ollama embedding configuration.
3. It removes inherited `NEXUS_*` environment values, then supplies only the
   verification embedding settings to make the run deterministic.
4. It starts Nexus with `StdioClientTransport` and protocol auto-negotiation.
5. It waits for `index_status` to report an idle pipeline, a non-null
   `lastIndexedAt`, and no pipeline or index error.
6. It invokes each tool with a valid fixture-specific request and records the
   observable response.
7. It invokes `reindex` directly with `fullRebuild: true` and
   `reason: "manual"`, then checks `index_status` again.
8. It records the cold-start structured retrieval result. If the structured
   index is unavailable, that is a failure, not a skipped test.
9. It restarts Nexus against the same temporary storage and invokes the three
   structured retrieval tools again. This separates recovery behavior from
   cold-start behavior while still exercising every tool directly.
10. It closes the MCP client, waits for the child process and project lock to
    disappear, and removes the temporary project in a `finally` path.

## Assertions

- `tools/list` contains exactly the nine expected tool names.
- `index_status` reaches an idle, error-free state.
- `grep_search` returns the fixture marker.
- `semantic_search` returns at least one fixture result.
- `hybrid_search` returns at least one fixture result and includes the marker
  in the merged result set.
- `get_context` returns the fixture marker for the requested line range.
- `reindex` returns a completed result with timing and reconciliation fields.
- `get_file_outline` returns `status: "ok"` in the healthy structured phase.
- `get_symbol_source` returns source containing the fixture marker.
- `get_symbol_context` returns context containing the fixture marker.

## Output And Exit Status

The default output is concise human-readable lines with one result per tool.
`--json` emits one machine-readable summary containing the command metadata,
tool results, structured-index phases, and failure details.

- Exit `0`: every required assertion passed.
- Exit `1`: a tool failed, a required result was missing, or cleanup failed.
- The output must identify the phase, tool name, failure reason, and sanitized
  response summary. It must not print secrets or inherited environment values.

## Repository Integration

Add an npm script named `verify:mcp-tools` that builds the repository and then
runs the verifier. The script itself remains executable directly for debugging
after a build. The verifier should not be part of the default `npm test`
command because it requires a running local Ollama service and performs a real
embedding operation.

## Verification Of The Verifier

The implementation is complete only when the following are run:

- `npm run verify:mcp-tools`
- `npm run build`
- `npm run lint`
- `npx tsc --noEmit`
- `npm test`

The known current branch behavior where the first automatic indexing pass leaves
the structured schema state as `reindex_required` must remain visible in the
verifier result until the production behavior is fixed separately.
