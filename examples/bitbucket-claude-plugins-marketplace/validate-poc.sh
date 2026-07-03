#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"

json_files=(
  "${BASE_DIR}/claude-plugins-marketplace-src/.claude-plugin/marketplace.json"
  "${BASE_DIR}/claude-plugins-marketplace-src/plugin-sources.json"
  "${BASE_DIR}/plugin-a-src/.claude-plugin/plugin.json"
  "${BASE_DIR}/plugin-a-src/package.json"
  "${BASE_DIR}/plugin-a-src/tsconfig.json"
)

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found; cannot validate JSON files." >&2
  exit 1
fi

for f in "${json_files[@]}"; do
  echo "Validating JSON: ${f}"
  python3 -m json.tool "$f" >/dev/null
done

echo "Validating shell script: ${BASE_DIR}/plugin-a-src/scripts/setup-plugin.sh"
bash -n "${BASE_DIR}/plugin-a-src/scripts/setup-plugin.sh"

workflow_files=(
  "${BASE_DIR}/claude-plugins-marketplace-src/.github/workflows/deploy-to-bitbucket.yml"
  "${BASE_DIR}/plugin-a-src/.github/workflows/deploy-to-bitbucket.yml"
)

if command -v actionlint >/dev/null 2>&1; then
  for f in "${workflow_files[@]}"; do
    echo "Linting GitHub Actions workflow: ${f}"
    actionlint "$f"
  done
else
  echo "actionlint not found; skipping workflow lint. Install with: go install github.com/rhysd/actionlint/cmd/actionlint@latest"
fi

echo "All PoC validations passed."
