# パッケージ版配布ガイド

Nexus は社内 Claude Code plugin marketplace（Bitbucket Cloud）を通じて `yohi-nexus` として配布されます。本ドキュメントは、パッケージ版の配布前提条件（Prerequisites）と配布後の運用手順（Post-Deploy）をまとめたものです。

## Prerequisites（配布実行前の手動セットアップ）

これらはワークフロー実行前に必要な、Bitbucket / GitHub 側の運用設定です。コード実装は Prerequisites 未完了でも進められますが、**デプロイ実行前に必ず完了させてください**。

### P1: Bitbucket 配布リポジトリの確認

- **対象**: `https://bitbucket.org/y-ohi/nexus`（private）
- **現在の状態**: `.gitignore` のみ存在
- **確認内容**: リポジトリが存在すること。初回 force-push で既存内容は上書きされるため、現在の `.gitignore` のみの状態は問題ありません。

### P2: Bitbucket Repository Access Token 発行

- **手順**:
  1. Bitbucket の対象リポジトリ（`y-ohi/nexus`）にアクセス
  2. **Repository settings > Security > Access tokens** を開く
  3. **Create repository access token** をクリック
  4. スコープを `repository:write` に設定
  5. トークンを生成・コピー

- **重要**: リポジトリ単位で発行され、個人 Atlassian アカウントに依存しない最小権限トークンであることを確認してください。

### P3: GitHub Secret 登録

- **手順**:
  1. GitHub の nexus リポジトリにアクセス
  2. **Settings > Secrets and variables > Actions** を開く
  3. **New repository secret** をクリック
  4. **Name**: `BITBUCKET_API_TOKEN`
  5. **Secret**: P2 で生成したトークンをペースト
  6. **Add secret** をクリック

- **オプション**: 配布先を変更したい場合は、同じセクションで Repository variable `BITBUCKET_PLUGIN_REPO_URL` を設定します。未設定時はワークフローのデフォルト `https://bitbucket.org/y-ohi/nexus.git` が使用されます。

### P4: GitHub Release の存在確認

- **確認内容**: ワークフローは「最新の GitHub Release tag」を配布単位とします。release-please 運用により Release は既に作成されています（例: `v1.24.0`）。
- **失敗時**: Release が 1 つも無い場合、ワークフローは明示的に失敗します。

### P5: AWS 資格情報（利用者マシン）

- **対象**: パッケージ版は AWS Bedrock を直接呼び出します。
- **必要な認証**: 利用者マシンに AWS SDK デフォルト認証チェーンで解決可能な資格情報が必要です。以下のいずれかを用意してください:
  - 環境変数の IAM アクセスキー（`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`）
  - AWS SSO ログイン（`aws sso login`）
  - 名前付き AWS プロファイル（`~/.aws/credentials` の `[profile-name]`）
  - IAM ロール（EC2 インスタンス等での実行時）

- **詳細**: [SPEC.md §3.4 Embedder](../SPEC.md) の AWS 認証チェーンの記載を参照してください。

### P6: GitHub Actions 変数（デプロイ可変値）

- **手順**:
  1. GitHub の nexus リポジトリ **Settings > Secrets and variables > Actions** を開く
  2. **Variables** タブで以下を設定（未設定時はワークフロー内のデフォルト値が使用されます）:

| 変数名 | デフォルト値 | 説明 |
| --- | --- | --- |
| `NEXUS_EMBEDDING_REGION` | `us-east-1` | AWS Bedrock リージョン |
| `NEXUS_EMBEDDING_PROFILE` | （未設定） | 名前付き AWS プロファイル（オプション） |
| `NEXUS_EMBEDDING_MODEL` | `amazon.titan-embed-text-v2:0` | Embedding モデル |
| `NEXUS_EMBEDDING_DIMENSIONS` | `1024` | Embedding 次元数 |

- **用途**: ワークフローの `stage-plugin-dist.sh` 実行ステップに env として渡され、パッケージ版の `.claude-plugin/plugin.json` に固定値として注入されます。

---

## Post-Deploy 運用手順

### D1: デプロイワークフローを手動実行する

- **手順**:
  1. GitHub の nexus リポジトリ **Actions** タブを開く
  2. **Deploy plugin to Bitbucket** ワークフローを選択
  3. **Run workflow** をクリック
  4. ブランチは `master` のままで実行

- **確認内容**: ワークフロー完了後、以下を確認してください:
  - Bitbucket `y-ohi/nexus` リポジトリが 1 コミットのソースミラー + Release tag になっていること
  - `.gitignore` のみの状態が上書きされていること

### D2: Marketplace カタログへ登録する

- **前提**: 既存の `Update marketplace entry` ワークフロー（`.github/workflows/update-marketplace-entry.yml`）が設定済みであること。

- **手順**:
  1. GitHub の nexus リポジトリ **Actions** タブを開く
  2. **Update marketplace entry** ワークフローを選択
  3. **Run workflow** をクリック
  4. 以下の入力を指定:
     - **plugin_name**: `yohi-nexus`
     - **plugin_description**: `Nexus local code indexing and hybrid search MCP plugin`
     - **bitbucket_url**: D1 で配布したリポジトリ URL（既定 `https://bitbucket.org/y-ohi/nexus.git`。P6 で `BITBUCKET_PLUGIN_REPO_URL` を上書きした場合はその値に合わせる）

- **前提条件**: Marketplace 用の Secret `BITBUCKET_MARKETPLACE_TOKEN` が設定済みであること（P3 の `BITBUCKET_API_TOKEN` とは別のトークン）。

### D3: 利用者側インストールを検証する

- **環境**: Node.js `>= 24` がインストールされた環境

- **手順**:
  1. Claude Code を起動
  2. 以下のコマンドを実行:

     ```text
     /plugin marketplace add git@bitbucket.org:y-ohi/claude-plugins.git
     /plugin install yohi-nexus@company-internal-plugins
     /reload-plugins
     ```

- **確認内容**:
  - Setup フックの `setup-plugin.sh` が `npm install` → `npm run build` を実行すること
  - `dist/bin/nexus.js` が生成されること
  - MCP サーバー `nexus` が起動すること

- **注意**: 利用者マシンには以下が必要です:
  - Node.js 24 以上
  - C/C++ ビルドツールチェーン（prebuilt 非対応プラットフォームでのネイティブモジュールビルド用）
  - AWS 資格情報（P5 参照）

---

## ファイル配布構成

### 配布に含めるファイル

```text
.claude-plugin/plugin.json
package.json
package-lock.json
tsconfig.json
tsconfig.build.json
src/（全体）
packages/dashboard/package.json
packages/dashboard/src/
scripts/setup-plugin.sh
LICENSE
NOTICE
```

### 配布に含めないファイル

```text
scripts/bootstrap.mjs
scripts/doctor.mjs
scripts/license-check.mjs
tests/
packages/dashboard/tests/
eslint.config.mjs
vitest.config.ts
packages/dashboard/tsconfig*.json
packages/dashboard/vitest.config.ts
.github/
.devcontainer/
.codacy.yml
.nexus.json
docs/
examples/
SPEC.md
AGENTS.md
README.md
CHANGELOG.md
node_modules/
dist/
```

**理由**:

- `bootstrap.mjs` を除外することで、利用者マシンの `setup-plugin.sh` が `npm install --no-audit --no-fund` + `npm run build` パスを通り、インストール時 lint を避けます。
- `node_modules/` と `dist/` を除外することで、ソースミラーの自己完結性を保証します（利用者マシンで再ビルド）。

---

## トラブルシューティング

### ワークフロー実行時のエラー

| エラー | 原因 | 対応 |
| --- | --- | --- |
| `BITBUCKET_API_TOKEN not set` | P3 の Secret が未設定 | P3 を実行してください |
| `No releases found` | P4 の Release が存在しない | release-please で Release を作成してください |
| `Build failed` | ネイティブモジュールのビルド失敗 | ローカルで `npm ci && npm run build` を実行し、エラーを確認してください |

### 利用者側インストール時のエラー

| エラー | 原因 | 対応 |
| --- | --- | --- |
| `npm install` 失敗 | Node.js バージョン不足 / C++ ビルドツール未インストール | Node.js 24+ と C++ ビルドツールをインストールしてください |
| `healthCheck failed` | AWS 資格情報が無効 / Bedrock モデル未有効化 | P5 を確認し、AWS コンソールで Bedrock モデルアクセスを有効化してください |
| `MCP server not starting` | ポート競合 / 権限不足 | ローカルで `npx tsx src/bin/nexus.ts` を実行し、エラーログを確認してください |
