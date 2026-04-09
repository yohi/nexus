# Nexus

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![MCP Protocol](https://img.shields.io/badge/MCP-Supported-green.svg)](https://modelcontextprotocol.io/)

Nexus は、AI エージェント向けのローカル MCP ベースコードインデックス基盤です。
semantic search、grep search、file context 取得を 1 つのローカルインデックスに集約し、複数のクライアントから共有できます。

## 🤖 AI-Powered One-Click Setup

If you are using an AI agent like **Gemini CLI**, **Claude Engineer**, or **Cursor**, simply copy and paste the prompt below. The agent will handle the entire installation, build, and verification process for you:

> **Install and configure Nexus in this directory. First, read `AGENTS.md` for the setup protocol, then execute the bootstrap script, and verify the installation with `npm test`.**

## インストール

GitHub Packages からパッケージをインストールします。

```bash
npm install @yohi/nexus
```

※ インストールには `.npmrc` で `@yohi` スコープを `https://npm.pkg.github.com` に向ける設定が必要です。

## 提供機能

- インデックス済みコードチャンクに対する semantic search
- ripgrep ベースの exact search
- semantic と grep を統合した hybrid ranking
- 行範囲を指定できる file context 取得
- MCP 経由の index status / manual reindex
- 複数クライアントを扱える Streamable HTTP transport

## ライブラリとしての利用

Nexus はライブラリとして提供されており、Node.js プロセスへ組み込んで MCP サーバーとして公開できます。

```ts
import { createServer } from 'node:http';
import { createNexusServer } from '@yohi/nexus';
import { createStreamableHttpHandler } from '@yohi/nexus/transport';

const handler = createStreamableHttpHandler({
  createServer: () =>
    createNexusServer({
      // ... configuration
    }),
});

const server = createServer((req, res) => {
  void handler(req, res);
});

server.listen(3000, '127.0.0.1');
```

## For Agents

Nexus は、AI エージェントが巨大なコードベースを効率的に理解し、正確なコンテキストを取得するための MCP (Model Context Protocol) サーバーとして機能します。

### セットアップ手順 (Self-Installation)

ターミナル操作が可能なエージェントは、以下の手順を自律的に実行して Nexus をセットアップできます。

1.  **依存関係のインストールとビルド**
    ```bash
    npm install && npm run build
    ```
2.  **設定ファイルの準備**
    必要に応じて、プロジェクトルートに `.nexus.json` を作成して Embedding Provider 等を設定します。
    ```json
    {
      "embedding": {
        "provider": "ollama",
        "model": "nomic-embed-text"
      }
    }
    ```
3.  **動作確認**
    ユニットテストを実行して環境が正しく構築されたか確認します。
    ```bash
    npm test
    ```

### 推奨されるワークフロー

1.  **`index-status`**: 最初にインデックスの状態を確認してください。`isIndexing: true` の場合は、バックグラウンドで処理が進行中です。
2.  **`hybrid-search`**: 曖昧な質問や広範囲な機能の探索には、セマンティック検索と grep 検索を組み合わせたハイブリッド検索を推奨します。
3.  **`grep-search`**: 特定のシンボル、定数、または正確な文字列の一致が必要な場合は、`grep-search` を使用してください。
4.  **`get-context`**: 検索結果から特定されたファイルに対して、必要な行範囲を指定して詳細なコードコンテキストを取得します。

### エージェントへの注意事項

- **インデックスの鮮度**: 大規模なファイル変更（ブランチ切り替えや大量の `replace` 実行後）を行った場合は、`reindex` ツールを呼び出してインデックスを明示的に更新することを検討してください。
- **パスの指定**: すべてのパスはプロジェクトルートからの相対パスとして扱われます。
- **リソース制限**: `get-context` で極端に広い行範囲を指定すると、コンテキストウィンドウを圧迫する可能性があります。必要な範囲を絞り込んで取得してください。

## 設定

設定は project root の `.nexus.json` から読み込まれ、環境変数で上書きできます。

- 設定リファレンス: [docs/configuration.md](docs/configuration.md)
- MCP ツールリファレンス: [docs/mcp-tools.md](docs/mcp-tools.md)

## 開発

```bash
npm run build
npm test
npm run license:check
npm run license:notice
```

`npm run license:notice` は、同梱するサードパーティライセンス情報のためのルート `NOTICE` ファイルを生成します。
