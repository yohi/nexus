# Instructions for AI Agents: Auto-Installation & Setup (Nexus)
# Instructions for AI Agents: Auto-Installation & Setup (Nexus)

You are an expert software engineer tasked with the setup of **Nexus**.
**CRITICAL PROTOCOL**: 
- You are forbidden from choosing an installation method on behalf of the user. Use `ask_user`.
- **NEVER** ask the user to type sensitive tokens/PATs directly into the chat. 
- If a token is missing, instruct the user to edit the `.env` file manually and wait for their confirmation via the `ask_user` tool.

## Step 0: User Decision via Tool (MANDATORY)
Call `ask_user` to choose between:
- **A. Source Build (Recommended)**: For full development within this repository.
- **B. Package Usage**: To integrate `@yohi/nexus` into an external project.

---

## IF CHOICE A: SOURCE BUILD

### Phase 1: Environment Discovery & Tooling
1. **Detect OS & Node.js** (>= 22.0.0).
2. **Architecture**: Read `SPEC.md`.

### Phase 2: Credentials & .env Setup (CRITICAL)
1. **Check for Token**: Verify if `NEXUS_GH_PACKAGE_TOKEN` is set in the environment or `.env`.
2. **Handle Missing Token**: If missing or if `npm install` fails due to 401/403:
   - **Action**: Inform the user: "Please add `NEXUS_GH_PACKAGE_TOKEN=your_pat_here` to the `.env` file in the project root."
   - **Wait**: Call `ask_user` (type: `yesno`) with the question: "Have you updated the `.env` file with a valid GitHub PAT?"
   - **Retry**: Only proceed after the user confirms.
3. **Bootstrap**: Run `node scripts/bootstrap.mjs`.

---

## IF CHOICE B: PACKAGE USAGE

### Phase 1: Credentials & .npmrc Preparation
1. **Token Check**: Verify `NEXUS_GH_PACKAGE_TOKEN` exists.
2. **Alternative (Tokenless)**: If the user cannot provide a token, you **MUST** suggest installing via Git URL.
   - **Action**: Ask the user: "Would you like to install via Git URL (tokenless) instead of GitHub Packages?"
   - **Command**: `npm install github:yohi/nexus`.

### Phase 2: Installation
1. **Method 1 (GitHub Packages)**: If token exists, ensure `.npmrc` is configured and run `npm install @yohi/nexus`.
2. **Method 2 (Git URL)**: If tokenless is preferred, run `npm install github:yohi/nexus`.
3. **Verify**: Check resolvability of `@yohi/nexus`.


### Phase 2: Verification & Handover
1. **Test**: Run `npm test` (Vitest). If tests fail, diagnose and attempt to fix common issues.
2. **MCP Server Check**: 
   - Confirm the main entry point `dist/bin/nexus.js` is correctly generated.
   - Provide instructions on how to start the MCP server.

---

## IF CHOICE B: PACKAGE USAGE

### Phase 1: Preparation (Authentication)
1. **GitHub Packages Configuration**:
   - Ensure `@yohi:registry=https://npm.pkg.github.com` is in the project's `.npmrc`.
   - Verify the user has a GitHub Personal Access Token with `read:packages` scope.

### Phase 2: Installation
1. **Install Package**: Run `npm install @yohi/nexus`.
2. **Verify Import**: Check if `import { createNexusServer } from '@yohi/nexus'` is resolvable.
