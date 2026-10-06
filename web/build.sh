#!/usr/bin/env bash
# Build the browser module: web/dingo.wasm + web/wasm_exec.js, and the vendored
# logic-graph editor bundle web/flow-editor/flow-editor.{js,css}.
#
# RUN THIS INSIDE THE DEV CONTAINER (Go 1.22, Node 20.19+, repo at /workspace),
# not on the host, e.g.:
#   podman exec dingo-web bash -lc 'cd /workspace && web/build.sh'
#
#   web/build.sh          both
#   web/build.sh wasm     only the Go/WASM module
#   web/build.sh flow     only the editor bundle
set -euo pipefail

cd "$(dirname "$0")/.."
what="${1:-all}"

build_wasm() {
	build="$(git describe --always --dirty 2>/dev/null || true) $(date -u +%Y-%m-%dT%H:%M:%SZ)"
	build="${build# }"

	GOOS=js GOARCH=wasm go build -trimpath \
		-ldflags="-s -w -X 'main.build=${build}'" \
		-o web/dingo.wasm ./web/wasm

	cp "$(go env GOROOT)/misc/wasm/wasm_exec.js" web/wasm_exec.js

	ls -l web/dingo.wasm web/wasm_exec.js
	echo "build: ${build}"
}

# The editor is Cory Grant's dingoConfig React Flow editor, vendored unmodified
# in web/vendor/dingoconfig-flow (see VENDORED.md there). It is built with its
# own package.json/package-lock.json/vite.config.js; only the output directory
# is given on the command line. The build runs in a copy outside the repo so
# node_modules never lands in the source tree (FLOW_BUILD_DIR, kept between
# runs; `npm ci` runs again whenever the lockfile changes).
build_flow() {
	src="web/vendor/dingoconfig-flow"
	work="${FLOW_BUILD_DIR:-/tmp/dingoconfig-flow-build}"
	out="$(pwd)/web/flow-editor"
	mkdir -p "$work"
	if ! cmp -s "$src/package-lock.json" "$work/package-lock.json" || [ ! -d "$work/node_modules" ]; then
		rm -rf "$work/node_modules"
		cp "$src/package.json" "$src/package-lock.json" "$work/"
		(cd "$work" && npm ci --no-audit --no-fund)
	fi
	rm -rf "$work/src"
	cp -r "$src/src" "$src/vite.config.js" "$work/"
	(cd "$work" && npx vite build --outDir "$out")
	cp "$src/LICENSE" "$out/LICENSE"
	ls -l "$out"
}

case "$what" in
all) build_wasm; build_flow ;;
wasm) build_wasm ;;
flow) build_flow ;;
*) echo "usage: $0 [all|wasm|flow]" >&2; exit 2 ;;
esac
