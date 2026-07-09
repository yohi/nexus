# Bitbucket 社内 Claude Code plugin marketplace PoC

本ディレクトリは [Bitbucket 上の社内 Claude Code plugin marketplace 構築設計](../../docs/superpowers/specs/2026-07-03-bitbucket-claude-plugins-marketplace.md) の PoC テンプレートである。

## 構成

- `claude-plugins-marketplace-src/`: marketplace source repo 用テンプレート
- `plugin-a-src/`: plugin source repo 用テンプレート（コピーして `plugin-b-src` などを作成可能）

## TOKEN 対照表

| 環境変数名 / Secret 名 | 用途 | 発行元 | 保存先 | 備考 |
| --- | --- | --- | --- | --- |
| `BITBUCKET_API_TOKEN` | plugin 配布 repo への force-push | Bitbucket Repository Access Token（`repository:write`） | 各 plugin source repo の GitHub Actions Secrets | 配布 repo ごとに発行可能 |
| `BITBUCKET_MARKETPLACE_TOKEN` | marketplace catalog `marketplace.json` 更新 | Bitbucket PAT（カタログ repo 読み書き） | marketplace source repo の GitHub Actions Secrets | API トークンと marketplace 用は分離推奨 |
| `GH_PAT` | GitHub 上の private plugin source repo 読み込み | GitHub PAT（`repo` スコープ） | marketplace source repo の GitHub Actions Secrets | plugin source が public なら不要 |

## セットアップ

1. 本テンプレートを GitHub 上の実際の organization にコピーする。
   - `acme-corp` を実際の organization 名に置換する。
2. Bitbucket Cloud 上に配布用 private repo を作成する。
   - `acme-corp/claude-plugins-marketplace.git`
   - `acme-corp/plugin-a-dist.git`
3. Bitbucket で Repository Access Token を発行する（Repository settings > Security > Access tokens、`repository:write` スコープ）。
4. 発行したトークンを各 GitHub source repo の Settings > Secrets and variables > Actions に `BITBUCKET_API_TOKEN` として保存する。

## 利用者向け手順（Claude Code 上）

```text
/plugin marketplace add git@bitbucket.org:acme-corp/claude-plugins-marketplace.git
/plugin install plugin-a@company-internal-plugins
/reload-plugins
```

## 注意

- 配布 repo は force-push により常に 1 commit のみ保持される。
- plugin workflow は release tag 単位で実行され、Bitbucket 側の最新 tag と一致する場合はスキップされる。
- デプロイは `GIT_ASKPASS` 経由の HTTPS（ユーザー名 `x-token-auth`）で Bitbucket に push し、トークンをリモート URL やコマンド引数には含めない。Repository Access Token は `repository:write` の最小スコープで発行し、定期的にローテーションすること（漏洩時は Repository settings > Security > Access tokens から即時失効可能）。
- marketplace workflow は、同じ organization 内の public な plugin source repo を想定している。plugin source repo が private な場合、marketplace source repo（marketplace workflow を実行するリポジトリ）の Secrets に `GH_PAT`（対象の private plugin source repo を読める repo スコープ付き PAT）を設定する必要がある。`GH_PAT` 未設定の場合はデフォルトの `GITHUB_TOKEN` がフォールバックとして使用されるが、既定トークンは実行リポジトリ内に限定されるため private な他リポジトリは読めず、public plugin source のみで機能する。
