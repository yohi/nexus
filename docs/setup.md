# Nexus Setup & Installation Guide

## 🛑 Installation & Setup Protocol (MANDATORY)

If you are tasked with installing or configuring Nexus, you **MUST** follow this protocol before running any other commands:

1. **No Unapproved Commands**: Do not run any CLI, shell, or package manager commands before the user makes a choice.
2. **MANDATORY INTERACTION**: Use your interaction tool (e.g., `ask_user`, `input`) to let the user select their intent:
   - **A. Source Build (Recommended)**: Build and develop Nexus directly in this repository.
   - **B. Package Usage**: Integrate `@yohi/nexus` into an external project.
3. **NO AUTONOMOUS DECISIONS**: Do not make the decision on behalf of the user.
4. **Credential Privacy**: Never ask the user to type sensitive credentials (such as Personal Access Tokens / PATs) directly in the chat.

### IF CHOICE A: SOURCE BUILD (Local Development)

- **Install**: Run `npm install` to resolve dependencies.
- **Build**: Run `npm run build` to build workspaces.
- **Fallback**: If installation fails due to token auth issues, run `node scripts/bootstrap.mjs`.
- **Test**: Run `npm test` to verify tests pass.
- **Verify Build Output**: Ensure that `dist/bin/nexus.js` exists.

### IF CHOICE B: PACKAGE USAGE (External Integration)

- **GitHub Packages**: Requires a Personal Access Token (PAT) via the `NEXUS_GH_PACKAGE_TOKEN` env variable.
- **Token Check**: If the token is missing, prompt the user to export it in their shell.
- **Git URL**: Install tokenless via `npm install github:yohi/nexus`.
- **Project Setup**: Configure the external project's `.npmrc` to point `@yohi:registry` to `https://npm.pkg.github.com`.
