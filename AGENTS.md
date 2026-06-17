# Instructions for AI Agents (Nexus)

This is a local-first codebase indexing and hybrid search platform for AI agents via Model Context Protocol (MCP).

## 🚀 Onboarding

### 1. WHAT & WHY (Project Overview)
- **Purpose**: Provide local, secure semantic (LanceDB) and exact text (ripgrep) hybrid search capabilities.
- **Architecture**: A single process co-locating the MCP server and a background event-driven pipeline. For details, see [SPEC.md](file:///home/y_ohi/program/nexus/SPEC.md).
- **Configuration**: Customizable via `.nexus.json` or env variables. See [docs/configuration.md](file:///home/y_ohi/program/nexus/docs/configuration.md).

### 2. HOW (Development Commands)
- **Build**: `npm run build` (builds typescript and package workspaces).
- **Test**: `npm test` or `npx vitest run` (runs unit, integration, and stress test suites).
- **Lint**: `npm run lint` (runs ESLint checks).
- **Dev/Run**: Use `npx tsx src/bin/nexus.ts` for running/testing locally without building.

---

## 🛑 Installation & Setup Protocol (MANDATORY)
If you are tasked with installing or configuring Nexus, you **MUST** follow this protocol before running any other commands:

1. **ZERO COMMANDS**: Do not run any shell commands (npm, node, etc.) before the user makes a choice.
2. **MANDATORY INTERACTION**: Use your interaction tool (e.g., `ask_user`, `input`) to let the user select their intent:
   - **A. Source Build (Recommended)**: Build and develop Nexus directly in this repository.
   - **B. Package Usage**: Integrate `@yohi/nexus` into an external project.
3. **NO AUTONOMOUS DECISIONS**: Do not make the decision on behalf of the user.
4. **Credential Privacy**: Never ask for token/PAT inputs in chat.

### IF CHOICE A: SOURCE BUILD (Local Development)
- **Happy Path**: Try running `npm install && npm run build` first.
- **Fallback**: If installation fails due to missing token auth, run `node scripts/bootstrap.mjs` (automatically bypasses NPM token requirements).
- **Verify**: Run `npm test` and verify that `dist/bin/nexus.js` exists.

### IF CHOICE B: PACKAGE USAGE (External Integration)
- **GitHub Packages**: Requires `NEXUS_GH_PACKAGE_TOKEN`. If missing, prompt the user to export it in their shell.
- **Git URL**: Install tokenless via `npm install github:yohi/nexus`.
- **Project Setup**: Configure the external project's `.npmrc` to point `@yohi:registry` to `https://npm.pkg.github.com`.
