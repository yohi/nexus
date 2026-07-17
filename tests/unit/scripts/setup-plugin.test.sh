#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/bin"
cat >"$TMP_DIR/bin/npm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$NPM_LOG"
EOF
chmod +x "$TMP_DIR/bin/npm"

failures=0

run_case() {
  local case_name="$1"
  local tsc_mode="$2"
  local case_dir="$TMP_DIR/$case_name"

  mkdir -p "$case_dir/scripts" "$case_dir/node_modules" "$case_dir/dist/bin"
  cp "$PROJECT_ROOT/scripts/setup-plugin.sh" "$case_dir/scripts/setup-plugin.sh"
  touch "$case_dir/dist/bin/nexus.js"
  : >"$case_dir/npm.log"

  if [[ "$tsc_mode" != "missing" ]]; then
    mkdir -p "$case_dir/node_modules/.bin"
    touch "$case_dir/node_modules/.bin/tsc"
    if [[ "$tsc_mode" == "executable" ]]; then
      chmod +x "$case_dir/node_modules/.bin/tsc"
    fi
  fi

  NPM_LOG="$case_dir/npm.log" PATH="$TMP_DIR/bin:$PATH" \
    bash "$case_dir/scripts/setup-plugin.sh"
}

assert_install_triggered() {
  local case_name="$1"

  if ! grep -Fxq "install --no-audit --no-fund" "$TMP_DIR/$case_name/npm.log"; then
    echo "Expected npm install for case: $case_name" >&2
    failures=$((failures + 1))
  fi
}

run_case "missing-tsc" "missing"
assert_install_triggered "missing-tsc"

run_case "non-executable-tsc" "non-executable"
assert_install_triggered "non-executable-tsc"

run_case "executable-tsc" "executable"
if [[ -s "$TMP_DIR/executable-tsc/npm.log" ]]; then
  echo "Expected npm install to be skipped when tsc is executable" >&2
  failures=$((failures + 1))
fi

if ((failures > 0)); then
  exit 1
fi
