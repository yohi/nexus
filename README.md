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
- **アプリケーション層 Observability**: MCP ツール利用状況、検索ヒット数、取得コンテキスト行数、Embedding API レイテンシを Prometheus メトリクスとして公開。
- **Telemetry Aggregator**: `nexus dashboard` が複数 Nexus プロセスのメトリクスを自動登録・集約し、Grafana から `localhost:9470/metrics` をスクレイプできます。
- **プロセス間排他制御・CPU負荷抑制**: `proper-lockfile` によるファイルベースのロックで同一プロジェクトへの複数プロセス同時起動や Ollama の CPU 奪い合いを防止。さらに、Ollama への埋め込みリクエスト単位でスレッド数を制限（デフォルト 2、範囲 1〜16）し、ホストマシンのレスポンシブネスを維持します。

## 🛠 セットアップ

### FOR HUMANS (推奨)

> [!TIP]
> 人間は環境構築や設定を打ち間違えることがあるため、AIエージェントに丸投げすることを強く推奨します。
> **Gemini CLI**, **Claude Code**, **Cursor** などの AI エージェントを使用している場合は、以下のプロンプトをコピーして貼り付けてください。
>
```text
Install and configure Nexus. First, read the local README.md and AGENTS.md in this repository. You MUST use your interaction tool (e.g., ask_user, input) to let me choose the installation method BEFORE executing any other commands.
```

#### 📝 エージェントの恒久的な設定（グローバル AGENTS.md への追記推奨）

AI エージェントが常にこの Nexus MCP を正しく、かつコンテキストを節約して使いこなせるようにするため、あなたのグローバルなエージェント指示書（例: `.github/copilot-instructions.md`、`.cursorrules`、グローバルの `AGENTS.md` など）に以下のガイドラインを追記することを強く推奨します。

````markdown
## Nexus MCP Server Usage Guidelines

When using **Nexus MCP** tools for codebase exploration and semantic search, adhere to these instructions for optimal performance and token budget.

### 1. WHAT & WHY (Project Overview)
- **Purpose**: Nexus is a local-first code indexing and search platform for AI agents, providing hybrid semantic search, ripgrep, and AST-based context parsing.

### 2. Tool Usage Rules (Playbook)
- **Index Status**: Run `index_status` before searching. If `pipelineProgress.status === 'running'`, search results may be incomplete.
- **Search Strategy**:
  - Use `hybrid_search` for semantic queries, vague feature exploration, or architectural questions (combines vector & ripgrep via RRF).
  - Use `grep_search` to pinpoint exact symbols, class/function names, or error strings.
- **Context Budgeting**:
  - When calling `get_context`, **DO NOT** read the entire file. Always specify `startLine` and `endLine` parameters to retrieve the minimal relevant snippet to conserve context tokens.
  - If you switch branches or make massive code changes, manually call `reindex` to refresh the local LanceDB store.

### 3. Project-Specific Context
- **Local Documentation**: In repositories where Nexus is active, refer to the project-local `SPEC.md` for architecture details and `AGENTS.md` for specific development constraints, if they exist.
````

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

- **インデックス状態の確認**: 作業開始前に必ず `index_status` を呼び出し、インデックス構築が完了しているか（`pipelineProgress.status === 'idle'`）を確認してください。
- **検索の使い分け**:
  - **曖昧な探索・関連箇所の特定**: `hybrid_search` を最優先で使用してください。セマンティック検索と ripgrep が融合され、最適な結果が得られます。
  - **特定のシンボルやコード断片の検索**: `grep_search` を使用してください。特定のクラス名、関数定義、エラーメッセージなどをピンポイントで検出できます。
- **コンテキスト取得**: `get_context` でファイル全体を読み込むとLLMのコンテキストウィンドウを圧迫します。極力、必要な行範囲（`startLine` 〜 `endLine`）を絞り込んで部分的に取得してください。
- **インデックスの鮮度**: 大規模なファイル変更や `git checkout` によるブランチ切り替えの後は、`reindex` を呼び出してインデックスを手動で更新することを強く推奨します。

設定が必要な場合は、プロジェクトルートに `.nexus.json` を作成してください。

#### 🛠 MCP 設定例 (Claude Desktop / Gemini CLI)

各エージェントの設定ファイル（例: `claude_desktop_config.json`）の `mcpServers` セクションに以下を追加してください。

```json
{
  "mcpServers": {
    "nexus": {
      "command": "nexus",
      "args": [],
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

# ポート番号(指定時はそのポートを使用、未指定時は自動検出)や更新間隔(デフォルト: 2000ms, 最小: 1000ms)を指定する場合
nexus dashboard --port 9470 --interval 3000

# Aggregator の待受ポートを指定する場合（Prometheus/Grafana の scrape target）
nexus dashboard --aggregator-port 9470

# リポジトリ内から実行する場合
npx tsx src/bin/nexus.ts dashboard
```

> [!TIP]
> サーバー側で `NEXUS_METRICS_PORT` を指定して起動している場合は、ダッシュボード起動時にも `--port` で同じポート番号を指定してください。Aggregator は `nexus dashboard` 内で自動起動し、既に同じポートで起動済みの場合は TUI クライアントとして継続します。

### Prometheus / Grafana 連携

`nexus dashboard` は Telemetry Aggregator も起動します。各 Nexus サーバープロセスは自身のメトリクス HTTP サーバーを起動後、Aggregator に起動時および 30 秒間隔で登録します。Aggregator は登録済みノードの `/metrics/json` を並列取得し、`project` / `pid` ラベルで分離された Prometheus テキストへ再構築します。

Prometheus には以下の scrape target を設定してください。Grafana ダッシュボード JSON と詳細手順は [docs/observability/README.md](docs/observability/README.md) を参照してください。

```yaml
scrape_configs:
  - job_name: 'nexus'
    scrape_interval: 10s
    static_configs:
      - targets: ['localhost:9470']
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

### デフォルトの除外設定 (Watcher Ignore)

以下のディレクトリおよびファイルは、パフォーマンスとインデックスの正確性を維持するため、デフォルトで監視・インデックス対象から除外されます。

- **依存・ビルド**: `node_modules`, `dist`, `build`, `out`
- **内部データ**: `.git`, `.nexus`
- **テスト・キャッシュ**: `coverage`, `.cache`, `.parcel-cache`
- **仮想環境**: `venv`, `.venv`, `env`
- **エディタ・OS設定**: `.idea`, `.vscode`, `.DS_Store`

### 設定のカスタマイズ

除外対象を追加または変更するには、以下の方法があります。

1.  **`.nexus.json`**: プロジェクトルートに作成し、`watcher.ignorePaths` を指定します。
    > **注意**: `ignorePaths` を指定すると、デフォルトのリストは完全に置き換えられます。既存のデフォルトを維持したい場合は、デフォルトのパス（`node_modules`, `.git` など）も一緒に列挙してください。
    ```json
    {
      "watcher": {
        "ignorePaths": ["node_modules", ".git", "custom_tmp"]
      }
    }
    ```
2.  **環境変数**: `NEXUS_WATCHER_IGNORE_PATHS` にカンマ区切りで指定します。
    > **注意**: 環境変数を指定した場合も、デフォルトのリストは上書きされます（マージされません）。
    ```bash
    export NEXUS_WATCHER_IGNORE_PATHS="node_modules,.git,tmp"
    ```

### 主要な設定項目

| 環境変数 / キー | デフォルト値 | 説明 |
| :--- | :--- | :--- |
| `NEXUS_STORAGE_ROOT_DIR` | `<projectRoot>/.nexus` | インデックスデータの保存先 |
| `NEXUS_WATCHER_IGNORE_PATHS` | (上記デフォルトリスト) | 除外するパスのリスト。**この設定はデフォルトを上書きします。** |
| `NEXUS_PROJECT_NAME` / `projectName` | `<projectRoot>` のベース名 | Prometheus の `project` ラベルに使用するプロジェクト名 |
| `NEXUS_METRICS_PORT` / `metricsPort` | 自動割当 | Nexus プロセス自身の `/metrics`, `/metrics/json`, `/health` 待受ポート |
| `NEXUS_AGGREGATOR_PORT` / `aggregatorPort` | `9470` | Dashboard Aggregator の待受ポート |
| `embedding.provider` | `ollama` | 使用する Embedding プロバイダー (`ollama`, `openai-compat`) |
| `embedding.model` | `nomic-embed-text` | Embedding モデル名 |
| `NEXUS_OLLAMA_NUM_THREAD` / `embedding.ollamaNumThread` | `2` | Ollama 埋め込みリクエストのスレッド数 (`1`〜`16`)。無効な値は `2` にフォールバック。 |

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
