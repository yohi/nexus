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
3. 各 Bitbucket repo の Settings > Access keys に GitHub Actions 用 SSH 公開鍵を登録する。 write access を有効化すること。
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
