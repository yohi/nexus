#!/usr/bin/env bash
# Updates the Claude Code plugin marketplace catalog
# (.claude-plugin/marketplace.json) on a Bitbucket-hosted marketplace repo,
# retrying on push conflicts.
#
# Shared by:
#   - .github/workflows/deploy-plugin-to-bitbucket.yml (auto, on each deploy)
#   - .github/workflows/update-marketplace-entry.yml (manual backfill / customization)
#
# Repository URLs are constructed as
# https://bitbucket.org/<BITBUCKET_WORKSPACE_NAME>/<repository-name>.git
# rather than accepted as raw URLs, so callers only ever configure a
# workspace + repository name pair (no risk of a malformed/inconsistent URL).
#
# Required env vars:
#   BITBUCKET_MARKETPLACE_TOKEN
#   BITBUCKET_WORKSPACE_NAME
#   BITBUCKET_MARKETPLACE_REPOSITORY_NAME
#   BITBUCKET_PLUGIN_REPOSITORY_NAME
#   PLUGIN_NAME
#   PLUGIN_DESCRIPTION
# Optional env vars:
#   PLUGIN_REF
#   MAX_RETRIES (default: 5)

set -euo pipefail

: "${BITBUCKET_MARKETPLACE_TOKEN:?BITBUCKET_MARKETPLACE_TOKEN is required}"
: "${BITBUCKET_WORKSPACE_NAME:?BITBUCKET_WORKSPACE_NAME is required}"
: "${BITBUCKET_MARKETPLACE_REPOSITORY_NAME:?BITBUCKET_MARKETPLACE_REPOSITORY_NAME is required}"
: "${BITBUCKET_PLUGIN_REPOSITORY_NAME:?BITBUCKET_PLUGIN_REPOSITORY_NAME is required}"
: "${PLUGIN_NAME:?PLUGIN_NAME is required}"
: "${PLUGIN_DESCRIPTION:?PLUGIN_DESCRIPTION is required}"

MARKETPLACE_REPO_URL="https://bitbucket.org/${BITBUCKET_WORKSPACE_NAME}/${BITBUCKET_MARKETPLACE_REPOSITORY_NAME}.git"
export PLUGIN_BITBUCKET_URL="https://bitbucket.org/${BITBUCKET_WORKSPACE_NAME}/${BITBUCKET_PLUGIN_REPOSITORY_NAME}.git"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPDATE_ENTRY_SCRIPT="${SCRIPT_DIR}/marketplace-update-entry.mjs"

ASKPASS_SCRIPT="$(mktemp)"
BASE_TMP="$(mktemp -d)"
trap 'rm -f "$ASKPASS_SCRIPT"; rm -rf "$BASE_TMP"' EXIT
printf '#!/bin/sh\necho "$BITBUCKET_MARKETPLACE_TOKEN"\n' >"$ASKPASS_SCRIPT"
chmod +x "$ASKPASS_SCRIPT"
export GIT_ASKPASS="$ASKPASS_SCRIPT"

REPO_URL="https://x-token-auth@${MARKETPLACE_REPO_URL#https://}"
WORKDIR="${BASE_TMP}/marketplace-repo"
MAX_RETRIES="${MAX_RETRIES:-5}"
if ! [[ "$MAX_RETRIES" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid MAX_RETRIES: '${MAX_RETRIES}' (must be a positive integer)" >&2
  exit 1
fi

for attempt in $(seq 1 "$MAX_RETRIES"); do
  cd "$BASE_TMP"
  rm -rf "$WORKDIR"
  git clone "$REPO_URL" "$WORKDIR"
  cd "$WORKDIR"
  git config user.name "github-actions"
  git config user.email "github-actions@users.noreply.github.com"

  node "$UPDATE_ENTRY_SCRIPT"

  git add .claude-plugin/marketplace.json
  if git diff --cached --quiet; then
    echo "No changes to commit (entry already up to date)."
    exit 0
  fi
  git commit -m "chore: update ${PLUGIN_NAME} marketplace entry"

  if git push origin HEAD; then
    echo "Pushed successfully on attempt ${attempt}."
    exit 0
  fi

  echo "Push rejected (possible concurrent update). Retrying (${attempt}/${MAX_RETRIES})..."
  sleep $((RANDOM % 5 + 1))
done

echo "Failed to push after ${MAX_RETRIES} attempts." >&2
exit 1
