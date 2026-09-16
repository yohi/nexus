# MCP and Skill Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generic-agent and Claude Code plugin setup provision and independently verify both the Nexus MCP server and the repository code-search Skill.

**Architecture:** Keep `.agents/skills/code-search.md` as the single Skill source. Generic agents load and verify that source through the repository checkout or GitHub Raw URL, while the plugin staging script generates `skills/code-search/SKILL.md` for Claude Code. The setup protocol reports MCP and Skill gates separately and never treats one successful gate as completion of both.

**Tech Stack:** Markdown, Bash, Node.js, npm, Vitest, Claude Code plugin staging.

## Global Constraints

- Keep `.agents/skills/code-search.md` as the only committed Skill source of truth.
- Do not install files into vendor-specific global agent directories.
- Preserve Source Build and Package Usage manual setup paths.
- Source Build requires Node.js 24 or later and the repository lockfile.
- Do not commit, push, or open a pull request from setup instructions.
- Do not expose or persist credentials, tokens, or API keys.
- A setup result is complete only when both MCP and Skill verification gates pass.

---

### Task 1: Lock the dual-gate documentation contract

**Files:**
- Modify: `tests/unit/docs/structured-retrieval-guidance.test.ts`
- Test: `tests/unit/docs/structured-retrieval-guidance.test.ts`

**Interfaces:**
- Consumes: `README.md`, `README.ja.md`, `AGENTS.md`, `docs/setup.md`, and `.agents/skills/code-search.md`.
- Produces: Regression assertions for the repository URL, three Raw URLs, independent MCP/Skill gates, and separate verification language.

- [ ] **Step 1: Write failing assertions**

Add a test that reads both README variants and asserts each contains:

```ts
expect(readme).toContain("https://github.com/yohi/nexus");
expect(readme).toContain("https://raw.githubusercontent.com/yohi/nexus/master/AGENTS.md");
expect(readme).toContain("https://raw.githubusercontent.com/yohi/nexus/master/docs/setup.md");
expect(readme).toContain("https://raw.githubusercontent.com/yohi/nexus/master/.agents/skills/code-search.md");
expect(readmeJa).toContain("https://raw.githubusercontent.com/yohi/nexus/master/.agents/skills/code-search.md");
expect(agents).toContain("MCP gate");
expect(agents).toContain("Skill gate");
```

Add assertions that `setup.md` contains both MCP verification (`index_status` and `grep_search` or `hybrid_search`) and Skill verification (`code-search.md` and `loaded`).

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npx vitest run tests/unit/docs/structured-retrieval-guidance.test.ts`

Expected: FAIL because the Skill Raw URL and dual-gate wording are not yet present.

- [ ] **Step 3: Commit the regression test**

```bash
GIT_MASTER=1 git add tests/unit/docs/structured-retrieval-guidance.test.ts
GIT_MASTER=1 git commit -m "test: MCP と Skill のセットアップ契約を固定"
```

### Task 2: Make the generic agent flow explicit

**Files:**
- Modify: `README.md:61-67`
- Modify: `README.ja.md:61-67`
- Modify: `AGENTS.md:22-35`
- Modify: `docs/setup.md:12-93`

**Interfaces:**
- Consumes: Raw URLs in the README prompt and `.agents/skills/code-search.md` as the Skill source.
- Produces: A setup flow with explicit MCP and Skill gates, mode selection, safe failure reporting, and separate verification.

- [ ] **Step 1: Update both README prompts**

Use the same English prompt in both README files:

```text
Set up the `yohi/nexus` repository (https://github.com/yohi/nexus). Read and follow https://raw.githubusercontent.com/yohi/nexus/master/AGENTS.md first, use https://raw.githubusercontent.com/yohi/nexus/master/docs/setup.md as the canonical setup source, and load https://raw.githubusercontent.com/yohi/nexus/master/.agents/skills/code-search.md as the repository Skill. Configure and verify the MCP connection and Skill availability separately; report setup complete only when both pass.
```

- [ ] **Step 2: Add explicit MCP and Skill gates to `AGENTS.md`**

Require the agent to identify the client, obtain the Source Build or Package Usage choice before dependency or credential changes, configure MCP, load the Skill, and report each gate independently. State that generic setup makes the Skill available in the repository/current agent context and does not claim a vendor-global installation.

- [ ] **Step 3: Add Skill verification to `docs/setup.md`**

Add a `## Verify the Skill` section that requires the agent to confirm the source file exists or was fetched from its Raw URL, read it into the current agent context, and report failure separately from MCP connection failure. Keep existing manual MCP instructions intact.

- [ ] **Step 4: Correct Source Build MCP command guidance**

Change the Source Build client example so it invokes the built entry point with `node` and the checkout's `dist/bin/nexus.js`, rather than assuming a cloned checkout exposes a global `nexus` command. Keep `npx @yohi/nexus` for Package Usage.

- [ ] **Step 5: Run the focused test and confirm it passes**

Run: `npx vitest run tests/unit/docs/structured-retrieval-guidance.test.ts`

Expected: PASS with all documentation contract tests passing.

- [ ] **Step 6: Commit the generic flow**

```bash
GIT_MASTER=1 git add README.md README.ja.md AGENTS.md docs/setup.md
GIT_MASTER=1 git commit -m "docs: MCP と Skill のセットアップ手順を明確化"
```

### Task 3: Include the Skill in Claude Code plugin staging

**Files:**
- Modify: `scripts/stage-plugin-dist.sh:22-36`
- Create: `tests/unit/scripts/stage-plugin-dist.test.sh`

**Interfaces:**
- Consumes: `.agents/skills/code-search.md`.
- Produces: A staged plugin mirror containing `skills/code-search/SKILL.md` generated from the canonical Skill source.

- [ ] **Step 1: Write the failing staging test**

Create a temporary staging directory, run `scripts/stage-plugin-dist.sh`, then assert:

```bash
test -f "$STAGING_DIR/.claude-plugin/plugin.json"
test -f "$STAGING_DIR/scripts/setup-plugin.sh"
test -f "$STAGING_DIR/dist/bin/nexus.js" || test -f "$STAGING_DIR/src/index.ts"
test -f "$STAGING_DIR/skills/code-search/SKILL.md"
cmp "$PROJECT_ROOT/.agents/skills/code-search.md" "$STAGING_DIR/skills/code-search/SKILL.md"
```

Expected before implementation: FAIL because the staged Skill path does not exist.

- [ ] **Step 2: Run the staging test and confirm failure**

Run: `bash tests/unit/scripts/stage-plugin-dist.test.sh`

Expected: FAIL at the staged Skill file assertion.

- [ ] **Step 3: Copy the canonical Skill during staging**

Create `$STAGING_DIR/skills/code-search` and copy `.agents/skills/code-search.md` to `$STAGING_DIR/skills/code-search/SKILL.md` in `scripts/stage-plugin-dist.sh`. Do not add a second committed Skill source.

- [ ] **Step 4: Run the staging test and confirm it passes**

Run: `bash tests/unit/scripts/stage-plugin-dist.test.sh`

Expected: PASS with the generated Skill content byte-for-byte equal to the canonical source.

- [ ] **Step 5: Document the plugin artifact**

Update `docs/distribution.md` so the source mirror contents state that the staging process generates `skills/code-search/SKILL.md` from `.agents/skills/code-search.md`, alongside the existing MCP manifest and runtime.

- [ ] **Step 6: Commit the plugin flow**

```bash
GIT_MASTER=1 git add scripts/stage-plugin-dist.sh tests/unit/scripts/stage-plugin-dist.test.sh docs/distribution.md
GIT_MASTER=1 git commit -m "feat: Claude Code プラグインへ Skill を同梱"
```

### Task 4: Add end-to-end setup verification

**Files:**
- Modify: `AGENTS.md:28-35`
- Modify: `docs/setup.md:84-100`
- Modify: `tests/unit/docs/structured-retrieval-guidance.test.ts`

**Interfaces:**
- Consumes: The MCP and Skill gates from Tasks 2 and 3.
- Produces: A documented and tested rule that setup completion requires both gates.

- [ ] **Step 1: Add the completion invariant**

Document the required result as two independent records:

```text
MCP: connected, index_status passed, and a small search returned results.
Skill: code-search.md fetched/read and its workflow available to the agent.
```

The agent must report the failed gate, non-secret output, current state, and next safe action when either check fails.

- [ ] **Step 2: Add assertions for the invariant**

Assert that the docs contain both `MCP: connected` and `Skill:` verification labels and that a failed gate prevents a complete setup result.

- [ ] **Step 3: Run all focused verification**

Run:

```bash
npx vitest run tests/unit/docs/structured-retrieval-guidance.test.ts
bash tests/unit/scripts/stage-plugin-dist.test.sh
GIT_MASTER=1 git diff --check
```

Expected: all tests pass and `git diff --check` produces no output.

- [ ] **Step 4: Commit the verification contract**

```bash
GIT_MASTER=1 git add AGENTS.md docs/setup.md tests/unit/docs/structured-retrieval-guidance.test.ts
GIT_MASTER=1 git commit -m "test: MCP と Skill の検証ゲートを追加"
```

### Task 5: Final verification and PR update

**Files:**
- Verify: `README.md`, `README.ja.md`, `AGENTS.md`, `docs/setup.md`, `scripts/stage-plugin-dist.sh`, `docs/distribution.md`

**Interfaces:**
- Consumes: All changes from Tasks 1-4.
- Produces: Evidence that both setup paths are documented, staged, and testable.

- [ ] **Step 1: Run repository verification**

Run: `npm test`

Expected: the repository test suite exits successfully.

- [ ] **Step 2: Inspect the complete branch diff**

Run:

```bash
GIT_MASTER=1 git status --short --branch
GIT_MASTER=1 git diff master...HEAD --stat
GIT_MASTER=1 git log --oneline master..HEAD
```

Expected: only the MCP + Skill setup changes are present and the worktree is clean.

- [ ] **Step 3: Push and update the existing PR**

```bash
GIT_MASTER=1 git push
gh pr view 315 --web
```

Expected: PR #315 contains the dual-gate setup implementation and its verification evidence.
