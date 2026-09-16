#!/bin/bash
# Stage the nexus PACKAGED plugin as a build-ready "source mirror" for Bitbucket.
#
# ネイティブ依存(better-sqlite3, @lancedb/lancedb)と tsc(非バンドル)ビルドのため
# dist-only では配れない。利用者マシンで npm install && npm run build する前提で
# ビルド可能な最小ソース一式を配布する。packages/dashboard(ローカルTUI)は同梱する。
#
# パッケージ版差分は plugin.json の stage 時変換のみ:
#   - userConfig を除去
#   - mcpServers.nexus.env を固定値へ置換(NEXUS_PACKAGE_MODE=1 + Bedrock 固定)
#
# Usage: scripts/stage-plugin-dist.sh <staging-dir>
set -euo pipefail

STAGING_DIR="${1:?usage: stage-plugin-dist.sh <staging-dir>}"

REGION="${NEXUS_EMBEDDING_REGION:-us-east-1}"
MODEL="${NEXUS_EMBEDDING_MODEL:-amazon.titan-embed-text-v2:0}"
DIMENSIONS="${NEXUS_EMBEDDING_DIMENSIONS:-1024}"
PROFILE="${NEXUS_EMBEDDING_PROFILE:-}"

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR/.claude-plugin" "$STAGING_DIR/scripts" "$STAGING_DIR/packages/dashboard" "$STAGING_DIR/skills/code-search"

# Package manifests + lockfile, TS build config, root source
cp package.json package-lock.json "$STAGING_DIR/"
cp tsconfig.json tsconfig.build.json "$STAGING_DIR/"
cp -r src "$STAGING_DIR/"

# Dashboard workspace (local TUI は維持)
cp packages/dashboard/package.json "$STAGING_DIR/packages/dashboard/"
cp -r packages/dashboard/src "$STAGING_DIR/packages/dashboard/"

# Runtime setup hook + license files
cp scripts/setup-plugin.sh "$STAGING_DIR/scripts/"
cp LICENSE NOTICE "$STAGING_DIR/"

# Generate the Claude Code plugin Skill from the repository source of truth.
cp .agents/skills/code-search.md "$STAGING_DIR/skills/code-search/SKILL.md"

# Transform plugin.json: strip userConfig, inject fixed env
STAGING_DIR="$STAGING_DIR" REGION="$REGION" MODEL="$MODEL" DIMENSIONS="$DIMENSIONS" PROFILE="$PROFILE" \
  node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const src = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
delete src.userConfig;

// package.json の version(= release-please が管理するリリース版番号)を
// plugin.json に同期する。これを行わないと、Claude Code 側のプラグイン
// キャッシュキー(= plugin.json の version)がリリースを重ねても変化せず、
// 古いキャッシュ(未ビルド/ビルド失敗状態を含む)が再利用され続けてしまう。
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
src.version = pkg.version;

const env = {
  NEXUS_PACKAGE_MODE: '1',
  NEXUS_EMBEDDING_PROVIDER: 'bedrock',
  NEXUS_EMBEDDING_MODEL: process.env.MODEL,
  NEXUS_EMBEDDING_DIMENSIONS: process.env.DIMENSIONS,
  NEXUS_EMBEDDING_REGION: process.env.REGION,
};
if (process.env.PROFILE) env.NEXUS_EMBEDDING_PROFILE = process.env.PROFILE;

src.mcpServers.nexus.env = env;

const out = `${process.env.STAGING_DIR}/.claude-plugin/plugin.json`;
writeFileSync(out, JSON.stringify(src, null, 2) + '\n');
NODE

echo "Staged packaged nexus plugin source mirror into: $STAGING_DIR"
