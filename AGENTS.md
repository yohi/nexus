# Instructions for AI Agents (Nexus)

This is a local-first codebase indexing and hybrid search platform for AI agents via Model Context Protocol (MCP).

## 🚀 Onboarding

### 1. WHAT & WHY (Project Overview)

- **Purpose**: Provide local, secure semantic (LanceDB) and exact text (ripgrep) hybrid search capabilities.
- **Architecture**: A single process co-locating the MCP server and a background event-driven pipeline. For details, see [SPEC.md](SPEC.md).
- **Configuration**: Customizable via `.nexus.json` or env variables. See [docs/configuration.md](docs/configuration.md).

### 2. HOW (Development Commands)

- **Build**: `npm run build`
- **Test**: `npm test` or `npx vitest run`
- **Lint**: `npm run lint`
- **Dev/Run**: `npx tsx src/bin/nexus.ts`

---

## 🛑 Setup & Installation Critical Constraint

When installing or configuring Nexus, you **MUST ask the user to choose between Source Build and Package Usage before running any commands**. See [docs/setup.md](docs/setup.md) for the full installation protocol.
