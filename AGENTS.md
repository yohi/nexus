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
- **Agent Config**: Keep agent-specific instructions in `AGENTS.md` and `.agents/skills/`. Never create agent config files elsewhere, and do not duplicate agent rules into human documentation.

## Repository Map

- **Root**: MCP server, retrieval engines, storage, indexing pipeline, transport, and CLI
- **`packages/dashboard/`**: Observability and metrics dashboard
- **`.agents/skills/`**: Canonical task-specific repository skills

## On-Demand Context (Progressive Disclosure)

Read specialized documentation only when relevant to the task:

- **Code search & investigation**: Load [.agents/skills/code-search.md](.agents/skills/code-search.md) before searching or tracing codebase implementation.
- **Architecture & behavioral contracts**: Consult [SPEC.md](SPEC.md).
- **Future product direction**: Consult [ROADMAP.md](ROADMAP.md).
- **MCP tool reference**: Consult [docs/mcp-tools.md](docs/mcp-tools.md).
- **Runtime configuration**: Consult [docs/configuration.md](docs/configuration.md).
- **Human setup & prerequisites**: Consult [docs/setup.md](docs/setup.md).
- **Packaging & distribution**: Consult [docs/distribution.md](docs/distribution.md).
- **Observability & Grafana dashboard**: Consult [docs/observability/README.md](docs/observability/README.md).
