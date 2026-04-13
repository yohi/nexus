# Instructions for AI Agents: Auto-Installation & Setup (Nexus)

You are an expert software engineer tasked with the setup of **Nexus**.

## 🛑 MANDATORY PROTOCOL: STOP & ASK
As an AI agent, you MUST adhere to these constraints before ANY other action:
1.  **ZERO COMMANDS**: DO NOT execute ANY shell commands (npm, node, etc.) before the user makes a choice in Step 0.
2.  **MANDATORY INTERACTION**: You MUST use your available interaction tool (e.g., `ask_user`, `input`, `confirm`, or equivalent) to request the user's choice in Step 0. If you do not have such a tool, ask the user in plain text and WAIT for their response.
3.  **NO AUTONOMOUS DECISIONS**: Even if one method is "Recommended", you are FORBIDDEN from choosing it on behalf of the user. 
4.  **Credential Privacy**: NEVER ask the user to type sensitive tokens (PATs) directly into the chat.
5.  **Source Build Autonomy**: A "Source Build" (Choice A) MUST NOT require a PAT for public dependencies. The `bootstrap` script is designed to handle this automatically.

---

## Step 0: User Decision (MUST USE Interaction Tool)
Use your interaction tool (e.g., `ask_user` with `type: choice` or similar) to determine the user's intent:

- **A. Source Build (Recommended)**: Build and develop Nexus directly in this repository. No PAT required for public dependencies.
- **B. Package Usage**: Integrate `@yohi/nexus` into an external project via GitHub Packages (PAT required) or Git URL (Tokenless).

---

## IF CHOICE A: SOURCE BUILD (Local Development)

### Phase 1: Environment Readiness
1. **System Check**: Confirm Node.js >= 22.0.0.
2. **Repository Context**: You are already in the `nexus` repository.

### Phase 2: Dependency Resolution (NO TOKEN REQUIRED)
1.  **Standard Path (Happy Path)**: Try running `npm install` and `npm run build` first. If both succeed, proceed to Phase 3.
2.  **Automated Fallback**: If `npm install` fails due to authentication or missing `${NEXUS_GH_PACKAGE_TOKEN}`:
    - **Action**: Run `node scripts/bootstrap.mjs`.
    - **Behavior**: The script will automatically detect the missing token, temporarily bypass the `.npmrc` file, and complete the installation and build process.
    - **DO NOT** ask the user for a token in this phase.

### Phase 3: Verification
1. **Test**: Run `npm test`.
2. **Nexus CLI**: Verify `dist/bin/nexus.js` exists after build.

---

## IF CHOICE B: PACKAGE USAGE (External Integration)

### Phase 1: Installation Strategy
1. **Choice B.1: GitHub Packages**: Requires `NEXUS_GH_PACKAGE_TOKEN`.
   - Verify if the token is exported in the environment.
   - If missing, instruct the user: "Please export `NEXUS_GH_PACKAGE_TOKEN` in your shell, then confirm here." Use your **interaction tool** (e.g., `confirm` or similar) to wait for confirmation.
2. **Choice B.2: Git URL (Tokenless)**: 
   - Use `npm install github:yohi/nexus`. No PAT needed.

### Phase 2: Project Setup
1. **For Method B.1**: Configure the **external** project's `.npmrc`:
   ```text
   @yohi:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${NEXUS_GH_PACKAGE_TOKEN}
   ```
2. **Verify**: Check if `import { createNexusServer } from '@yohi/nexus'` is resolvable.
