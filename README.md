# Nexus

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![MCP Protocol](https://img.shields.io/badge/MCP-Supported-green.svg)](https://modelcontextprotocol.io/)

Nexus は、AI エージェント向けのローカル MCP ベースコードインデックス基盤です。
semantic search、grep search、file context 取得を 1 つのローカルインデックスに集約し、複数のクライアントから共有できます。

## 提供機能

- インデックス済みコードチャンクに対する semantic search
- ripgrep ベースの exact search
- semantic と grep を統合した hybrid ranking
- 行範囲を指定できる file context 取得
- MCP 経由の index status / manual reindex
- 複数クライアントを扱える Streamable HTTP transport

## 現在のスコープ

現時点のこのリポジトリは、サーバーとストレージの構成要素を提供しています。
単体 CLI エントリポイントはまだ同梱していないため、主な利用形態は Node.js プロセスへ組み込み、MCP Streamable HTTP として公開する形です。

## 対応言語

- TypeScript
- Python
- Go

## Embedding Provider

- `ollama`
- `openai-compat`
- `test`

## クイックスタート

1. 依存関係をインストールします。

```bash
npm install
```

2. ビルドします。

```bash
npm run build
```

3. 必要に応じてプロジェクトローカル設定ファイルを作成します。

```json
{
  "embedding": {
    "provider": "ollama",
    "model": "nomic-embed-text"
  }
}
```

4. ローカルプロセスへサーバーを組み込みます。

```ts
import { createServer } from 'node:http';

import { createNexusServer } from './src/server/index.js';
import { createStreamableHttpHandler } from './src/server/transport.js';

const handler = createStreamableHttpHandler({
  createServer: () =>
    createNexusServer({
      projectRoot,
      sanitizer,
      semanticSearch,
      grepEngine,
      orchestrator,
      vectorStore,
      metadataStore,
      pipeline,
      pluginRegistry,
      runReindex,
      loadFileContent,
    }),
});

const server = createServer((req, res) => {
  void handler(req, res);
});

server.listen(3000, '127.0.0.1');
```

周辺の HTTP ルーター構成に応じて、MCP endpoint は `http://127.0.0.1:3000/mcp` のようなパスで公開できます。

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
