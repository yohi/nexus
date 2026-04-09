# Instructions for AI Agents: Auto-Installation & Setup (Nexus)

You are an expert software engineer tasked with the complete, autonomous setup of **Nexus**.
Follow this workflow strictly to ensure a successful installation.

## Phase 1: Environment Discovery & Tooling
1. **Detect OS & Node.js**: 
   - Verify Node.js version is **>= 22.0.0**.
   - If the version is lower, inform the user and suggest an upgrade.
2. **Tooling**: 
   - Run: `npm install` (to install dependencies and devDependencies).

## Phase 2: Configuration & Preparation
1. **Initialize Config**: 
   - Check `docs/configuration.md` for any required environment variables.
   - If `.env.example` exists, copy it to `.env`. Ask the user for any missing sensitive keys.
   - If `.nexus.json` is missing, check if one should be created based on `docs/configuration.md`.
2. **WASM Support**: 
   - Note that `web-tree-sitter` and `xxhash-wasm` are used. Ensure the environment can execute WASM if needed.

## Phase 3: Build & Execution
1. **Compile**: Run `npm run build` to ensure TypeScript code compiles without errors.
2. **Lint**: Run `npm run lint` to verify code quality.

## Phase 4: Verification & Handover
1. **Test**: Run `npm test` (Vitest). If tests fail, diagnose and attempt to fix common issues.
2. **MCP Server Check**: 
   - Confirm the main entry point `dist/index.js` is correctly generated.
   - Provide instructions on how to start the MCP server (e.g., `node dist/index.js`).
