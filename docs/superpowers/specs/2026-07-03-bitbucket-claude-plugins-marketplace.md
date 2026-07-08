# Bitbucket 上の社内 Claude Code plugin marketplace 構築設計

## 1. 目的

社内で開発・管理している Claude Code 用 plugin を、Bitbucket Cloud 上にホストされた marketplace 経由で社員に配布できる仕組みを構築する。

- ソースコードは GitHub で管理し、レビュー・リリースフローを維持する。
- 配布物は Bitbucket Cloud 上のクリーンなリポジトリに限定し、Claude Code 標準の marketplace 機能を使ってインストールする。
- GitHub Actions でビルド・不要ファイル除去・Bitbucket へのプッシュを自動化する。
- 最新の GitHub Release tag を Bitbucket 配布リポジトリに反映し、すでに反映済みの場合は何もしない。

## 2. 全体アーキテクチャ

```text
GitHub (source of truth)
├── company/claude-plugins-marketplace-src    # marketplace source
├── company/plugin-a-src                      # plugin A source
└── company/plugin-b-src                      # plugin B source
         │
         │ GitHub Actions (workflow_dispatch)
         ▼
Bitbucket Cloud (distribution)
├── company/claude-plugins-marketplace.git    # 1-commit clean repo
│   └── .claude-plugin/marketplace.json
├── company/plugin-a-dist.git                 # 1-commit clean repo
│   ├── .claude-plugin/plugin.json
│   └── dist/...
└── company/plugin-b-dist.git                 # 1-commit clean repo
    ├── .claude-plugin/plugin.json
    └── dist/...

利用者（Claude Code 上）
/plugin marketplace add git@bitbucket.org:company/claude-plugins-marketplace.git
/plugin install plugin-a@company-internal-plugins
/reload-plugins
```

## 3. リポジトリ構成

### 3.1 plugin source repo（GitHub）

```text
plugin-a-src/
├── .github/
│   └── workflows/
│       └── deploy-to-bitbucket.yml    # 本設計のワークフロー
├── .claude-plugin/
│   └── plugin.json                    # plugin メタデータ・実行定義
├── src/                               # TypeScript ソース
├── tests/                             # テスト
├── scripts/                           # plugin 実行に必要なスクリプト
├── dist/                              # ビルド成果物（gitignore）
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

### 3.2 plugin distribution repo（Bitbucket）

```text
plugin-a-dist.git/          # 常に 1 commit のクリーンな状態
├── .claude-plugin/
│   └── plugin.json
├── dist/                    # ビルド済み JS / バイナリ
└── scripts/                 # plugin.json から参照される必要があるもののみ
```

### 3.3 marketplace source repo（GitHub）

```text
claude-plugins-marketplace-src/
├── .github/
│   └── workflows/
│       └── deploy-to-bitbucket.yml
├── .claude-plugin/
│   └── marketplace.json     # plugin catalog（refs は workflow で更新）
├── plugin-sources.json      # plugin 名 → GitHub source repo マッピング
└── README.md
```

### 3.4 marketplace distribution repo（Bitbucket）

```text
claude-plugins-marketplace.git/   # 常に 1 commit のクリーンな状態
└── .claude-plugin/
    └── marketplace.json
```

## 4. 配布物への変換ルール

GitHub Actions 上で staging ディレクトリを作成し、以下を Bitbucket 配布リポジトリに force-push する。

### 含めるもの

- `.claude-plugin/plugin.json`（plugin）または `marketplace.json`（marketplace）
- plugin 実行に必要なビルド済み成果物（`dist/` など）
- `plugin.json` から参照されるスクリプトや設定ファイル（例: `scripts/setup-plugin.sh`）

### 除外するもの

- `src/`、`tests/`、`node_modules/`
- TypeScript / lint / test 用設定（`tsconfig.json`、`eslint.config.mjs`、`vitest.config.ts` など）
- CI/CD 設定（`.github/`）
- エディタ設定（`.vscode/`）
- `.env` などの機密・環境依存ファイル
- ドキュメント（`README.md` 等、plugin 動作に不要なもの）
- 過去の git 履歴（`--depth=1` 相当の shallow、force-push 後 1 commit のみ）
- `plugin-sources.json` など、marketplace 配布時には不要な運用メタデータ

## 5. GitHub Actions ワークフロー

### 5.1 plugin source repo 用ワークフロー

発火条件: `workflow_dispatch` のみ。

動作概要:

1. GitHub リポジトリの最新リリースタグを GitHub API で取得する。Release が存在しない場合は `core.setFailed` で明示的に失敗させる。
2. Bitbucket 配布リポジトリの現在のタグを `git ls-remote --tags` で確認する。
   - 認証は GitHub Secret に保存した API トークンを使い、`GIT_ASKPASS`（一時スクリプト経由でトークンを渡す）で HTTPS 接続する。トークンをリモート URL やコマンドライン引数には含めない。`BITBUCKET_REPO_URL` が `https://` で始まらない場合は即座に失敗させる。
   - アノテーテッドタグの peeled ref（`^{}`）は除外する。
   - 取得した最新タグと一致していれば `skip=true` フラグを立て、後続ステップを全てスキップする。
   - デプロイ対象タグが Bitbucket 側に既存であれば `tag_exists=true` を立て、後続のタグ push をスキップする（タグを不変に保つ）。
3. 一致していなければ、該当タグを checkout する。
4. `npm ci`、`npm run build`、`npm run test`、`npm run lint` を実行する。
5. `claude plugin validate` を **ビルド後** に実行する。
6. staging ディレクトリを作成し、配布物のみコピーする。
   - `scripts/` 内は `plugin.json` から参照されているファイルのみコピーする。
7. staging 内で `git init -b main` し、1 コミット作成。
8. Bitbucket 配布リポジトリへ push する。`main` は force-push で 1 commit を維持し、タグは既存でなければ push する（既存タグは force-push しない）。

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
      BITBUCKET_REPO_URL: ${{ vars.BITBUCKET_REPO_URL || 'https://bitbucket.org/company/plugin-a-dist.git' }}
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
          if [[ "${BITBUCKET_REPO_URL}" != https://* ]]; then
            echo "BITBUCKET_REPO_URL must start with https://: ${BITBUCKET_REPO_URL}" >&2
            exit 1
          fi
          ASKPASS_SCRIPT="$(mktemp)"
          trap 'rm -f "$ASKPASS_SCRIPT"' EXIT
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
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        if: steps.bitbucket.outputs.skip != 'true'
        run: npm ci

      - name: Lint and test
        if: steps.bitbucket.outputs.skip != 'true'
        run: |
          npm run lint
          npm run test

      - name: Build
        if: steps.bitbucket.outputs.skip != 'true'
        run: npm run build

      - name: Validate plugin
        if: steps.bitbucket.outputs.skip != 'true'
        run: npx claude plugin validate ./ --strict

      - name: Stage distribution files
        if: steps.bitbucket.outputs.skip != 'true'
        run: |
          mkdir -p dist-staging/.claude-plugin
          cp .claude-plugin/plugin.json dist-staging/.claude-plugin/
          cp -r dist dist-staging/

          node <<'NODE'
          const fs = require('fs');
          const plugin = JSON.parse(fs.readFileSync('.claude-plugin/plugin.json', 'utf8'));
          const refs = new Set();
          function walk(v) {
            if (typeof v === 'string') {
              const m = v.match(/"?\$\{CLAUDE_PLUGIN_ROOT\}"?\/scripts\/([^"\s]+)/);
              if (m) refs.add(m[1]);
            } else if (Array.isArray(v)) {
              v.forEach(walk);
            } else if (v && typeof v === 'object') {
              Object.values(v).forEach(walk);
            }
          }
          walk(plugin);
          fs.writeFileSync('/tmp/referenced-scripts.txt', Array.from(refs).join('\n') + '\n');
          NODE
          if [ -s /tmp/referenced-scripts.txt ]; then
            mkdir -p dist-staging/scripts
            while IFS= read -r f; do
              [ -n "$f" ] && cp "scripts/$f" "dist-staging/scripts/$f"
            done < /tmp/referenced-scripts.txt
          fi

      - name: Push to Bitbucket
        if: steps.bitbucket.outputs.skip != 'true'
        run: |
          if [[ "${BITBUCKET_REPO_URL}" != https://* ]]; then
            echo "BITBUCKET_REPO_URL must start with https://: ${BITBUCKET_REPO_URL}" >&2
            exit 1
          fi
          ASKPASS_SCRIPT="$(mktemp)"
          trap 'rm -f "$ASKPASS_SCRIPT"' EXIT
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

### 5.2 marketplace source repo 用ワークフロー

発火条件: `workflow_dispatch` のみ。

動作概要:

1. GitHub リポジトリの最新リリースタグを取得する。Release が存在しない場合は `core.setFailed` で明示的に失敗させる。
2. Bitbucket marketplace 配布リポジトリの現在のタグを確認し、一致していれば後続をスキップする。認証は `GIT_ASKPASS` 経由の HTTPS（`x-token-auth`）で行う。
   - アノテーテッドタグの peeled ref（`^{}`）は除外する。
   - デプロイ対象タグが既存であれば `tag_exists=true` を立て、タグ push をスキップする。
3. `plugin-sources.json` に記載された各 plugin について、GitHub API で最新リリースタグを取得する。private な plugin source repo に対応するため `secrets.GH_PAT`（未設定時は `github.token`）を使用する。plugin の Release が存在しない場合は当該 plugin 名を明示して失敗させる。
4. `marketplace.json` 内の各 plugin の `source.ref` を最新タグに更新する。
5. staging ディレクトリを作成し、`.claude-plugin/marketplace.json` のみコピーする。
6. staging 内で `git init -b main` し、1 コミット作成。
7. Bitbucket marketplace 配布リポジトリへ push する。`main` は force-push、タグは既存でなければ push する。

```yaml
name: Deploy marketplace to Bitbucket

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      BITBUCKET_REPO_URL: ${{ vars.BITBUCKET_REPO_URL || 'https://bitbucket.org/company/claude-plugins-marketplace.git' }}
    steps:

      - name: Get latest marketplace release
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
          if [[ "${BITBUCKET_REPO_URL}" != https://* ]]; then
            echo "BITBUCKET_REPO_URL must start with https://: ${BITBUCKET_REPO_URL}" >&2
            exit 1
          fi
          ASKPASS_SCRIPT="$(mktemp)"
          trap 'rm -f "$ASKPASS_SCRIPT"' EXIT
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
      - name: Checkout
        if: steps.bitbucket.outputs.skip != 'true'
        uses: actions/checkout@v4

      - name: Update plugin refs to latest releases
        if: steps.bitbucket.outputs.skip != 'true'
        uses: actions/github-script@v7
        with:
          github-token: ${{ secrets.GH_PAT || github.token }}
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

      - name: Validate marketplace manifest
        if: steps.bitbucket.outputs.skip != 'true'
        run: |
          node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/marketplace.json'))"
          node -e "
            const m = JSON.parse(require('fs').readFileSync('.claude-plugin/marketplace.json'));
            if (!m.id || !m.name || !m.plugins) throw new Error('missing marketplace metadata');
            for (const [k, p] of Object.entries(m.plugins)) {
              if (!p.source?.repo || !p.source?.ref) throw new Error('missing source for ' + k);
            }
          "

      - name: Push to Bitbucket
        if: steps.bitbucket.outputs.skip != 'true'
        run: |
          if [[ "${BITBUCKET_REPO_URL}" != https://* ]]; then
            echo "BITBUCKET_REPO_URL must start with https://: ${BITBUCKET_REPO_URL}" >&2
            exit 1
          fi
          ASKPASS_SCRIPT="$(mktemp)"
          trap 'rm -f "$ASKPASS_SCRIPT"' EXIT
          printf '#!/bin/sh\necho "$BITBUCKET_API_TOKEN"\n' > "$ASKPASS_SCRIPT"
          chmod +x "$ASKPASS_SCRIPT"
          export GIT_ASKPASS="$ASKPASS_SCRIPT"
          mkdir -p dist-staging/.claude-plugin
          cp .claude-plugin/marketplace.json dist-staging/.claude-plugin/
          cd dist-staging
          git init -b main
          git config user.name "github-actions"
          git config user.email "github-actions@users.noreply.github.com"
          git add .
          git commit -m "deploy marketplace ${{ steps.release.outputs.tag }}"
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

### 5.3 `plugin-sources.json` の例

```json
{
  "plugin-a": "company/plugin-a-src",
  "plugin-b": "company/plugin-b-src"
}
```

## 6. 認証

### 6.1 GitHub Actions → Bitbucket

- **Bitbucket Access Token**（Repository Access Token、HTTPS）を推奨する。
  - Bitbucket の **Repository settings > Security > Access tokens** で `repository:write` スコープの Access Token を発行する。リポジトリ単位で発行されるため、個人の Atlassian アカウントに依存しない。
  - GitHub リポジトリの **Settings > Secrets and variables > Actions** に発行したトークンを `BITBUCKET_API_TOKEN` として保存する。
  - ワークフローは `GIT_ASKPASS`（一時スクリプトでトークンを標準出力し `git` の認証プロンプトに渡す方式）経由で HTTPS 認証する。リモート URL は `https://x-token-auth@bitbucket.org/...` の形式を用い、トークンをリモート URL やコマンドライン引数には含めず、ログにも残さない。
- Access Keys（Repository settings > Security > Access keys、SSH）は read-only 専用で push できないため採用しない。個人アカウント単位の **API トークン**（廃止予定の App Password の後継）は複数リポジトリへの広いアクセス権を持ち CI 用途では過剰権限になるため、リポジトリ単位で最小権限を発行できる Access Token を採用する。
- Bitbucket Cloud は GitHub Actions の OIDC 連携に非対応であり、GitHub Deploy Keys も鍵ペアの手動生成・管理を要するため、鍵管理が不要な Access Token 方式を採用する。

### 6.2 利用者 → Bitbucket

- 各社員は Bitbucket Cloud にアクセスできる SSH 鍵をローカルマシンに設定しておく。
- HTTPS を使う場合は git credential helper に API トークン（廃止予定の App Password の後継）を登録しておく。

## 7. 利用者向け手順

```text
/plugin marketplace add git@bitbucket.org:company/claude-plugins-marketplace.git
/plugin install plugin-a@company-internal-plugins
/reload-plugins
```

## 8. バージョニングとべき等性

- 配布は GitHub Release tag を単位とする。
- ワークフローはデプロイ前に Bitbucket 側の最新 tag を確認し、一致していれば `skip=true` フラグで後続をスキップする。
- 配布リポジトリは常に force-push により 1 commit のみ保持する。

## 9. セキュリティ・運用留意点

- Bitbucket 配布リポジトリは private に設定する。
- GitHub Actions の secret は最小権限で運用し、Bitbucket Access Token は `repository:write` スコープに限定して発行する。漏洩に備え、定期的なローテーションと即時失効の運用を徹底する。
- plugin 内で外部コマンドや MCP server を起動する場合、配布物に不要なファイル（ソースコード、テスト、.env 等）が含まれていないことを staging ルールで徹底する。
- `claude plugin validate --strict` を plugin ワークフロー内で **ビルド後** に必ず実行し、manifest typo や型ミスをデプロイ前に検出する。

## 10. 実装状況

本設計は PoC として実装済みであり、テンプレート一式は [`examples/bitbucket-claude-plugins-marketplace/`](../../../examples/bitbucket-claude-plugins-marketplace/) 配下にある（marketplace source / plugin-a source の各テンプレート、`deploy-to-bitbucket.yml`、ローカル検証スクリプト `validate-poc.sh`）。本ドキュメントは実装済みワークフローと整合した設計 SSOT として維持する。
