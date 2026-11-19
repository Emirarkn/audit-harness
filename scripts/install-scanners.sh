#!/usr/bin/env bash
# One-time scanner install for Linux (GitHub Actions ubuntu runners). Windows: install-scanners.ps1.
# Pinned versions; release binaries are verified against the publisher's checksum file.
set -euo pipefail

GITLEAKS_VERSION=8.30.1
OSV_VERSION=2.6.0
SEMGREP_VERSION=1.180.0
BIN="${HOME}/.local/bin"
mkdir -p "$BIN"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "== gitleaks ${GITLEAKS_VERSION} =="
base="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}"
tarball="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
curl -fsSL -o "$tmp/$tarball" "$base/$tarball"
curl -fsSL -o "$tmp/gitleaks_checksums.txt" "$base/gitleaks_${GITLEAKS_VERSION}_checksums.txt"
(cd "$tmp" && grep " ${tarball}\$" gitleaks_checksums.txt | sha256sum -c -)
tar -xzf "$tmp/$tarball" -C "$tmp" gitleaks
install -m 0755 "$tmp/gitleaks" "$BIN/gitleaks"

echo "== osv-scanner ${OSV_VERSION} =="
base="https://github.com/google/osv-scanner/releases/download/v${OSV_VERSION}"
curl -fsSL -o "$tmp/osv-scanner_linux_amd64" "$base/osv-scanner_linux_amd64"
curl -fsSL -o "$tmp/osv_SHA256SUMS" "$base/osv-scanner_SHA256SUMS"
(cd "$tmp" && grep " osv-scanner_linux_amd64\$" osv_SHA256SUMS | sha256sum -c -)
install -m 0755 "$tmp/osv-scanner_linux_amd64" "$BIN/osv-scanner"

echo "== semgrep, pip-audit, bandit (pip) =="
python3 -m pip install --user --quiet --disable-pip-version-check "semgrep==${SEMGREP_VERSION}" pip-audit bandit

if [ -n "${GITHUB_PATH:-}" ]; then echo "$BIN" >> "$GITHUB_PATH"; fi
export PATH="$BIN:$PATH"

echo "== result =="
for t in gitleaks osv-scanner semgrep pip-audit bandit npm; do
  if command -v "$t" >/dev/null 2>&1; then printf '  %-12s OK\n' "$t"; else printf '  %-12s MISSING\n' "$t"; fi
done
