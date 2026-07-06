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
3. Bitbucket で API token を発行する（Personal settings > API tokens、`repository:write` スコープ）。
4. 発行した API token を各 GitHub source repo の Settings > Secrets and variables > Actions に `BITBUCKET_API_TOKEN` として保存する。

## 利用者向け手順（Claude Code 上）

```text
/plugin marketplace add git@bitbucket.org:acme-corp/claude-plugins-marketplace.git
/plugin install plugin-a@company-internal-plugins
/reload-plugins
```

## 注意

- 配布 repo は force-push により常に 1 commit のみ保持される。
- plugin workflow は release tag 単位で実行され、Bitbucket 側の最新 tag と一致する場合はスキップされる。
- デプロイは `https://x-token-auth:<TOKEN>@bitbucket.org/...` の HTTPS 形式で Bitbucket に push する。API token は `repository:write` の最小スコープで発行し、定期的にローテーションすること（漏洩時は Personal settings > API tokens から即時失効可能）。
- marketplace workflow は、同じ organization 内の public な plugin source repo を想定している。plugin source repo が private な場合、各 GitHub source repo の Secrets に `GH_PAT`（repo スコープ付き PAT）を設定し、marketplace workflow 側で `GH_PAT` を使用する必要がある。未設定の場合はデフォルトの `GITHUB_TOKEN` が使用される。
