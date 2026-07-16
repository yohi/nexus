# Nexus ⚡️ (yohi-nexus Claude Code Plugin)

> [!IMPORTANT]
> このリポジトリは、社内 Claude Code plugin marketplace 配布用に **GitHub 上のソースリポジトリから自動生成されたミラー** です。
> 直接コミットや Pull Request を作成しないでください。変更は GitHub Release をトリガーに `Deploy plugin to Bitbucket` ワークフローが `force-push` で上書きします。

`yohi-nexus` は、AI エージェントのためのローカル MCP ベース・コードインデックス基盤 [Nexus](https://github.com/yohi/nexus) を Claude Code の Plugin として配布するための本体です。ハイブリッド検索（LanceDB ベクトル検索 + ripgrep）や AST ベースのコンテキスト取得を、ローカル実行の MCP サーバーとして提供します。

## 📦 インストール方法

Claude Code で以下を実行してください。

```text
/plugin marketplace add git@bitbucket.org:y-ohi/claude-plugins.git
/plugin install yohi-nexus@company-internal-plugins
/reload-plugins
```

インストール時（Setup / SessionStart フック）に `scripts/setup-plugin.sh` が自動実行され、`npm install` → `npm run build` によってローカルでビルドされます。事前ビルド済みバイナリを取得するわけではないため、以下の前提条件を満たすマシンで実行してください。

## ✅ 前提条件

- Node.js `>= 24`
- C/C++ ビルドツールチェーン（`better-sqlite3` / `@lancedb/lancedb` の prebuilt 非対応プラットフォームでのネイティブモジュールビルド用）
- AWS 資格情報（AWS SDK デフォルト認証チェーンで解決可能なもの: 環境変数 / `aws sso login` / 名前付きプロファイル / IAM ロールのいずれか）
  - このパッケージ版は Embedding プロバイダを AWS Bedrock（Titan Embed Text v2）に固定しています。事前に AWS コンソールで Bedrock の Model access を有効化してください。

## ⚙️ このパッケージ版の挙動

このリポジトリの `.claude-plugin/plugin.json` は、ソースリポジトリの `scripts/stage-plugin-dist.sh` によって配布時に以下のように変換されています。

- `userConfig`（Embedding プロバイダ選択 UI）を除去
- `mcpServers.nexus.env` を固定値に置換:
  - `NEXUS_PACKAGE_MODE=1`（fail-fast モードを有効化）
  - `NEXUS_EMBEDDING_PROVIDER=bedrock`（Embedding プロバイダを Bedrock にハードロック）
  - `NEXUS_EMBEDDING_MODEL` / `NEXUS_EMBEDDING_DIMENSIONS` / `NEXUS_EMBEDDING_REGION`（配布時に固定値として注入）

利用者側で `embedding.provider` を変更することはできません。モデルやリージョンの変更が必要な場合は、ソースリポジトリ側で再配布してください。

## 🧰 主な機能

- **ハイブリッド検索**: LanceDB ベクトル検索 + ripgrep を RRF で統合
- **インテリジェント・チャンキング**: AST 解析による関数単位の分割
- **ダッシュボード (TUI)**: `nexus dashboard` でインデックス状態をリアルタイム監視
- **Observability**: Prometheus メトリクスを公開（`packageMode=true` では Aggregator への自動登録のみスキップされます）

MCP ツール（`hybrid_search` / `semantic_search` / `grep_search` / `get_context` / `index_status` / `reindex`）の詳細は、ソースリポジトリの `docs/mcp-tools.md` を参照してください。

## 🩺 トラブルシューティング

| エラー | 原因 | 対応 |
| --- | --- | --- |
| `npm install` 失敗 | Node.js バージョン不足 / C++ ビルドツール未インストール | Node.js 24+ と C++ ビルドツールをインストールしてください |
| `healthCheck failed` | AWS 資格情報が無効 / Bedrock モデル未有効化 | AWS コンソールで Bedrock の Model access を有効化し、資格情報を確認してください |
| `MCP server not starting` | ポート競合 / 権限不足 | このディレクトリで `npx tsx src/bin/nexus.ts` を直接実行し、エラーログを確認してください |

## 📚 詳細ドキュメント・不具合報告

このリポジトリはビルド専用のソースミラーであり、開発ドキュメント（`SPEC.md` / `AGENTS.md` / `docs/`）や Issue 管理は含まれていません。詳細な仕様、設定項目、コントリビューションについては、ソースリポジトリを参照してください。

- ソースリポジトリ: <https://github.com/yohi/nexus>

## ⚠️ ライセンス

MIT License - 詳細は [LICENSE](LICENSE) を確認してください。
同梱されるサードパーティライセンスについては [NOTICE](NOTICE) を参照してください。
