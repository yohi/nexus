# Nexus — Instructions for AI Agents

Local-first TypeScript Model Context Protocol (MCP) server for fast, evidence-based codebase search and exact symbol context retrieval.

## Stack & Commands

- **Stack**: TypeScript, Node.js >=24, npm (`package-lock.json` authoritative), Vitest
- **Type Check**: `npx tsc --noEmit`
- **Lint**: `npm run lint`
- **Test (file)**: `npx vitest run <file>`
- **Test (all)**: `npx vitest run`
- **Build**: `npm run build` (run when changing public exports, CLI output, or package artifacts)

## Ground Rules

- **Deterministic verification**: Authoritative evidence comes from tests, type checking, linting, and build output—not assumptions.
- **Local-first**: Keep code exploration local. Never enable external embedding or data transmission unless explicitly instructed.
- **Secrets & State**: Never commit credentials, tokens, machine-specific paths, or generated local state. Never ask the user to paste secrets into chat.
- **Initial Setup**: Before initial Nexus installation or setup, ask the user to choose **Source Build** or **Package Usage**. Do not choose on their behalf.
- **Agent Config**: Keep agent-specific instructions in `AGENTS.md` and `skills/`. Never create agent config files elsewhere, and do not duplicate agent rules into human documentation.

## Agent-driven setup

The canonical setup source for this repository is `docs/setup.md`. CI (`.github/workflows/ci.yml`) and `package.json` scripts corroborate the setup contract.

When asked to set up the repository:

1. Use `repository_inspection` (read, list, and search repository files) to read `docs/setup.md` and inspect `package.json` scripts, `package-lock.json`, and the working tree.
2. Use `structured_ask` (a user-choice prompt) to obtain the required Source Build or Package Usage selection and approval before installing dependencies. If unavailable, ask in plain chat and record the fallback.
3. Use `command_execution` (a terminal command runner) to run the setup commands defined by the canonical source. After that selection and approval, reversible, repository-local commands such as `npm ci`, `npm run build`, `npm run lint`, and `npm test` may run without an additional approval.
4. Use `secret_input` (masked input, a trusted terminal, or a credential store fallback) for any required secret, such as GitHub Packages credentials for `@yohi/nexus` package mode. Never request or print secret values in normal chat.
5. After the environment is ready, use `repository_inspection` to check `skills/` and load any skill relevant to the task at hand. The canonical code-search workflow is in `skills/code-search/SKILL.md`.
6. Verify setup by running the repository-defined test command (`npm test`), then follow [Verify the Installation](docs/setup.md#verify-the-installation) and [Verify the Skill](docs/setup.md#verify-the-skill) in the canonical setup guide. If a step fails, report the non-secret output and next safe action.

Setup has two independent completion gates:

- **MCP gate**: the selected MCP client starts Nexus, `index_status` succeeds, and a small `grep_search` or `hybrid_search` query returns project results. Report this as `MCP: connected` only after all checks pass.
- **Skill gate**: `skills/code-search/SKILL.md` is available from the checkout or its GitHub Raw URL, is loaded into the current agent context, and its workflow is available for use. Report this as `Skill: loaded`; do not claim vendor-global installation for a generic agent.

Setup is complete only when both gates pass. If either gate fails, report the failed gate, non-secret output, current repository state, and next safe action.

Do not commit, push, or open a pull request unless the user explicitly asks.

## Repository Map

- **Root**: MCP server, retrieval engines, storage, indexing pipeline, transport, and CLI
- **`packages/dashboard/`**: Observability and metrics dashboard
- **`skills/`**: Canonical task-specific repository skills

## On-Demand Context (Progressive Disclosure)

Read specialized documentation only when relevant to the task:

- **Code search & investigation**: Load [skills/code-search/SKILL.md](skills/code-search/SKILL.md) before searching or tracing codebase implementation.
- **Architecture & behavioral contracts**: Consult [SPEC.md](SPEC.md).
- **Future product direction**: Consult [ROADMAP.md](ROADMAP.md).
- **MCP tool reference**: Consult [docs/mcp-tools.md](docs/mcp-tools.md).
- **Runtime configuration**: Consult [docs/configuration.md](docs/configuration.md).
- **Human setup & prerequisites**: Consult [docs/setup.md](docs/setup.md).
- **Packaging & distribution**: Consult [docs/distribution.md](docs/distribution.md).
- **Observability & Grafana dashboard**: Consult [docs/observability/README.md](docs/observability/README.md).
