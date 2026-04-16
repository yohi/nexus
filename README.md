# Nexus ⚡️

**AI エージェントのための、ローカル MCP ベース・コードインデックス基盤**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![MCP Protocol](https://img.shields.io/badge/MCP-Supported-green.svg)](https://modelcontextprotocol.io/)

Nexus は、AI エージェントが巨大なコードベースを効率的に理解し、正確なコンテキストを取得するための MCP (Model Context Protocol) サーバーです。
Semantic search、Exact grep search、File context 取得を 1 つのローカルインデックスに集約し、高速かつ一貫性のある検索体験を提供します。

## 🚀 特徴

- **ハイブリッド検索**: LanceDB によるベクトル検索と ripgrep による高速な文字列検索を統合。
- **インテリジェント・チャンキング**: AST 解析に基づき、関数のセマンティクスを維持したままコードを分割。
- **低レイテンシ**: ローカル実行に特化し、ネットワーク遅延のない高速なレスポンスを実現。
- **ストリーミング対応**: 巨大な検索結果も Streamable HTTP transport により効率的に処理。
- **自律的メンテナンス**: ファイル監視 (Watcher) とデッドレターキュー (DLQ) による自動的なインデックス更新とリカバリ。

## 🛠 セットアップ

### FOR HUMANS (推奨)

> [!TIP]
> 人間は環境構築や設定を打ち間違えることがあるため、AIエージェントに丸投げすることを強く推奨します。
> **Gemini CLI**, **Claude Code**, **Cursor** などの AI エージェントを使用している場合は、以下のプロンプトをコピーして貼り付けてください。
>
```text
Install and configure Nexus. First, read the local README.md and AGENTS.md in this repository. You MUST use your interaction tool (e.g., ask_user, input) to let me choose the installation method BEFORE executing any other commands.
```
<details>
<summary><h3>FOR AGENTS (AIエージェント向け手順)</h3></summary>

あなたがターミナル操作可能なAIエージェントであるなら、**まず [AGENTS.md](AGENTS.md) を読み込み、そこに記載された「MANDATORY PROTOCOL」に即座に従ってください。** 

**重要要件**:
- **ステップ0**: 独断で進めず、必ずお手持ちの**ユーザー対話ツール（`ask_user`, `input`, `confirm` 等）**を使用して、ユーザーに以下のいずれのインストール方式を希望するか確認してください。
- **PATの扱い**: 「ソースからビルド」を選択した場合、GitHub PAT (Personal Access Token) は**不要**です。`bootstrap` スクリプトが自動的に認証問題を回避するように設計されています。
- **秘匿情報の保護**: チャット内でユーザーにトークンの直接入力を求めることは禁止されています。

選択された方式に従って、[AGENTS.md](AGENTS.md) に集約されている詳細な手順を自律的に遂行してください。

より詳細な運用方法については [AGENTS.md](AGENTS.md) を参照してください。

#### 💡 運用ガイドライン (Playbook)

- **インデックス状態の確認**: 最初に `index_status` を実行してください。`isIndexing: true` の間も検索は可能ですが、結果が不完全な場合があります。
- **検索の使い分け**: 曖昧な質問や機能の探索には `hybrid_search`、特定のシンボルや定数の検索には `grep_search` を推奨します。
- **コンテキスト取得**: `get_context` で広範囲を指定しすぎるとコンテキストを圧迫します。必要な行範囲を絞り込んで取得してください。
- **インデックスの鮮度**: 大規模なファイル変更やブランチ切り替え後は、`reindex` を呼び出してインデックスを明示的に更新することを検討してください。

設定が必要な場合は、プロジェクトルートに `.nexus.json` を作成してください。

#### 🛠 MCP 設定例 (Claude Desktop / Gemini CLI)

各エージェントの設定ファイル（例: `claude_desktop_config.json`）の `mcpServers` セクションに以下を追加してください。

```json
{
  "mcpServers": {
    "nexus": {
      "command": "node",
      "args": ["/path/to/nexus/dist/bin/nexus.js"],
      "env": {
        "NEXUS_STORAGE_ROOT_DIR": "/path/to/your/project/.nexus"
      }
    }
  }
}
```

</details>

## 📖 使い方

### ダッシュボード (TUI) の起動

Nexus サーバーが起動している状態で、以下のコマンドを実行すると、ターミナル上でリアルタイムなインデックス状態やキューの監視が可能なダッシュボードが開きます。

```bash
# グローバルインストールされている場合
nexus dashboard

# リポジトリ内から実行する場合
npx tsx src/bin/nexus.ts dashboard
```

### ライブラリとして組み込む

Nexus は Node.js プロセスに組み込んで、独自の MCP サーバーとして公開できます。

```ts
import { createServer } from 'node:http';
import { createNexusServer } from '@yohi/nexus';
import { createStreamableHttpHandler } from '@yohi/nexus/transport';

const handler = createStreamableHttpHandler({
  createServer: () => createNexusServer({
    /* config */
  }),
});

const server = createServer((req, res) => void handler(req, res));
server.listen(3000, '127.0.0.1');
```

## ⚙️ 設定

プロジェクトルートの `.nexus.json` で挙動をカスタマイズできます。詳細は [docs/configuration.md](docs/configuration.md) を参照してください。

| 環境変数 / キー | デフォルト値 | 説明 |
| :--- | :--- | :--- |
| `NEXUS_STORAGE_ROOT_DIR` | `<projectRoot>/.nexus` | インデックスデータの保存先 |
| `embedding.provider` | `ollama` | 使用する Embedding プロバイダー (`ollama`, `openai-compat`) |
| `embedding.model` | `nomic-embed-text` | Embedding モデル名 |

## 🧰 MCP ツール一覧

詳細は [docs/mcp-tools.md](docs/mcp-tools.md) を参照してください。

| ツール名 | 説明 |
| :--- | :--- |
| `hybrid_search` | セマンティックと grep を組み合わせた強力な検索 |
| `semantic_search` | ベクトル検索による意味的なコード探索 |
| `grep_search` | ripgrep を用いた正確な文字列検索 |
| `get_context` | ファイルの指定範囲のコードをコンテキストとして取得 |
| `index_status` | 現在のインデックス進捗や統計情報の確認 |
| `reindex` | インデックスの手動再作成 |

## 🏗 アーキテクチャ

アーキテクチャの詳細な設計仕様、各コンポーネントの役割、およびセキュリティ機構については、[SPEC.md](SPEC.md) を参照してください。

```mermaid
graph TD
    Client[AI Agent / Client] -->|MCP| Server[Nexus MCP Server]
    Server --> Search[Search Orchestrator]
    Search --> Vector[LanceDB Vector Store]
    Search --> Grep[Ripgrep Engine]
    Watcher[File Watcher] --> Pipeline[Indexing Pipeline]
    Pipeline --> Chunker[AST Chunker]
    Chunker --> Embed[Embedding Provider]
    Embed --> Vector
```

## ⚠️ ライセンス

MIT License - 詳細は [LICENSE](LICENSE) ファイルを確認してください。
同梱されるサードパーティライセンスについては [NOTICE](NOTICE) を参照してください。
