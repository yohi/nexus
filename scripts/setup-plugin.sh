#!/bin/bash
set -e

# Move to the plugin root directory
cd "$(dirname "$0")/.."

# 1. Install dependencies if the TypeScript compiler is missing
if [[ ! -x "node_modules/.bin/tsc" ]]; then
  echo "[Nexus Plugin] Installing dependencies..."
  if [[ -f "scripts/bootstrap.mjs" ]] && [[ ! -f "dist/bin/nexus.js" ]]; then
    node scripts/bootstrap.mjs
  else
    npm install --no-audit --no-fund
  fi
fi

# 2. Build if dist/bin/nexus.js is missing
if [[ ! -f "dist/bin/nexus.js" ]]; then
  echo "[Nexus Plugin] Building project..."
  npm run build
fi
