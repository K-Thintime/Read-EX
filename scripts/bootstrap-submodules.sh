#!/usr/bin/env bash
# Read-EX: populate the upstream readest submodules.
#
# readest records 8 submodules in .gitmodules, and the build needs most of them:
#   - packages/tauri, packages/swift-rs   -> [patch.crates-io] path deps in Cargo.toml
#   - src-tauri/plugins/*                 -> Cargo path deps in src-tauri/Cargo.toml
#   - packages/foliate-js                 -> pnpm workspace member
#   - packages/{qcms,js-mdict,simplecc-wasm} -> optional features (dictionary, colour mgmt)
#
# A zip download or a plain `git clone` leaves those directories empty, and both
# `pnpm install` and `cargo build` then fail with confusing errors. This script
# restores them from the URLs already declared in .gitmodules, so CI and fresh
# clones behave the same without depending on gitlinks being recorded.
#
# Idempotent: directories that already contain files are left untouched.
# Usage: bash scripts/bootstrap-submodules.sh [--optional-only]
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if [[ ! -f .gitmodules ]]; then
  echo "bootstrap: no .gitmodules, nothing to do"
  exit 0
fi

retries="${BOOTSTRAP_RETRIES:-3}"
failed=()

# `git config --get-regexp` prints "<key> <value>"; real .gitmodules files do not
# put spaces in submodule paths, so a two-field split is safe here.
while read -r key path; do
  # Windows runners check out with CRLF; a trailing \r would corrupt every path.
  key="${key%$'\r'}"
  path="${path%$'\r'}"
  [[ -n "${path:-}" ]] || continue
  url="$(git config -f .gitmodules --get "${key%.path}.url")"
  url="${url%$'\r'}"
  [[ -n "$url" ]] || continue

  name="$(basename "$path")"

  # Ready if the directory has any entry other than an empty .git dir.
  if [[ -d "$path" ]] && [[ -n "$(ls -A "$path" 2>/dev/null | grep -v '^\.git$' || true)" ]]; then
    echo "bootstrap: $name already present, skipping"
    continue
  fi

  mkdir -p "$(dirname "$path")"
  echo "bootstrap: cloning $name <- $url"
  ok=0
  for attempt in $(seq 1 "$retries"); do
    # A leftover empty dir makes `git clone <url> <dir>` refuse the target, so
    # clear it first; nothing of value can be inside (checked above).
    rm -rf "$path"
    if git clone --depth 1 --single-branch "$url" "$path" 2>&1 | sed 's/^/    /'; then
      ok=1
      break
    fi
    echo "bootstrap: attempt $attempt/$retries failed for $name, retrying..."
    sleep $((attempt * 3))
  done

  if [[ "$ok" -ne 1 ]]; then
    failed+=("$name")
  fi
done < <(git config -f .gitmodules --get-regexp '\.path$')

echo
echo "bootstrap: verifying build-critical paths"
critical=(
  "packages/tauri/crates/tauri/Cargo.toml"
  "packages/swift-rs/Cargo.toml"
  "packages/foliate-js/package.json"
  "apps/readest-app/src-tauri/plugins/tauri-plugin-turso/Cargo.toml"
  "apps/readest-app/src-tauri/plugins/tauri-plugin-webview-upgrade/Cargo.toml"
)
missing=()
for f in "${critical[@]}"; do
  if [[ -e "$f" ]]; then
    echo "  ok      $f"
  else
    echo "  MISSING $f"
    missing+=("$f")
  fi
done

if [[ ${#failed[@]} -gt 0 ]]; then
  echo
  echo "bootstrap: FAILED to clone: ${failed[*]}" >&2
  exit 1
fi

if [[ ${#missing[@]} -gt 0 ]]; then
  echo
  echo "bootstrap: build-critical paths missing: ${missing[*]}" >&2
  exit 1
fi

echo
echo "bootstrap: all submodules ready"
