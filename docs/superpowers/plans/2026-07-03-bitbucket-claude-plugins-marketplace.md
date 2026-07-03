# Bitbucket 社内 Claude Code plugin marketplace 構築 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 本設計に基づき、GitHub source repo 用テンプレートと marketplace source repo 用テンプレートを `examples/bitbucket-claude-plugins-marketplace/` 以下に作成し、JSON / YAML / シェルスクリプトの構文検証をパスする PoC を完成させる。

**Architecture:** 1 つの PoC ディレクトリ内に marketplace source repo と plugin source repo のテンプレートを並べ、それぞれに `workflow_dispatch` 専用の GitHub Actions workflow を配置する。marketplace workflow は `plugin-sources.json` を読み、GitHub API で各 plugin の最新 release tag を取得して `marketplace.json` の `source.ref` を更新する。plugin workflow は release tag 単位で `npm ci` → lint/test → build → `claude plugin validate` → Bitbucket 配布 repo への force-push を行う。

**Tech Stack:** GitHub Actions, Bitbucket Cloud Git, YAML, Node.js, TypeScript, Vitest, shell script, SSH deploy key.

## Global Constraints

- 全 workflow は `workflow_dispatch` のみで発火する。
- GitHub → Bitbucket への認証は SSH deploy key (`secrets.BITBUCKET_SSH_KEY`) を使用する。
- Bitbucket 配布 repo は private に設定し、force-push 後は常に 1 commit のみを保持する。
- plugin workflow は build 後に `npx claude plugin validate ./ --strict` を実行する。
- 配布 repo には `src/` / `tests/` / `node_modules/` / CI 設定 / ドキュメントは含めない。
- 本 PoC では組織名の例として `acme-corp` を使用する。実運用時は自身の GitHub/Bitbucket organization 名に置換すること。

---

## 想定ファイル構成（実行後）

```text
examples/bitbucket-claude-plugins-marketplace/
├── README.md
├── validate-poc.sh
├── claude-plugins-marketplace-src/
│   ├── .claude-plugin/
│   │   └── marketplace.json
│   ├── plugin-sources.json
│   └── .github/
│       └── workflows/
│           └── deploy-to-bitbucket.yml
└── plugin-a-src/
    ├── .claude-plugin/
    │   └── plugin.json
    ├── .github/
    │   └── workflows/
    │       └── deploy-to-bitbucket.yml
    ├── scripts/
    │   └── setup-plugin.sh
    ├── src/
    │   └── index.ts
    ├── tests/
    │   └── index.test.ts
    ├── .gitignore
    ├── package.json
    ├── package-lock.json
    ├── tsconfig.json
    └── vitest.config.ts
```

---

### Task 1: PoC ルート README を作成する

**Files:**
- Create: `examples/bitbucket-claude-plugins-marketplace/README.md`

**Interfaces:**
- Produces: 全体構成、各ディレクトリの役割、セットアップ手順、利用者向けコマンド例。

- [ ] **Step 1: README を作成する**

```markdown
# Bitbucket 社内 Claude Code plugin marketplace PoC

本ディレクトリは [Bitbucket 上の社内 Claude Code plugin marketplace 構築設計](../../specs/2026-07-03-bitbucket-claude-plugins-marketplace.md) の PoC テンプレートである。

## 構成

- `claude-plugins-marketplace-src/`: marketplace source repo 用テンプレート
- `plugin-a-src/`: plugin source repo 用テンプレート（コピーして `plugin-b-src` などを作成可能）

## セットアップ

1. 本テンプレートを GitHub 上の実際の organization にコピーする。
   - `acme-corp` を実際の organization 名に置換する。
2. Bitbucket Cloud 上に配布用 private repo を作成する。
   - `acme-corp/claude-plugins-marketplace.git`
   - `acme-corp/plugin-a-dist.git`
3. 各 Bitbucket repo の Settings > Access keys に GitHub Actions 用 SSH 公開鍵を登録する。
4. 各 GitHub source repo の Settings > Secrets and variables > Actions に秘密鍵を `BITBUCKET_SSH_KEY` として保存する。

## 利用者向け手順（Claude Code 上）

```text
/plugin marketplace add git@bitbucket.org:acme-corp/claude-plugins-marketplace.git
/plugin install plugin-a@company-internal-plugins
/reload-plugins
```

## 注意

- 配布 repo は force-push により常に 1 commit のみ保持される。
- plugin workflow は release tag 単位で実行され、Bitbucket 側の最新 tag と一致する場合はスキップされる。
- 本 PoC の workflow では `StrictHostKeyChecking=accept-new` を使用している。実運用では Bitbucket の SSH ホストキーを `known_hosts` に事前登録すること。
```

- [ ] **Step 2: 作成したファイルが正しく配置されていることを確認する**

Run: `ls -la examples/bitbucket-claude-plugins-marketplace/README.md`
Expected: ファイルが存在する。

- [ ] **Step 3: Commit する**

```bash
git add examples/bitbucket-claude-plugins-marketplace/README.md
git commit -m "docs: Bitbucket marketplace PoC の README を追加"
```

---

### Task 2: Marketplace source repo テンプレートを作成する

**Files:**
- Create: `examples/bitbucket-claude-plugins-marketplace/claude-plugins-marketplace-src/.claude-plugin/marketplace.json`
- Create: `examples/bitbucket-claude-plugins-marketplace/claude-plugins-marketplace-src/plugin-sources.json`
- Create: `examples/bitbucket-claude-plugins-marketplace/claude-plugins-marketplace-src/.github/workflows/deploy-to-bitbucket.yml`

**Interfaces:**
- Consumes: `plugin-sources.json` に記載された `plugin name -> GitHub owner/repo` マッピング。
- Produces: Bitbucket 配布 repo に push される `.claude-plugin/marketplace.json`。

- [ ] **Step 1: `marketplace.json` を作成する**

```json
{
  "id": "company-internal-plugins",
  "name": "Company Internal Plugins",
  "description": "Internal Claude Code plugins distributed via Bitbucket Cloud.",
  "plugins": {
    "plugin-a": {
      "name": "Plugin A",
      "source": {
        "repo": "git@bitbucket.org:acme-corp/plugin-a-dist.git",
        "ref": "v0.1.0"
      }
    }
  }
}
```

- [ ] **Step 2: `plugin-sources.json` を作成する**

```json
{
  "plugin-a": "acme-corp/plugin-a-src"
}
```

- [ ] **Step 3: marketplace 用 workflow を作成する**

```yaml
name: Deploy marketplace to Bitbucket

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:

      - name: Get latest marketplace release
        id: release
        uses: actions/github-script@v7
        with:
          script: |
            const { data: release } = await github.rest.repos.getLatestRelease({
              owner: context.repo.owner,
              repo: context.repo.repo,
            });
            core.setOutput('tag', release.tag_name);

      - name: Check existing Bitbucket tag
        id: bitbucket
        run: |
          mkdir -p ~/.ssh
          printf '%s\n' "${BITBUCKET_SSH_KEY}" > ~/.ssh/bitbucket
          chmod 600 ~/.ssh/bitbucket
          # PoC 段階では accept-new を使用。実運用では Bitbucket のホストキーを known_hosts に事前登録してください。
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
        env:
          BITBUCKET_REPO_URL: git@bitbucket.org:acme-corp/claude-plugins-marketplace.git
          BITBUCKET_SSH_KEY: ${{ secrets.BITBUCKET_SSH_KEY }}
          RELEASE_TAG: ${{ steps.release.outputs.tag }}
      - name: Checkout
        if: steps.bitbucket.outputs.skip != 'true'
        uses: actions/checkout@v4

      - name: Update plugin refs to latest releases
        if: steps.bitbucket.outputs.skip != 'true'
        uses: actions/github-script@v7
        with:
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
          mkdir -p ~/.ssh
          printf '%s\n' "${BITBUCKET_SSH_KEY}" > ~/.ssh/bitbucket
          chmod 600 ~/.ssh/bitbucket
          mkdir -p dist-staging/.claude-plugin
          cp .claude-plugin/marketplace.json dist-staging/.claude-plugin/
          cd dist-staging
          git init -b main
          git config user.name "github-actions"
          git config user.email "github-actions@users.noreply.github.com"
          git add .
          git commit -m "deploy marketplace ${{ steps.release.outputs.tag }}"
          git tag "${{ steps.release.outputs.tag }}"
          # PoC 段階では accept-new を使用。実運用では Bitbucket のホストキーを known_hosts に事前登録してください。
          GIT_SSH_COMMAND='ssh -i ~/.ssh/bitbucket -o StrictHostKeyChecking=accept-new' git push --force "${BITBUCKET_REPO_URL}" main
          # PoC 段階では accept-new を使用。実運用では Bitbucket のホストキーを known_hosts に事前登録してください。
          GIT_SSH_COMMAND='ssh -i ~/.ssh/bitbucket -o StrictHostKeyChecking=accept-new' git push --force "${BITBUCKET_REPO_URL}" "${{ steps.release.outputs.tag }}"
        env:
          BITBUCKET_REPO_URL: git@bitbucket.org:acme-corp/claude-plugins-marketplace.git
          BITBUCKET_SSH_KEY: ${{ secrets.BITBUCKET_SSH_KEY }}
```

- [ ] **Step 4: JSON が well-formed であることを検証する**

Run: `python3 -m json.tool examples/bitbucket-claude-plugins-marketplace/claude-plugins-marketplace-src/.claude-plugin/marketplace.json >/dev/null && python3 -m json.tool examples/bitbucket-claude-plugins-marketplace/claude-plugins-marketplace-src/plugin-sources.json >/dev/null`
Expected: 両方とも exit code 0 で何も出力しない。

- [ ] **Step 5: Commit する**

```bash
git add examples/bitbucket-claude-plugins-marketplace/claude-plugins-marketplace-src/
git commit -m "feat: marketplace source repo のテンプレートを追加"
```

---

### Task 3: Plugin A source repo テンプレートを作成する

**Files:**
- Create: `examples/bitbucket-claude-plugins-marketplace/plugin-a-src/.claude-plugin/plugin.json`
- Create: `examples/bitbucket-claude-plugins-marketplace/plugin-a-src/.github/workflows/deploy-to-bitbucket.yml`
- Create: `examples/bitbucket-claude-plugins-marketplace/plugin-a-src/scripts/setup-plugin.sh`
- Create: `examples/bitbucket-claude-plugins-marketplace/plugin-a-src/src/index.ts`
- Create: `examples/bitbucket-claude-plugins-marketplace/plugin-a-src/tests/index.test.ts`
- Create: `examples/bitbucket-claude-plugins-marketplace/plugin-a-src/package.json`
- Create: `examples/bitbucket-claude-plugins-marketplace/plugin-a-src/package-lock.json`
- Create: `examples/bitbucket-claude-plugins-marketplace/plugin-a-src/tsconfig.json`
- Create: `examples/bitbucket-claude-plugins-marketplace/plugin-a-src/vitest.config.ts`
- Create: `examples/bitbucket-claude-plugins-marketplace/plugin-a-src/.gitignore`

**Interfaces:**
- Consumes: `scripts/setup-plugin.sh` は `plugin.json` 内の `"${CLAUDE_PLUGIN_ROOT}/scripts/setup-plugin.sh"` から参照される。
- Produces: build 後に `dist/index.js` を生成し、Bitbucket 配布 repo へ force-push する。

- [ ] **Step 1: `plugin.json` を作成する**

```json
{
  "id": "plugin-a",
  "name": "Plugin A",
  "version": "0.1.0",
  "description": "Sample internal plugin for the Bitbucket marketplace PoC.",
  "entrypoint": "${CLAUDE_PLUGIN_ROOT}/dist/index.js",
  "scripts": {
    "setup": "${CLAUDE_PLUGIN_ROOT}/scripts/setup-plugin.sh"
  }
}
```

- [ ] **Step 2: plugin 用 workflow を作成する**

```yaml
name: Deploy plugin to Bitbucket

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Get latest GitHub release
        id: release
        uses: actions/github-script@v7
        with:
          script: |
            const { data: release } = await github.rest.repos.getLatestRelease({
              owner: context.repo.owner,
              repo: context.repo.repo,
            });
            core.setOutput('tag', release.tag_name);

      - name: Check existing Bitbucket tag
        id: bitbucket
        run: |
          mkdir -p ~/.ssh
          printf '%s\n' "${BITBUCKET_SSH_KEY}" > ~/.ssh/bitbucket
          chmod 600 ~/.ssh/bitbucket
          # PoC 段階では accept-new を使用。実運用では Bitbucket のホストキーを known_hosts に事前登録してください。
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
        env:
          BITBUCKET_REPO_URL: git@bitbucket.org:acme-corp/plugin-a-dist.git
          BITBUCKET_SSH_KEY: ${{ secrets.BITBUCKET_SSH_KEY }}
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
          mkdir -p ~/.ssh
          printf '%s\n' "${BITBUCKET_SSH_KEY}" > ~/.ssh/bitbucket
          chmod 600 ~/.ssh/bitbucket
          cd dist-staging
          git init -b main
          git config user.name "github-actions"
          git config user.email "github-actions@users.noreply.github.com"
          git add .
          git commit -m "deploy ${{ steps.release.outputs.tag }}"
          git tag "${{ steps.release.outputs.tag }}"
          # PoC 段階では accept-new を使用。実運用では Bitbucket のホストキーを known_hosts に事前登録してください。
          GIT_SSH_COMMAND='ssh -i ~/.ssh/bitbucket -o StrictHostKeyChecking=accept-new' git push --force "${BITBUCKET_REPO_URL}" main
          # PoC 段階では accept-new を使用。実運用では Bitbucket のホストキーを known_hosts に事前登録してください。
          GIT_SSH_COMMAND='ssh -i ~/.ssh/bitbucket -o StrictHostKeyChecking=accept-new' git push --force "${BITBUCKET_REPO_URL}" "${{ steps.release.outputs.tag }}"
        env:
          BITBUCKET_REPO_URL: git@bitbucket.org:acme-corp/plugin-a-dist.git
          BITBUCKET_SSH_KEY: ${{ secrets.BITBUCKET_SSH_KEY }}
```

- [ ] **Step 3: `scripts/setup-plugin.sh` を作成する**

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "Plugin A setup completed."
```

- [ ] **Step 4: `src/index.ts` を作成する**

```typescript
export function greet(name: string): string {
  return `Hello from Plugin A, ${name}!`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(greet('Claude Code'));
}
```

- [ ] **Step 5: `tests/index.test.ts` を作成する**

```typescript
import { describe, it, expect } from 'vitest';
import { greet } from '../src/index';

describe('greet', () => {
  it('returns a personalized greeting', () => {
    expect(greet('World')).toBe('Hello from Plugin A, World!');
  });
});
```

- [ ] **Step 6: `package.json` を作成する**

```json
{
  "name": "plugin-a",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "lint": "echo 'lint skipped in PoC template'"
  },
  "devDependencies": {
    "typescript": "^5.3.3",
    "vitest": "^1.0.0"
  }
}
```

- [ ] **Step 7: `package-lock.json` を生成する**

Run: `cd examples/bitbucket-claude-plugins-marketplace/plugin-a-src && npm install`
Expected: `package-lock.json` が生成される。

> 本 PoC テンプレートでは手動で `npm install` を実行し、生成された `package-lock.json` をコミットしてください。CI 内の `npm ci` と `actions/setup-node` の `cache: 'npm'` はロックファイルを必要とします。


- [ ] **Step 8: `tsconfig.json` を作成する**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 9: `vitest.config.ts` を作成する**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

- [ ] **Step 10: `.gitignore` を作成する**

```gitignore
node_modules/
dist/
.env
*.log
```

- [ ] **Step 11: `scripts/setup-plugin.sh` に実行権限を付与する**

Run: `chmod +x examples/bitbucket-claude-plugins-marketplace/plugin-a-src/scripts/setup-plugin.sh`
Expected: 実行権限が付与され、exit code 0。

- [ ] **Step 12: JSON / シェルスクリプトの構文を検証する**

Run: `python3 -m json.tool examples/bitbucket-claude-plugins-marketplace/plugin-a-src/.claude-plugin/plugin.json >/dev/null && python3 -m json.tool examples/bitbucket-claude-plugins-marketplace/plugin-a-src/package.json >/dev/null && python3 -m json.tool examples/bitbucket-claude-plugins-marketplace/plugin-a-src/tsconfig.json >/dev/null`
Expected: exit code 0。

Run: `bash -n examples/bitbucket-claude-plugins-marketplace/plugin-a-src/scripts/setup-plugin.sh`
Expected: exit code 0。

- [ ] **Step 13: Commit する**

```bash
git add examples/bitbucket-claude-plugins-marketplace/plugin-a-src/
git commit -m "feat: plugin A source repo のテンプレートを追加"
```

---

### Task 4: ローカル検証スクリプトを作成する

**Files:**
- Create: `examples/bitbucket-claude-plugins-marketplace/validate-poc.sh`

**Interfaces:**
- Consumes: Task 1〜3 で作成した全 JSON / YAML / shell script。
- Produces: 構文エラーがあれば非ゼロ終了する検証結果。

- [ ] **Step 1: `validate-poc.sh` を作成する**

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"

json_files=(
  "${BASE_DIR}/claude-plugins-marketplace-src/.claude-plugin/marketplace.json"
  "${BASE_DIR}/claude-plugins-marketplace-src/plugin-sources.json"
  "${BASE_DIR}/plugin-a-src/.claude-plugin/plugin.json"
  "${BASE_DIR}/plugin-a-src/package.json"
  "${BASE_DIR}/plugin-a-src/tsconfig.json"
)

for f in "${json_files[@]}"; do
  echo "Validating JSON: ${f}"
  python3 -m json.tool "$f" >/dev/null
done

echo "Validating shell script: ${BASE_DIR}/plugin-a-src/scripts/setup-plugin.sh"
bash -n "${BASE_DIR}/plugin-a-src/scripts/setup-plugin.sh"

workflow_files=(
  "${BASE_DIR}/claude-plugins-marketplace-src/.github/workflows/deploy-to-bitbucket.yml"
  "${BASE_DIR}/plugin-a-src/.github/workflows/deploy-to-bitbucket.yml"
)

if command -v actionlint >/dev/null 2>&1; then
  for f in "${workflow_files[@]}"; do
    echo "Linting GitHub Actions workflow: ${f}"
    actionlint "$f"
  done
else
  echo "actionlint not found; skipping workflow lint. Install with: go install github.com/rhysd/actionlint/cmd/actionlint@latest"
fi

echo "All PoC validations passed."
```

- [ ] **Step 2: 実行権限を付与する**

Run: `chmod +x examples/bitbucket-claude-plugins-marketplace/validate-poc.sh`
Expected: exit code 0。

- [ ] **Step 3: 検証スクリプトを実行する**

Run: `examples/bitbucket-claude-plugins-marketplace/validate-poc.sh`
Expected: 各 JSON / shell script の検証が通り、`All PoC validations passed.` と表示される（actionlint が未インストールの場合は警告メッセージを含む）。

- [ ] **Step 4: Commit する**

```bash
git add examples/bitbucket-claude-plugins-marketplace/validate-poc.sh
git commit -m "feat: PoC ローカル検証スクリプトを追加"
```

---

### Task 5: 最終検証と仕様カバレッジ確認

**Files:**
- Modify: なし（検証のみ）

**Interfaces:**
- Consumes: これまでに作成した全ファイル。

- [ ] **Step 1: 想定ファイル構成が揃っているか確認する**

Run:
```bash
tree examples/bitbucket-claude-plugins-marketplace/ 2>/dev/null || find examples/bitbucket-claude-plugins-marketplace/ -type f | sort
```
Expected: Task 1〜4 で作成したすべてのファイルが存在する。

- [ ] **Step 2: 仕様カバレッジを確認する**

設計書の各要件を確認し、対応する Task を挙げる：

| 設計書要件 | 対応 Task |
|---|---|
| GitHub source repo でソースを管理 | Task 3（plugin source repo テンプレート） |
| Bitbucket 配布 repo は 1 commit のクリーン状態 | Task 2 / Task 3 workflow 内 `git init -b main` + force-push |
| `workflow_dispatch` のみ発火 | Task 2 / Task 3 workflow の `on: workflow_dispatch` |
| GitHub Release tag を Bitbucket tag に反映 | Task 2 / Task 3 workflow 内 `git tag` + push |
| tag が既存ならスキップ | Task 2 / Task 3 workflow 内 `skip=true` 判定 |
| plugin.json / marketplace.json のみ配布物に含める | Task 2 / Task 3 staging ステップ |
| scripts/ は plugin.json 参照分のみコピー | Task 3 workflow 内 `referenced-scripts.txt` 抽出ロジック |
| `claude plugin validate --strict` を build 後に実行 | Task 3 workflow 内 Validate plugin ステップ |
| SSH deploy key を使用 | Task 2 / Task 3 workflow 内 `BITBUCKET_SSH_KEY` |
| marketplace.json の `source.ref` を最新 tag に更新 | Task 2 workflow 内 Update plugin refs ステップ |

- [ ] **Step 3: プレースホルダー・赤フラグをスキャンする**

Run:
```bash
grep -R -n -E 'TODO|FIXME|TBD|XXX|implement later|fill in details' examples/bitbucket-claude-plugins-marketplace/ || true
```
Expected: 上記パターンの文字列が含まれていない。

- [ ] **Step 4: 最終コミットをまとめる（任意）**

変更が複数コミットに分かれている場合、整理したいときのみ実行：

```bash
git log --oneline -5
```

その後、必要に応じて `git rebase -i` などで整理する。ただし本計画では「frequent commits」を推奨するため、タスクごとのコミットのままでも問題ない。

---

## Self-Review Checklist

**1. Spec coverage:**

- [x] GitHub source repo / Bitbucket dist repo 分離 → Task 2 / Task 3
- [x] `workflow_dispatch` のみ → Task 2 / Task 3 workflow
- [x] release tag ベースのべき等デプロイ → Task 2 / Task 3 workflow
- [x] staging による不要ファイル除去 → Task 2 / Task 3 workflow
- [x] `claude plugin validate --strict` → Task 3 workflow
- [x] SSH deploy key 認証 → Task 2 / Task 3 workflow
- [x] marketplace.json の `source.ref` 自動更新 → Task 2 workflow
- [x] plugin-sources.json → Task 2

**2. Placeholder scan:**

- [x] 計画内に `TODO` / `TBD` / `implement later` / `fill in details` / 型や関数の未定義参照はない。
- [x] `acme-corp` は具体的な例として一貫して使用されている。実運用時の置換は README の手順で説明済み。

**3. Type consistency:**

- [x] `marketplace.json` の `plugins.<name>.source.repo` / `source.ref` は Task 2 workflow で更新される。
- [x] `plugin-sources.json` の key は `marketplace.json` の `plugins` key と一致（`plugin-a`）。
- [x] `plugin.json` 内の `${CLAUDE_PLUGIN_ROOT}/scripts/setup-plugin.sh` は `scripts/setup-plugin.sh` に対応。
- [x] `tsconfig.json` の `outDir` は `dist` であり、workflow の `cp -r dist dist-staging/` と一致。
