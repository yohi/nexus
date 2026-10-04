# Nexus — Instructions for AI Agents

Local-first TypeScript Model Context Protocol (MCP) server for fast, evidence-based codebase search and exact symbol retrieval.

## Stack & Commands

- **Stack**: TypeScript, Node.js >=24, npm (`package-lock.json` authoritative), Vitest
- **Type Check**: `npx tsc --noEmit`
- **Lint**: `npm run lint`
- **Test (file)**: `npx vitest run <file>`
- **Test (all)**: `npx vitest run`
- **Build**: `npm run build` (run when changing public exports, CLI output, or package artifacts)

## Ground Rules

- **Deterministic verification**: Authoritative evidence comes from tests, type checking, and linters—not assumptions. Never use the agent as an expensive linter or formatter.
- **Local-first**: Keep code exploration and index state host-local. Never enable external embedding or data transmission unless explicitly instructed.
- **Secrets & State**: Never commit credentials, tokens, machine-specific paths, or generated local state (`.nexus/`). Never ask the user to paste secrets into chat.
- **Git discipline**: Do not commit, push, or open a pull request unless the user explicitly asks.
- **Initial Setup**: Before initial Nexus installation or setup, ask the user to choose **Source Build** or **Package Usage**. Do not choose on their behalf.
- **Agent Config**: Keep agent-specific instructions in `AGENTS.md` and `skills/`. Never create agent config files elsewhere, and do not duplicate agent rules into human documentation.

## Agent-Driven Setup

The canonical setup source is [docs/setup.md](docs/setup.md). CI (`.github/workflows/ci.yml`) and `package.json` scripts corroborate the contract.

When asked to set up the repository:

1. Inspect `docs/setup.md`, `package.json`, `package-lock.json`, and the working tree.
2. Ask the user to choose **Source Build** or **Package Usage** before installing dependencies.
3. Run setup commands per `docs/setup.md`. Reversible repository-local commands (`npm ci`, `npm run build`, `npm run lint`, `npm test`) do not require extra approval once mode is confirmed.
4. Use masked input or trusted credential stores for secrets; never request or print tokens in chat.
5. Load [skills/code-search/SKILL.md](skills/code-search/SKILL.md) into the current agent context.
6. Verify against two independent gates:
   - **MCP gate**: Report `MCP: connected` only when all five checks pass:
     the MCP client starts Nexus, `index_status` succeeds, search returns
     project results, `pipelineProgress.lastError` is absent, and
     `indexStats.lastIndexedAt` is set.
   - **Skill gate**: `skills/code-search/SKILL.md` is loaded and its workflow is ready (`Skill: loaded`).
   Report complete only when both gates pass; otherwise report the failed gate, non-secret output, and next safe action.

## Repository Map

- **Root (`src/`)**: MCP server, retrieval engines, storage, indexing pipeline, transport, and CLI
- **`packages/dashboard/`**: Observability and metrics dashboard
- **`skills/`**: Canonical task-specific repository skills

## Progressive Disclosure

To preserve the agent instruction budget, consult specialized documentation only when relevant to the task at hand:

- **Code search & retrieval workflow**: [skills/code-search/SKILL.md](skills/code-search/SKILL.md)
- **Architecture invariants & retrieval boundaries**: [SPEC.md](SPEC.md)
- **Structured AST parsing & catalog contracts**: [docs/structured-index.md](docs/structured-index.md)
- **MCP tool reference & schemas**: [docs/mcp-tools.md](docs/mcp-tools.md)
- **Runtime & watcher configuration**: [docs/configuration.md](docs/configuration.md)
- **Human setup & prerequisites**: [docs/setup.md](docs/setup.md)
- **Packaging & distribution**: [docs/distribution.md](docs/distribution.md)
- **Observability & Grafana dashboard**: [docs/observability/README.md](docs/observability/README.md)
- **Future product roadmap**: [ROADMAP.md](ROADMAP.md)
