# Nexus Plugin Bitbucket Source-Mirror Deploy 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **✅ 前提確定（2026-07-07）:** 業務用パッケージ版の全決定が [../specs/2026-07-07-nexus-packaged-plugin-restrictions.md](../specs/2026-07-07-nexus-packaged-plugin-restrictions.md) で確定した。コア変更（Bedrock プロバイダ・パッケージモード）と plugin.json の stage 時変換は [2026-07-07-nexus-packaged-plugin-implementation.md](2026-07-07-nexus-packaged-plugin-implementation.md) を正とする。本計画はその配布ワークフロー層を担い、次を反映済み: (1) `packages/dashboard` は**同梱維持**（ローカル TUI のため。除外しない）、(2) `scripts/stage-plugin-dist.sh` は実装計画 Task 4（plugin.json 変換つき）を唯一の正とし本計画では別実装を作らない、(3) Task 2 ワークフローは deploy 可変 env（`NEXUS_EMBEDDING_REGION`/`PROFILE`/`MODEL`/`DIMENSIONS`）を stage ステップに渡す。AWS 資格情報 / GitHub Actions 変数は Prerequisites（P5/P6）を参照。

**Goal:** nexus プラグイン(`yohi-nexus`)を「ソースミラー」として Bitbucket `y-ohi/nexus` に自動デプロイする GitHub Actions ワークフローを追加し、利用者マシンで `setup-plugin.sh` により `npm install && npm run build` して動作させる。

**Architecture:** `workflow_dispatch` トリガで、(1) 最新 GitHub Release tag 取得 → (2) Bitbucket 既存 tag と比較し一致なら skip → (3) tag を checkout し `npm ci`→lint→test で品質ゲート → (4) ビルド可能な最小ソース一式を staging へコピー → (5) staging の複製で `npm install && npm run build` を実行し自己完結性を検証 → (6) 認証は GIT_ASKPASS(トークンを remote URL・コマンドライン引数に出さない)で Bitbucket へ force-push。ネイティブ依存(`better-sqlite3`, `@lancedb/lancedb`)と `tsc`(非バンドル)ビルドのため、設計 spec の「dist-only」配布は使わずソースミラー方式を採る。

**Tech Stack:** GitHub Actions, Node.js 24, npm workspaces, TypeScript(tsc), esbuild(dashboard), Bitbucket Cloud Repository Access Token。

## Global Constraints

- Node.js `>= 24.0.0`(`package.json` の `engines.node`。ワークフロー・利用者マシン双方に適用)。
- 認証トークンを remote URL・コマンドライン引数・ログに含めない。`GIT_ASKPASS` 経由でのみ渡す。
- Bitbucket 配布リポジトリは `git push --force` で常に 1 コミットのクリーン状態を保つ。
- `.claude-plugin/plugin.json` はソース側では編集しない。パッケージ版差分は `scripts/stage-plugin-dist.sh` の stage 時変換で注入する（`userConfig` 除去・`mcpServers.nexus.env` を固定値へ置換）。実装は実装計画 [2026-07-07-nexus-packaged-plugin-implementation.md](2026-07-07-nexus-packaged-plugin-implementation.md) Task 4 を正とする。
- ソースミラーに `scripts/bootstrap.mjs` を **含めない**(`setup-plugin.sh` が `npm install --no-audit --no-fund` + `npm run build` パスを通り、インストール時 lint を避けるため)。
- ソースミラーに `node_modules/` と `dist/` を **含めない**(自己完結性検証は push 対象とは別の使い捨てディレクトリで行う)。
- 既存の安全な認証パターン(`.github/workflows/update-marketplace-entry.yml` および `examples/.../plugin-a-src/.github/workflows/deploy-to-bitbucket.yml` の GIT_ASKPASS 方式)に一致させる。

---

## Prerequisites（手動セットアップ・コード変更なし）

これらはワークフローを実際に実行する前に必要な、Bitbucket / GitHub 側の運用設定である。コード実装(Task 1〜3)は Prerequisites 未完了でも進められるが、デプロイ実行前に完了させること。

- [ ] **P1: Bitbucket 配布リポジトリの確認**
  - `https://bitbucket.org/y-ohi/nexus`(private)が存在すること。現在 `.gitignore` のみ存在するが、初回 force-push で上書きされるため問題ない。

- [ ] **P2: Bitbucket Repository Access Token 発行**
  - Bitbucket の対象リポジトリ **Repository settings > Security > Access tokens** で `repository:write` スコープの Access Token を発行する。
  - リポジトリ単位で発行され、個人 Atlassian アカウントに依存しない最小権限トークンであること。

- [ ] **P3: GitHub Secret 登録**
  - GitHub の nexus リポジトリ **Settings > Secrets and variables > Actions** で、P2 のトークンを `BITBUCKET_API_TOKEN` という名前の Secret として登録する。
  - （任意）配布先を変えたい場合は Repository variable `BITBUCKET_PLUGIN_REPO_URL` を設定する。未設定時はワークフローのデフォルト `https://bitbucket.org/y-ohi/nexus.git` が使われる。

- [ ] **P4: GitHub Release の存在確認**
  - ワークフローは「最新の GitHub Release tag」を配布単位とする。release-please 運用により Release は既に作成されている(例: `v1.24.0`)。Release が 1 つも無い場合はワークフローが明示的に失敗する。

- [ ] **P5: AWS 資格情報（利用者マシン）**
  - パッケージ版は AWS Bedrock を直接呼ぶ。利用者マシンに AWS SDK デフォルト認証チェーンで解決可能な資格情報（env の IAM アクセスキー / SSO / 名前付きプロファイル / IAM ロールのいずれか）が必要。詳細は [設計 §5.2](../specs/2026-07-07-nexus-packaged-plugin-restrictions.md)。

- [ ] **P6: GitHub Actions 変数（deploy 可変値）**
  - `NEXUS_EMBEDDING_REGION`（既定 us-east-1）、任意 `NEXUS_EMBEDDING_PROFILE`、`NEXUS_EMBEDDING_MODEL`・`NEXUS_EMBEDDING_DIMENSIONS`（既定 titan v2 / 1024）を Repository variable として設定し、ワークフローの `stage-plugin-dist.sh` 実行 step に env として渡す（Task 2 参照）。

---

## File Structure

| ファイル | 責務 | 変更 |
| --- | --- | --- |
| `scripts/stage-plugin-dist.sh` | ソースミラーのファイル集合を staging へコピー＋plugin.json 変換。実装は実装計画 Task 4 を唯一の正とし本計画では作らない | Plan A Task 4 参照 |
| `.github/workflows/deploy-plugin-to-bitbucket.yml` | Release tag を Bitbucket 配布リポジトリへソースミラーとして force-push する | 新規作成 |
| `docs/superpowers/specs/2026-07-03-bitbucket-claude-plugins-marketplace.md` | ネイティブ依存プラグイン向けの「ソースミラー配布」例外を明記(将来の誤適用防止) | §4 に追記 |

「何を配るか」は `stage-plugin-dist.sh` に一元化し、ワークフローはそれを呼ぶだけにする。これにより配布ファイル集合をローカルで独立してテストできる。

---

### Task 1: ソースミラー staging スクリプト

> **⚠️ 一本化（2026-07-07）:** `scripts/stage-plugin-dist.sh` の実装は実装計画 [2026-07-07-nexus-packaged-plugin-implementation.md](2026-07-07-nexus-packaged-plugin-implementation.md) Task 4（plugin.json の stage 時変換つき: `userConfig` 除去・固定 env 注入・`packages/dashboard` 同梱）を**唯一の正**とする。同一ファイルの二重定義を避けるため、以下 Step 1 に残す無変換コピー版（`.claude-plugin/plugin.json` をそのまま `cp`）はパッケージ版では**使わない**（参考として保持）。パッケージ版配布では Plan A Task 4 のスクリプトを Task 2 ワークフローが呼ぶ。
>
> **✅ 実装完了（本ブランチ）:** `scripts/stage-plugin-dist.sh` は実装計画 Task 4 の内容で `feature/nexus-packaged-plugin-distribution-pipeline` ブランチ上で新規作成済み（コミット `6678d54`）。ローカル検証（staging生成・plugin.json変換・自己完結ビルド）も完了している。よって以下 Step 1〜6（無変換コピー版の参考実装）はパッケージ版では**実行不要**であり、チェックボックスは意図的に未チェックのまま残す。

**Files:**
- Create: `scripts/stage-plugin-dist.sh`
- Test: ローカルで実行し、生成物のファイル集合と自己完結ビルドを検証(このタスクの Step 内で実施)

**Interfaces:**
- Produces: `scripts/stage-plugin-dist.sh <staging-dir>` — 第 1 引数の staging ディレクトリを作り直し、ビルド可能な最小ソース一式をコピーする CLI。Task 2 のワークフローが `scripts/stage-plugin-dist.sh dist-staging` として呼び出す。
- 配布に含めるファイル集合(確定値):
  - `.claude-plugin/plugin.json`
  - `package.json`, `package-lock.json`
  - `tsconfig.json`, `tsconfig.build.json`
  - `src/`（全体）
  - `packages/dashboard/package.json`, `packages/dashboard/src/`（esbuild が `src/cli.ts` をバンドル)
  - `scripts/setup-plugin.sh`
  - `LICENSE`, `NOTICE`
- 配布に **含めない**もの: `scripts/bootstrap.mjs`, `scripts/doctor.mjs`, `scripts/license-check.mjs`, `tests/`, `packages/dashboard/tests/`, `eslint.config.mjs`, `vitest.config.ts`, `packages/dashboard/{tsconfig*.json,vitest.config.ts}`, `.github/`, `.devcontainer/`, `.codacy.yml`, `.nexus.json`, `docs/`, `examples/`, `SPEC.md`, `AGENTS.md`, `README.md`, `CHANGELOG.md`, `node_modules/`, `dist/`。

- [ ] **Step 1: スクリプトを作成する**

> ⚠️ **注意: 以下は無変換コピー版（参考実装）であり、パッケージ版配布ではそのまま作成・使用しないこと。** パッケージ版で実際に使うスクリプトの実装は [2026-07-07-nexus-packaged-plugin-implementation.md](2026-07-07-nexus-packaged-plugin-implementation.md) Task 4（plugin.json の stage 時変換つき）を唯一の正とする。本 Step のコードは経緯の記録として残すのみで、そのまま `scripts/stage-plugin-dist.sh` として新規作成しないこと。

```bash
#!/bin/bash
# Stage the nexus plugin as a build-ready "source mirror" for Bitbucket distribution.
#
# The nexus plugin cannot ship as a pre-built, dist-only bundle: the build uses
# `tsc` (no bundling) and depends on native modules (better-sqlite3,
# @lancedb/lancedb) that must be installed for the user's own platform.
# We therefore ship the minimal source needed for `npm install && npm run build`,
# which scripts/setup-plugin.sh runs on the user's machine via the plugin hooks.
#
# scripts/bootstrap.mjs is intentionally NOT shipped, so setup-plugin.sh takes
# the `npm install --no-audit --no-fund` + `npm run build` path (no install-time lint).
#
# Usage: scripts/stage-plugin-dist.sh <staging-dir>
set -euo pipefail

STAGING_DIR="${1:?usage: stage-plugin-dist.sh <staging-dir>}"

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR/.claude-plugin" "$STAGING_DIR/scripts" "$STAGING_DIR/packages/dashboard"

# Plugin manifest (required by Claude Code)
cp .claude-plugin/plugin.json "$STAGING_DIR/.claude-plugin/"

# Package manifests + lockfile (npm install)
cp package.json package-lock.json "$STAGING_DIR/"

# TypeScript build config (tsc -p tsconfig.build.json)
cp tsconfig.json tsconfig.build.json "$STAGING_DIR/"

# Root application source (build input)
cp -r src "$STAGING_DIR/"

# Dashboard workspace (esbuild bundles packages/dashboard/src/cli.ts)
cp packages/dashboard/package.json "$STAGING_DIR/packages/dashboard/"
cp -r packages/dashboard/src "$STAGING_DIR/packages/dashboard/"

# Runtime setup hook (installs deps + builds on the user's machine)
cp scripts/setup-plugin.sh "$STAGING_DIR/scripts/"

# License files
cp LICENSE NOTICE "$STAGING_DIR/"

echo "Staged nexus plugin source mirror into: $STAGING_DIR"
```

> ⚠️ **上記コードは参考実装であり、パッケージ版配布では作成しないこと。** パッケージ版のスクリプトは実装計画 [2026-07-07-nexus-packaged-plugin-implementation.md](2026-07-07-nexus-packaged-plugin-implementation.md) Task 4 を参照。

- [ ] **Step 2: 実行権限を付与する**

Run: `chmod +x scripts/stage-plugin-dist.sh`
Expected: エラーなし。`ls -l scripts/stage-plugin-dist.sh` で `-rwxr-xr-x` を確認。

- [ ] **Step 3: staging を生成する**

Run: `bash scripts/stage-plugin-dist.sh /tmp/nexus-stage-test`
Expected: 最終行に `Staged nexus plugin source mirror into: /tmp/nexus-stage-test`。非ゼロ終了しないこと。

- [ ] **Step 4: ファイル集合を検証する（含めるべきものが在り、除外すべきものが無い）**

Run:
```bash
( cd /tmp/nexus-stage-test  # サブシェルで実行し親シェルの作業ディレクトリを変えない
test -f .claude-plugin/plugin.json \
  && test -f package.json && test -f package-lock.json \
  && test -f tsconfig.json && test -f tsconfig.build.json \
  && test -d src && test -f packages/dashboard/package.json \
  && test -d packages/dashboard/src \
  && test -f scripts/setup-plugin.sh \
  && test -f LICENSE && test -f NOTICE \
  && echo "REQUIRED-OK"
! test -e scripts/bootstrap.mjs \
  && ! test -e tests \
  && ! test -e node_modules \
  && ! test -e dist \
  && ! test -e eslint.config.mjs \
  && ! test -e vitest.config.ts \
  && echo "EXCLUDED-OK" )
```
Expected: `REQUIRED-OK` と `EXCLUDED-OK` の両方が出力される。

- [ ] **Step 5: ソースミラーが単体でビルドできることを検証する（自己完結性の核心テスト）**

Run:
```bash
rm -rf /tmp/nexus-verify
cp -r /tmp/nexus-stage-test /tmp/nexus-verify
( cd /tmp/nexus-verify
npm install --no-audit --no-fund
npm run build
test -f dist/bin/nexus.js && echo "SELF-SUFFICIENT-OK" )
```
Expected: `npm run build` が成功し、最後に `SELF-SUFFICIENT-OK` が出力される。
補足: dashboard ビルドは `../../node_modules/.bin/esbuild` を使う。esbuild は直接依存ではないが、devDependencies の vitest 経由で推移的にインストールされ(`package-lock.json` 収録済み)、`npm install`(devDeps を含む)で解決される。**このステップが失敗し原因が esbuild 未解決だった場合のみ**、`package.json` の devDependencies に `esbuild` を明示追加して `npm install` でロックを更新し、再検証する。

- [ ] **Step 6: 一時ディレクトリを掃除してコミットする**

Run:
```bash
rm -rf /tmp/nexus-stage-test /tmp/nexus-verify
git add scripts/stage-plugin-dist.sh
git commit -m "feat: プラグイン配布用ソースミラー staging スクリプトを追加"
```
Expected: 1 ファイルがコミットされる。

---

### Task 2: Bitbucket デプロイワークフロー

**Files:**
- Create: `.github/workflows/deploy-plugin-to-bitbucket.yml`
- Test: YAML パースと埋め込みシェルの構文チェック(このタスクの Step 内で実施)

**Interfaces:**
- Consumes: `scripts/stage-plugin-dist.sh dist-staging`(Task 1)。Secret `BITBUCKET_API_TOKEN`(Prerequisites P3)。任意の Repository variable `BITBUCKET_PLUGIN_REPO_URL`。
- Produces: `workflow_dispatch` で起動する `Deploy plugin to Bitbucket` ワークフロー。Bitbucket `y-ohi/nexus` に main ブランチと Release tag を force-push する。

- [x] **Step 1: ワークフローを作成する**

`.github/workflows/deploy-plugin-to-bitbucket.yml` を以下の内容で新規作成する。

```yaml
name: Deploy plugin to Bitbucket

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      BITBUCKET_REPO_URL: ${{ vars.BITBUCKET_PLUGIN_REPO_URL || 'https://bitbucket.org/y-ohi/nexus.git' }}
    steps:
      - name: Get latest GitHub release
        id: release
        uses: actions/github-script@v7
        with:
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

      - name: Check existing Bitbucket tag
        id: bitbucket
        run: |
          set -euo pipefail
          if [[ "${BITBUCKET_REPO_URL}" != https://* ]]; then
            echo "BITBUCKET_REPO_URL must start with https://: ${BITBUCKET_REPO_URL}" >&2
            exit 1
          fi
          ASKPASS_SCRIPT="$(mktemp)"
          printf '#!/bin/sh\necho "$BITBUCKET_API_TOKEN"\n' > "$ASKPASS_SCRIPT"
          chmod +x "$ASKPASS_SCRIPT"
          export GIT_ASKPASS="$ASKPASS_SCRIPT"
          REPO_URL="https://x-token-auth@${BITBUCKET_REPO_URL#https://}"
          TAG=$(git ls-remote --tags "${REPO_URL}" \
            | sed 's#^[^[:space:]]*[[:space:]]*refs/tags/##' \
            | { grep -v '\^{}' || true; } \
            | sort -V \
            | tail -n 1)
          echo "tag=${TAG}" >> "$GITHUB_OUTPUT"
          if [ "${TAG}" = "${RELEASE_TAG}" ]; then
            echo "skip=true" >> "$GITHUB_OUTPUT"
            echo "Bitbucket already at ${TAG}. Nothing to do."
          fi
          if git ls-remote --tags --exit-code "${REPO_URL}" "refs/tags/${RELEASE_TAG}" >/dev/null 2>&1; then
            echo "tag_exists=true" >> "$GITHUB_OUTPUT"
            echo "Tag ${RELEASE_TAG} already exists on Bitbucket. Tag push will be skipped."
          fi
        env:
          BITBUCKET_API_TOKEN: ${{ secrets.BITBUCKET_API_TOKEN }}
          RELEASE_TAG: ${{ steps.release.outputs.tag }}

      - name: Checkout release tag
        if: steps.bitbucket.outputs.skip != 'true'
        uses: actions/checkout@v4
        with:
          ref: ${{ steps.release.outputs.tag }}

      - name: Setup Node.js
        if: steps.bitbucket.outputs.skip != 'true'
        uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'npm'

      - name: Install dependencies
        if: steps.bitbucket.outputs.skip != 'true'
        run: npm ci

      - name: Lint and test
        if: steps.bitbucket.outputs.skip != 'true'
        run: |
          npm run lint
          npm run test

      - name: Stage plugin source mirror
        if: steps.bitbucket.outputs.skip != 'true'
        run: scripts/stage-plugin-dist.sh dist-staging
        env:
          NEXUS_EMBEDDING_REGION: ${{ vars.NEXUS_EMBEDDING_REGION }}
          NEXUS_EMBEDDING_PROFILE: ${{ vars.NEXUS_EMBEDDING_PROFILE }}
          NEXUS_EMBEDDING_MODEL: ${{ vars.NEXUS_EMBEDDING_MODEL }}
          NEXUS_EMBEDDING_DIMENSIONS: ${{ vars.NEXUS_EMBEDDING_DIMENSIONS }}

      - name: Verify source mirror builds standalone
        if: steps.bitbucket.outputs.skip != 'true'
        run: |
          cp -r dist-staging verify-build
          cd verify-build
          npm install --no-audit --no-fund
          npm run build
          test -f dist/bin/nexus.js
          echo "Source mirror is self-sufficient."

      - name: Validate plugin manifest
        if: steps.bitbucket.outputs.skip != 'true'
        run: npx claude plugin validate ./verify-build --strict

      - name: Push to Bitbucket
        if: steps.bitbucket.outputs.skip != 'true'
        run: |
          set -euo pipefail
          if [[ "${BITBUCKET_REPO_URL}" != https://* ]]; then
            echo "BITBUCKET_REPO_URL must start with https://: ${BITBUCKET_REPO_URL}" >&2
            exit 1
          fi
          ASKPASS_SCRIPT="$(mktemp)"
          printf '#!/bin/sh\necho "$BITBUCKET_API_TOKEN"\n' > "$ASKPASS_SCRIPT"
          chmod +x "$ASKPASS_SCRIPT"
          export GIT_ASKPASS="$ASKPASS_SCRIPT"
          cd dist-staging
          git init -b main
          git config user.name "github-actions"
          git config user.email "github-actions@users.noreply.github.com"
          git add .
          git commit -m "deploy ${{ steps.release.outputs.tag }}"
          git tag "${{ steps.release.outputs.tag }}"
          # トークンは GIT_ASKPASS 経由で渡し、remote URL やコマンド引数には出さない
          git remote add bitbucket "https://x-token-auth@${BITBUCKET_REPO_URL#https://}"
          git push --force bitbucket main
          if [ "${{ steps.bitbucket.outputs.tag_exists }}" = "true" ]; then
            echo "Skipping tag push because ${{ steps.release.outputs.tag }} already exists on Bitbucket."
          else
            git push bitbucket "${{ steps.release.outputs.tag }}"
          fi
        env:
          BITBUCKET_API_TOKEN: ${{ secrets.BITBUCKET_API_TOKEN }}
```

- [x] **Step 2: YAML として妥当か検証する**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy-plugin-to-bitbucket.yml')); print('YAML-OK')" 2>/dev/null || { npx --yes js-yaml .github/workflows/deploy-plugin-to-bitbucket.yml >/dev/null && echo YAML-OK; }`
Expected: `YAML-OK`（`python3` があればそれで、無ければ `js-yaml` フォールバックで検証する）。

- [x] **Step 3: 埋め込みシェルスクリプトの構文をチェックする**

`run: |` ブロック内のスクリプト(Check existing Bitbucket tag / Verify source mirror builds standalone / Push to Bitbucket)を一時ファイルに貼り付け、`bash -n <file>` で構文検証する。
Run 例: `bash -n /tmp/check-bitbucket.sh`
Expected: 出力なし・終了コード 0（構文エラーがないこと)。

- [x] **Step 4: actionlint が利用可能なら実行する（任意）**

Run: `command -v actionlint >/dev/null && actionlint .github/workflows/deploy-plugin-to-bitbucket.yml || echo "actionlint not installed; skip"`
Expected: `actionlint` 導入時は指摘なし。未導入時は `actionlint not installed; skip`。

- [x] **Step 5: コミットする**

Run:
```bash
git add .github/workflows/deploy-plugin-to-bitbucket.yml
git commit -m "feat: nexusプラグインをBitbucketへソースミラー配布するworkflowを追加"
```
Expected: 1 ファイルがコミットされる。

---

### Task 3: 設計 spec にソースミラー例外を追記

**Files:**
- Modify: `docs/superpowers/specs/2026-07-03-bitbucket-claude-plugins-marketplace.md`（§4「配布物への変換ルール」直下)

**Interfaces:**
- Consumes: なし。
- Produces: ネイティブ依存プラグイン(nexus 等)は dist-only ではなくソースミラーで配布する、という明文化された例外規定。

- [x] **Step 1: §4 の「除外するもの」節の直後に例外サブセクションを追記する**

`docs/superpowers/specs/2026-07-03-bitbucket-claude-plugins-marketplace.md` の「### 除外するもの」リスト末尾の後(「## 5. GitHub Actions ワークフロー」の直前)に、以下を挿入する。

```markdown
### 例外: ネイティブ依存プラグインの「ソースミラー」配布

`tsc` で非バンドルビルドし、かつネイティブ依存(例: `better-sqlite3`、`@lancedb/lancedb`)を持つプラグインは、上記「dist のみ」ルールを適用できない。ビルド済み `dist/` は実行時に `node_modules` を必要とし、ネイティブバイナリは利用者のプラットフォームで解決する必要があるためである。

この種のプラグイン(例: `yohi-nexus`)は、ビルド可能な最小ソース一式(`package.json`、`package-lock.json`、`tsconfig*.json`、`src/`、ワークスペース、`.claude-plugin/plugin.json`、`scripts/setup-plugin.sh`)を配布し、利用者マシンで Setup フックの `setup-plugin.sh` が `npm install` → `npm run build` を実行する「ソースミラー」方式を採る。実装は `.github/workflows/deploy-plugin-to-bitbucket.yml` および `scripts/stage-plugin-dist.sh` を参照。
```

- [x] **Step 2: markdownlint を確認する（既存基準からの逸脱がないこと）**

Run: `npx --yes markdownlint-cli2 "docs/superpowers/specs/2026-07-03-bitbucket-claude-plugins-marketplace.md" 2>&1 | tail -5`
Expected: 追記行が新規の MD013(行長)警告を増やさない範囲であること。既存同様、日本語散文はソフトラップ方針(`global-rules/MARKDOWN.md`)に従い、追加対応は不要。既存からの増分がある場合は 1 文が長くなりすぎていないか目視確認する。

- [x] **Step 3: コミットする**

Run:
```bash
git add docs/superpowers/specs/2026-07-03-bitbucket-claude-plugins-marketplace.md
git commit -m "docs: ネイティブ依存プラグインのソースミラー配布例外をspecに追記"
```
Expected: 1 ファイルがコミットされる。

---

## Post-Deploy（デプロイ実行と marketplace 登録）

コード(Task 1〜3)と Prerequisites(P1〜P4)完了後の運用手順。

- [ ] **D1: デプロイワークフローを手動実行する**
  - GitHub の Actions タブ → `Deploy plugin to Bitbucket` → `Run workflow`(`workflow_dispatch`)。
  - 成功後、Bitbucket `y-ohi/nexus` が 1 コミットのソースミラー + Release tag になっていることを確認する(`.gitignore` のみの状態が上書きされる)。

- [ ] **D2: marketplace カタログへ登録する**
  - 既存の `Update marketplace entry` ワークフロー(`.github/workflows/update-marketplace-entry.yml`)を `workflow_dispatch` で実行する。
  - 入力: `plugin_name=yohi-nexus`、`plugin_description=Nexus local code indexing and hybrid search MCP plugin`、`bitbucket_url=<Task 2 と同一のリポジトリ URL>`(既定 `https://bitbucket.org/y-ohi/nexus.git`。`vars.BITBUCKET_PLUGIN_REPO_URL` を上書きした場合はその値に合わせる)。
  - 前提: marketplace 用の Secret `BITBUCKET_MARKETPLACE_TOKEN`(こちらは既存ワークフローが要求する別トークン)が設定済みであること。

- [ ] **D3: 利用者側インストールを検証する**
  - Node.js `>= 24` の環境で、Claude Code から:
    ```text
    /plugin marketplace add git@bitbucket.org:y-ohi/claude-plugins.git
    /plugin install yohi-nexus@company-internal-plugins
    /reload-plugins
    ```
  - Setup フックの `setup-plugin.sh` が `npm install` → `npm run build` を実行し、`dist/bin/nexus.js` 生成後に MCP サーバ `nexus` が起動することを確認する。
  - 注意: 利用者マシンにはネイティブモジュールのビルド/取得のため Node.js 24+ と(prebuilt 非対応プラットフォームでは)C/C++ ビルドツールチェインが必要。

---

## Self-Review

**1. Spec coverage（ユーザー選択「ソースミラー方式」に対する網羅性)**
- 「ビルド可能な最小ソース一式を配布」→ Task 1(`stage-plugin-dist.sh` のファイル集合)。
- 「利用者マシンで `setup-plugin.sh` が `npm install && build`」→ `bootstrap.mjs` を除外することで else 分岐(`npm install --no-audit --no-fund` + build)を通す設計(Task 1 Interfaces / Global Constraints)。D3 で検証。
- 「Bitbucket へ force-push」→ Task 2(GIT_ASKPASS 認証・force-push・skip/tag_exists 判定)。
- 「dist-only が使えない理由の明文化」→ Task 3。
- 運用に必要な Bitbucket/GitHub 設定 → Prerequisites P1〜P4、marketplace 登録 → D2。ギャップなし。

**2. Placeholder scan**
- 「適切に」「必要に応じて」等の曖昧語、TODO/TBD、コードなしの実装ステップは無し。全コードブロックは完全な実体を含む。`claude plugin validate` は examples の既存実装に一致する実コードであり、Step 5 の自己完結ビルドが実質的な品質ゲートを兼ねる。

**3. Type/名称整合性**
- staging ディレクトリ名 `dist-staging`、検証用 `verify-build` はワークフロー内で一貫。
- スクリプトパス `scripts/stage-plugin-dist.sh` は Task 1(作成)と Task 2(`run: scripts/stage-plugin-dist.sh dist-staging`)で一致。
- Secret 名 `BITBUCKET_API_TOKEN`(本ワークフロー)と `BITBUCKET_MARKETPLACE_TOKEN`(既存 marketplace ワークフロー)の使い分けを D2 で明記。
- 配布先 URL `https://bitbucket.org/y-ohi/nexus.git` は Prerequisites・Task 2 デフォルト・D1 で一致。
