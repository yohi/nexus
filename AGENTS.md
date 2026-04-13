# Instructions for AI Agents: Auto-Installation & Setup (Nexus)

You are an expert software engineer tasked with the setup of **Nexus**.
**CRITICAL PROTOCOL**: 
- You are forbidden from choosing an installation method on behalf of the user. Use `ask_user`.
- **NEVER** ask the user to type sensitive tokens/PATs directly into the chat. 
- If a token is missing, instruct the user to ensure the token is exported in their shell environment (e.g., via `export NEXUS_GH_PACKAGE_TOKEN=...`) before running bootstrap, and wait for their confirmation via the `ask_user` tool.

## Step 0: User Decision via Tool (MANDATORY)
Call `ask_user` to choose between:
- **A. Source Build (Recommended)**: For full development within this repository.
- **B. Package Usage**: To integrate `@yohi/nexus` into an external project.

---

## IF CHOICE A: SOURCE BUILD

### Phase 1: Environment Discovery & Tooling
1. **Detect OS & Node.js** (>= 22.0.0).
2. **Architecture**: Read `SPEC.md`.

### Phase 2: Credentials Setup (CRITICAL)
1. **Check for Token**: Verify if `NEXUS_GH_PACKAGE_TOKEN` is exported in the shell environment.
2. **Handle Missing Token**: If missing or if `npm install` (in `scripts/bootstrap.mjs`) fails due to 401/403:
   - **Action**: Inform the user: "Please run `export NEXUS_GH_PACKAGE_TOKEN=your_pat_here` in your terminal, or add it to a `.env` file and ensure it's loaded into the environment before running bootstrap."
   - **Wait**: Call `ask_user` (type: `yesno`) with the question: "Have you exported `NEXUS_GH_PACKAGE_TOKEN` in your shell environment?"
   - **Retry**: Only proceed after the user confirms.
3. **Bootstrap**: Run `node scripts/bootstrap.mjs`.

### Phase 3: Verification & Handover
1. **Test**: Run `npm test` (Vitest). If tests fail, diagnose and attempt to fix common issues.
2. **MCP Server Check**: 
   - Confirm the main entry point `dist/bin/nexus.js` is correctly generated.
   - Provide instructions on how to start the MCP server.

---

## IF CHOICE B: PACKAGE USAGE

### Phase 1: Credentials & .npmrc Preparation
1. **Token Check**: Verify `NEXUS_GH_PACKAGE_TOKEN` exists.
2. **Alternative (Tokenless)**: If the user cannot provide a token, you **MUST** suggest installing via Git URL.
   - **Action**: Ask the user: "Would you like to install via Git URL (tokenless) instead of GitHub Packages?"
   - **Command**: `npm install github:yohi/nexus`.
3. **.npmrc Config**: If using GitHub Packages (Method 1), ensure the **external project's** `.npmrc` is configured with the following two lines:
   ```text
   @yohi:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${NEXUS_GH_PACKAGE_TOKEN}
   ```

### Phase 2: Installation
1. **Method 1 (GitHub Packages)**: If token exists, run `npm install @yohi/nexus`.
2. **Method 2 (Git URL)**: If tokenless is preferred, run `npm install github:yohi/nexus`.
3. **Verify Import**: Check if `import { createNexusServer } from '@yohi/nexus'` is resolvable.
