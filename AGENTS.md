# Instructions for AI Agents (Nexus)

Nexus is a local-first MCP server for codebase indexing, hybrid search,
and precise context retrieval for AI agents.

Keep this file small. It should contain only instructions that apply to
nearly every agent task in this repository. Prefer authoritative docs over
duplicating details here.

## Project Map

- **Architecture**: single Node.js process combining the MCP server,
  search tools, and a background event-driven indexing pipeline. Read
  [SPEC.md](SPEC.md) before architecture or cross-module changes.
- **Configuration**: `.nexus.json` plus environment variables. Read
  [docs/configuration.md](docs/configuration.md) before changing config
  behavior.
- **Setup / install**: read [docs/setup.md](docs/setup.md). Installation
  has a mandatory user-choice step; see below.
- **Observability**: Prometheus metrics, dashboard, and Aggregator details
  live in [docs/observability/README.md](docs/observability/README.md).

## Mandatory Setup Protocol

When installing or configuring Nexus, ask the user to choose between
**Source Build** and **Package Usage** before running any setup commands.
Do not infer the choice. Follow [docs/setup.md](docs/setup.md) after the
user chooses.

Never ask the user to paste secrets or GitHub tokens into chat.

## Commands

Use the repository scripts instead of ad-hoc commands:

| Task | Command |
| --- | --- |
| Build | `npm run build` |
| Lint TypeScript | `npm run lint` |
| Test all | `npm test` |
| Test specific files | `npx vitest run <test-file...>` |
| Run locally | `npx tsx src/bin/nexus.ts` |
| Dashboard | `npx tsx src/bin/nexus.ts dashboard` |

If `.devcontainer/` is available, prefer running install, lint, build, and
tests inside the devcontainer. Do not run git commands inside the
devcontainer.

## Development Rules

- Use TypeScript with strict types. Do not add `as any`, `@ts-ignore`, or
  `@ts-expect-error` to bypass errors.
- Preserve local-first behavior. Do not introduce external data transmission
  unless the user explicitly asks for it and docs/configuration are updated.
- Do not commit machine-specific absolute paths, credentials, tokens, or
  generated local state.
- Do not create new project-level agent configuration files or directories.
  Edit existing canonical files only.
- Keep documentation concise. Link to the source of truth rather than copying
  long design notes into this file.

## Nexus MCP Usage Guidelines

When using Nexus tools in this or another repository:

1. Call `index_status` before search. If indexing is running, results may be
   incomplete.
2. Use `hybrid_search` for vague or architectural questions.
3. Use `grep_search` for exact symbols, errors, and strings.
4. Use `get_context` with `startLine` and `endLine`; avoid reading full files
   unless necessary.
5. After branch switches or large file changes, run `reindex` before relying
   on semantic results.

## Verification Expectations

- For code changes, run the narrowest meaningful Vitest command first, then
  broaden if the change crosses module boundaries.
- Run `npm run lint` before claiming TypeScript changes are complete.
- For documentation-only changes, read back the edited sections and check for
  stale links, duplicated instructions, and local absolute paths.
- If a verification command fails because of pre-existing issues, report the
  exact command and failure summary instead of masking the failure.
