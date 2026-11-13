#!/bin/bash
# Builds edge-agent from this folder into dist/. Needs Go 1.24 or newer, from go.dev/dl.
#   ./build.sh            for this computer: dist/edge-agent
#   ./build.sh all 0.1.0  for Mac (Apple Silicon, Intel), Windows and Linux, with checksums
set -euo pipefail
cd "$(dirname "$0")"
V="${2:-dev}"
rm -rf dist && mkdir -p dist
if [[ "${1:-}" != "all" ]]; then
  CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$V" -o dist/edge-agent ./cmd/edge-agent
  ls -l dist
  exit 0
fi
for t in darwin/arm64 darwin/amd64 windows/amd64 linux/amd64 linux/arm64; do
  os=${t%/*}; arch=${t#*/}; ext=""; [[ $os == windows ]] && ext=".exe"
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "-s -w -X main.version=$V" -o "dist/edge-agent-$V-$os-$arch$ext" ./cmd/edge-agent
done
(cd dist && (shasum -a 256 edge-agent-* 2>/dev/null || sha256sum edge-agent-*) > SHA256SUMS)
ls -l dist
