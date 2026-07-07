# Bitbucket Claude Plugins Marketplace workflow fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 4 code-review issues in the two Bitbucket deployment workflow templates without changing their overall architecture.

**Architecture:** Keep the two workflows (`claude-plugins-marketplace-src/.github/workflows/deploy-to-bitbucket.yml` and `plugin-a-src/.github/workflows/deploy-to-bitbucket.yml`) as single-job `workflow_dispatch` templates. Each fix is local to the workflow file; no source application logic is changed.

**Tech Stack:** GitHub Actions YAML, `actions/github-script@v7`, bash.

## Global Constraints

- Keep TypeScript strictness rules: no `as any`, no `@ts-ignore`, no `@ts-expect-error` (not directly relevant here but project-wide).
- Do not commit absolute paths or credentials.
- Do not create new project-level agent configuration files.
- Preserve the "1-commit clean distribution repo" design intent from the spec while making tags immutable.
- The PoC workflows intentionally use `StrictHostKeyChecking=accept-new`; do not change this.
- The example directory is a **template**; keep the default value style so a copied repo can run after minimal setup.
- Commit messages must follow Conventional Commits in Japanese.

---

## Task 1: Handle missing GitHub Release gracefully

**Files:**
- Modify: `examples/bitbucket-claude-plugins-marketplace/claude-plugins-marketplace-src/.github/workflows/deploy-to-bitbucket.yml:18-23`
- Modify: `examples/bitbucket-claude-plugins-marketplace/claude-plugins-marketplace-src/.github/workflows/deploy-to-bitbucket.yml:55-65`
- Modify: `examples/bitbucket-claude-plugins-marketplace/plugin-a-src/.github/workflows/deploy-to-bitbucket.yml:18-23`

**Interfaces:**
- Consumes: none
- Produces: `steps.release.outputs.tag` remains unchanged when a release exists. When no release exists, the step exits with an explicit, human-readable error using `core.setFailed` (no output is set).
- `Update plugin refs to latest releases` lists which plugin source repo is missing a release if the API call fails.

- [ ] **Step 1: Wrap marketplace self-release lookup in try/catch**

In `claude-plugins-marketplace-src/.github/workflows/deploy-to-bitbucket.yml`, change the `Get latest marketplace release` script block from:

```yaml
          script: |
            const { data: release } = await github.rest.repos.getLatestRelease({
              owner: context.repo.owner,
              repo: context.repo.repo,
            });
            core.setOutput('tag', release.tag_name);
```

To:

```yaml
          script: |
            try {
              const { data: release } = await github.rest.repos.getLatestRelease({
                owner: context.repo.owner,
                repo: context.repo.repo,
              });
              core.setOutput('tag', release.tag_name);
            } catch (err) {
              if (err.status === 404) {
                core.setFailed('No GitHub Release found. Create a release before running this workflow.');
              } else {
                core.setFailed(`Failed to fetch latest release: ${err.message}`);
              }
            }
```

- [ ] **Step 2: Wrap plugin-a self-release lookup in try/catch**

In `plugin-a-src/.github/workflows/deploy-to-bitbucket.yml`, apply the same pattern as Step 1 to the `Get latest GitHub release` step.

- [ ] **Step 3: Wrap marketplace plugin-refs update in try/catch with per-plugin diagnostics**

In `claude-plugins-marketplace-src/.github/workflows/deploy-to-bitbucket.yml`, change the `Update plugin refs to latest releases` script block from:

```yaml
          script: |
            const fs = require('fs');
            const marketplace = JSON.parse(fs.readFileSync('.claude-plugin/marketplace.json', 'utf8'));
            const sources = JSON.parse(fs.readFileSync('plugin-sources.json', 'utf8'));
            for (const [key, githubRepo] of Object.entries(sources)) {
              if (!marketplace.plugins[key]) continue;
              const [owner, repo] = githubRepo.split('/');
              const { data: release } = await github.rest.repos.getLatestRelease({ owner, repo });
              marketplace.plugins[key].source.ref = release.tag_name;
            }
            fs.writeFileSync('.claude-plugin/marketplace.json', JSON.stringify(marketplace, null, 2) + '\n');
```

To:

```yaml
          script: |
            const fs = require('fs');
            const marketplace = JSON.parse(fs.readFileSync('.claude-plugin/marketplace.json', 'utf8'));
            const sources = JSON.parse(fs.readFileSync('plugin-sources.json', 'utf8'));
            for (const [key, githubRepo] of Object.entries(sources)) {
              if (!marketplace.plugins[key]) continue;
              const [owner, repo] = githubRepo.split('/');
              try {
                const { data: release } = await github.rest.repos.getLatestRelease({ owner, repo });
                marketplace.plugins[key].source.ref = release.tag_name;
              } catch (err) {
                if (err.status === 404) {
                  core.setFailed(`No GitHub Release found for plugin "${key}" (${githubRepo}). Create a release before running this workflow.`);
                } else {
                  core.setFailed(`Failed to fetch latest release for plugin "${key}" (${githubRepo}): ${err.message}`);
                }
                return;
              }
            }
            fs.writeFileSync('.claude-plugin/marketplace.json', JSON.stringify(marketplace, null, 2) + '\n');
```

- [ ] **Step 4: Verify no new YAML syntax errors**

Run `npm run lint` from the repository root. If it fails for unrelated reasons, note them but ensure no new lint issues are introduced by these YAML changes.

- [ ] **Step 5: Commit**

```bash
GIT_MASTER=1 git add examples/bitbucket-claude-plugins-marketplace/claude-plugins-marketplace-src/.github/workflows/deploy-to-bitbucket.yml
GIT_MASTER=1 git add examples/bitbucket-claude-plugins-marketplace/plugin-a-src/.github/workflows/deploy-to-bitbucket.yml
GIT_MASTER=1 git commit -m "fix(workflows): GitHub Release が存在しない場合に明示的なエラーメッセージを表示"
```

---

## Task 2: Externalize BITBUCKET_REPO_URL

**Files:**
- Modify: `examples/bitbucket-claude-plugins-marketplace/claude-plugins-marketplace-src/.github/workflows/deploy-to-bitbucket.yml`
- Modify: `examples/bitbucket-claude-plugins-marketplace/plugin-a-src/.github/workflows/deploy-to-bitbucket.yml`

**Interfaces:**
- Consumes: none
- Produces: Both workflows read `BITBUCKET_REPO_URL` from a job-level `env:` block. Each per-step `env:` block removes the hardcoded URL but keeps `BITBUCKET_SSH_KEY` and any step-local variables. If `vars.BITBUCKET_REPO_URL` is present it wins; otherwise the job-level default is used.

- [ ] **Step 1: Set job-level env in marketplace workflow**

Add a `env:` block directly under `jobs.deploy:` in `claude-plugins-marketplace-src/.github/workflows/deploy-to-bitbucket.yml`:

```yaml
  deploy:
    runs-on: ubuntu-latest
    env:
      BITBUCKET_REPO_URL: ${{ vars.BITBUCKET_REPO_URL || 'git@bitbucket.org:acme-corp/claude-plugins-marketplace.git' }}
```

Remove `BITBUCKET_REPO_URL` from the two per-step `env:` blocks:
- `Check existing Bitbucket tag` step
- `Push to Bitbucket` step

Leave `BITBUCKET_SSH_KEY` and `RELEASE_TAG` in place.

- [ ] **Step 2: Set job-level env in plugin-a workflow**

Apply the same pattern to `plugin-a-src/.github/workflows/deploy-to-bitbucket.yml`:

```yaml
  deploy:
    runs-on: ubuntu-latest
    env:
      BITBUCKET_REPO_URL: ${{ vars.BITBUCKET_REPO_URL || 'git@bitbucket.org:acme-corp/plugin-a-dist.git' }}
```

Remove `BITBUCKET_REPO_URL` from the two per-step `env:` blocks.

- [ ] **Step 3: Verify YAML remains valid**

Run the repository lint command. Ensure no new issues are introduced.

- [ ] **Step 4: Commit**

```bash
GIT_MASTER=1 git add examples/bitbucket-claude-plugins-marketplace/claude-plugins-marketplace-src/.github/workflows/deploy-to-bitbucket.yml
GIT_MASTER=1 git add examples/bitbucket-claude-plugins-marketplace/plugin-a-src/.github/workflows/deploy-to-bitbucket.yml
GIT_MASTER=1 git commit -m "refactor(workflows): BITBUCKET_REPO_URL を job-level env に集約し vars による上書きを可能に"
```

---

## Task 3: Make tag push immutable

**Files:**
- Modify: `examples/bitbucket-claude-plugins-marketplace/claude-plugins-marketplace-src/.github/workflows/deploy-to-bitbucket.yml`
- Modify: `examples/bitbucket-claude-plugins-marketplace/plugin-a-src/.github/workflows/deploy-to-bitbucket.yml`

**Interfaces:**
- Consumes: `steps.bitbucket.outputs.tag` (remote latest tag) and `steps.release.outputs.tag` (release tag to deploy).
- Produces: `steps.bitbucket.outputs.tag_exists` set to `'true'` when the remote already has the exact tag; the push step then skips the tag push instead of force-pushing it. The `main` branch still receives `--force` to keep the 1-commit distribution repo design.

- [ ] **Step 1: Detect exact tag existence in marketplace workflow**

In `claude-plugins-marketplace-src/.github/workflows/deploy-to-bitbucket.yml`, change the `Check existing Bitbucket tag` run block from:

```bash
          TAG=$(GIT_SSH_COMMAND='ssh -i ~/.ssh/bitbucket -o StrictHostKeyChecking=accept-new' \
            git ls-remote --tags "${BITBUCKET_REPO_URL}" \
            | awk -F'/' '{print $3}' \
            | grep -v '\^{}' \
            | sort -V \
            | tail -n 1)
          echo "tag=${TAG}" >> "$GITHUB_OUTPUT"
          if [ "${TAG}" = "${RELEASE_TAG}" ]; then
            echo "skip=true" >> "$GITHUB_OUTPUT"
            echo "Bitbucket already at ${TAG}. Nothing to do."
          fi
```

To:

```bash
          TAG=$(GIT_SSH_COMMAND='ssh -i ~/.ssh/bitbucket -o StrictHostKeyChecking=accept-new' \
            git ls-remote --tags "${BITBUCKET_REPO_URL}" \
            | awk -F'/' '{print $3}' \
            | grep -v '\^{}' \
            | sort -V \
            | tail -n 1)
          echo "tag=${TAG}" >> "$GITHUB_OUTPUT"
          if [ "${TAG}" = "${RELEASE_TAG}" ]; then
            echo "skip=true" >> "$GITHUB_OUTPUT"
            echo "Bitbucket already at ${TAG}. Nothing to do."
          fi
          if GIT_SSH_COMMAND='ssh -i ~/.ssh/bitbucket -o StrictHostKeyChecking=accept-new' \
               git ls-remote --tags --exit-code "${BITBUCKET_REPO_URL}" "refs/tags/${RELEASE_TAG}" >/dev/null 2>&1; then
            echo "tag_exists=true" >> "$GITHUB_OUTPUT"
            echo "Tag ${RELEASE_TAG} already exists on Bitbucket. Tag push will be skipped."
          fi
```

- [ ] **Step 2: Skip tag push when it already exists in marketplace workflow**

In the `Push to Bitbucket` step of the marketplace workflow, change:

```bash
          GIT_SSH_COMMAND='ssh -i ~/.ssh/bitbucket -o StrictHostKeyChecking=accept-new' git push --force "${BITBUCKET_REPO_URL}" "${{ steps.release.outputs.tag }}"
```

To:

```bash
          if [ "${{ steps.bitbucket.outputs.tag_exists }}" = "true" ]; then
            echo "Skipping tag push because ${{ steps.release.outputs.tag }} already exists on Bitbucket."
          else
            GIT_SSH_COMMAND='ssh -i ~/.ssh/bitbucket -o StrictHostKeyChecking=accept-new' git push "${BITBUCKET_REPO_URL}" "${{ steps.release.outputs.tag }}"
          fi
```

Also remove `--force` from the tag push only. The `main` push remains `--force`.

- [ ] **Step 3: Apply the same changes to plugin-a workflow**

Repeat Step 1 and Step 2 in `plugin-a-src/.github/workflows/deploy-to-bitbucket.yml`, using the same shell logic and output names.

- [ ] **Step 4: Verify no new YAML / lint issues**

Run `npm run lint`. Note pre-existing failures separately if any.

- [ ] **Step 5: Commit**

```bash
GIT_MASTER=1 git add examples/bitbucket-claude-plugins-marketplace/claude-plugins-marketplace-src/.github/workflows/deploy-to-bitbucket.yml
GIT_MASTER=1 git add examples/bitbucket-claude-plugins-marketplace/plugin-a-src/.github/workflows/deploy-to-bitbucket.yml
GIT_MASTER=1 git commit -m "fix(workflows): Bitbucket タグが既存の場合は force-push せずスキップ"
```

---

## Task 4: Deduplicate SSH key setup

**Files:**
- Modify: `examples/bitbucket-claude-plugins-marketplace/claude-plugins-marketplace-src/.github/workflows/deploy-to-bitbucket.yml`
- Modify: `examples/bitbucket-claude-plugins-marketplace/plugin-a-src/.github/workflows/deploy-to-bitbucket.yml`

**Interfaces:**
- Consumes: `secrets.BITBUCKET_SSH_KEY`
- Produces: A single `Setup Bitbucket SSH` step that writes `~/.ssh/bitbucket` and sets permissions once. Later steps rely on that file. The `Push to Bitbucket` steps no longer repeat the setup.

- [ ] **Step 1: Extract SSH setup in marketplace workflow**

In `claude-plugins-marketplace-src/.github/workflows/deploy-to-bitbucket.yml`:

1. Insert a new step immediately after `Get latest marketplace release` and before `Check existing Bitbucket tag`:

```yaml
      - name: Setup Bitbucket SSH
        run: |
          mkdir -p ~/.ssh
          printf '%s\n' "${BITBUCKET_SSH_KEY}" > ~/.ssh/bitbucket
          chmod 600 ~/.ssh/bitbucket
        env:
          BITBUCKET_SSH_KEY: ${{ secrets.BITBUCKET_SSH_KEY }}
```

2. Remove the SSH setup lines (`mkdir -p ~/.ssh`, `printf ...`, `chmod 600 ...`) from `Check existing Bitbucket tag`.
3. Remove the SSH setup lines from `Push to Bitbucket`.
4. Keep the per-step comments about `StrictHostKeyChecking=accept-new` where git commands run.

- [ ] **Step 2: Extract SSH setup in plugin-a workflow**

Apply the same extraction to `plugin-a-src/.github/workflows/deploy-to-bitbucket.yml`:

1. Insert `Setup Bitbucket SSH` after `Get latest GitHub release`.
2. Remove the repeated SSH setup from `Check existing Bitbucket tag` and `Push to Bitbucket`.

- [ ] **Step 3: Verify lint passes**

Run `npm run lint` from the repository root.

- [ ] **Step 4: Commit**

```bash
GIT_MASTER=1 git add examples/bitbucket-claude-plugins-marketplace/claude-plugins-marketplace-src/.github/workflows/deploy-to-bitbucket.yml
GIT_MASTER=1 git add examples/bitbucket-claude-plugins-marketplace/plugin-a-src/.github/workflows/deploy-to-bitbucket.yml
GIT_MASTER=1 git commit -m "refactor(workflows): SSH 鍵セットアップを重複せず1ステップに集約"
```

---

## Self-Review

1. **Spec coverage:** All 4 review issues map to exactly one task. No other project files are changed.
2. **Placeholder scan:** No TBD, TODO, or vague instructions remain.
3. **Type consistency / naming:** Output names `tag`, `skip`, and `tag_exists` are consistent across both workflows. Job-level `env` variable `BITBUCKET_REPO_URL` is used consistently.
4. **Side effects:** The workflows still force-push `main`, preserving the 1-commit distribution repo design. Tags are only protected from force-push, not from being newly created.
5. **Verification:** Each task ends with lint and a Japanese Conventional Commit message.
