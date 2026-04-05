# 🌌 Nexus

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![MCP Protocol](https://img.shields.io/badge/MCP-Supported-green.svg)]()

**One local index. Infinite agent possibilities.**

Nexusは、あなたのローカルマシン上で稼働する「AIエージェントのための共通コードベース基盤」です。
各エージェントごとに重いインデックス処理を走らせる必要はもうありません。Nexusを立ち上げるだけで、あらゆるツールが最速・最新のコードコンテキストにアクセスできるようになります。

## 🚀 活用シナリオ

- **CLIからの横断的アクセス**: ClaudeCodeやOpenCode、GeminiCLIなど、気分やタスクに合わせて使い分けるエージェントすべてに同じ検索能力を提供します。
- **エディタとの統合**: Cursorでのコーディング中や、NeoVimからMCP経由でコンテキストを引き出す際の中核エンジンとして機能します。
- **エンタープライズ級の安全性**: 外部APIへのコード送信ゼロ。設計からインフラまで、すべてのデータは `<projectRoot>/.nexus/` に安全に留まります。

## ⚙️ アーキテクチャのハイライト

- **LanceDB + ripgrep**: ベクトル検索とAST解析、そして最速のGrepを組み合わせた強力なハイブリッド検索エンジン。
- **Always-on Watcher**: ファイル変更を絶対に逃さない、堅牢なバックプレッシャー機構を備えたイベント駆動パイプライン。
