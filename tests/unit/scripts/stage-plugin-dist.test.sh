#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
STAGING_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGING_DIR"' EXIT

bash "$PROJECT_ROOT/scripts/stage-plugin-dist.sh" "$STAGING_DIR"

test -f "$STAGING_DIR/.claude-plugin/plugin.json"
test -f "$STAGING_DIR/scripts/setup-plugin.sh"
test -f "$STAGING_DIR/src/index.ts"
test -f "$STAGING_DIR/skills/code-search/SKILL.md"
cmp "$PROJECT_ROOT/.agents/skills/code-search.md" \
  "$STAGING_DIR/skills/code-search/SKILL.md"
