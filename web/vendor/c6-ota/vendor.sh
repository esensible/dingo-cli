#!/bin/sh
# web/vendor/c6-ota/vendor.sh — dingo-web's copy of c6-ota's browser client
# (ota-client.js: a firmware image's check and its upload), from the esensible
# monorepo's shared projects/c6-ota (github.com/esensible/esensible). dingo-cli
# is not in the monorepo, so the file is copied here and committed, with its
# SHA-256 and the monorepo commit in SOURCE.json.
#
#   sh web/vendor/c6-ota/vendor.sh            copy it again from the monorepo, rewrite SOURCE.json
#   sh web/vendor/c6-ota/vendor.sh --check    exit 1 unless the copy here, SOURCE.json and the
#                                             monorepo's file are the same bytes
#
# The monorepo's c6-ota is C6_OTA_DIR, by default ../esensible/projects/c6-ota
# next to this repo (~/src/esensible beside ~/src/dingo-cli). Plain POSIX sh
# with sha256sum or shasum; git only to name the commit. Run it where both
# repos are visible, e.g. from ~/src:
#
#   podman run --rm -v "$HOME/src:/src" -w /src/dingo-cli localhost/dingo-dev:latest \
#       -lc 'sh web/vendor/c6-ota/vendor.sh --check'
#
# (the image's entrypoint is bash, hence -lc). Its git cannot read the
# monorepo (relativeworktrees), so when vendoring there pass the commit:
# -e C6_OTA_COMMIT=$(git -C ~/src/esensible log -1 --format=%H -- projects/c6-ota/js/ota-client.js)
#
# The dingo-web tests check the copy against SOURCE.json without the monorepo
# (web/test/firmware.test.mjs), and against the monorepo's file when it is
# visible.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
SRC_DIR=${C6_OTA_DIR:-$REPO/../esensible/projects/c6-ota}
SRC="$SRC_DIR/js/ota-client.js"
DEST="$HERE/ota-client.js"
META="$HERE/SOURCE.json"

sha() {
    if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -d' ' -f1
    else shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

recorded() { sed -n 's/^  "sha256": "\([0-9a-f]*\)",*$/\1/p' "$META"; }

if [ "${1:-}" = "--check" ]; then
    status=0
    here=$(sha "$DEST")
    rec=$(recorded)
    if [ "$here" != "$rec" ]; then
        echo "vendor.sh: web/vendor/c6-ota/ota-client.js ($here) is not the file SOURCE.json records ($rec): it was edited here; change it in the monorepo's projects/c6-ota and vendor it again" >&2
        status=1
    fi
    if [ -f "$SRC" ]; then
        src=$(sha "$SRC")
        if [ "$src" != "$here" ]; then
            echo "vendor.sh: the monorepo's $SRC ($src) differs from the copy here ($here): run sh web/vendor/c6-ota/vendor.sh to take it, and check the transport (web/firmware.js) still fits" >&2
            status=1
        fi
    else
        echo "vendor.sh: no $SRC (set C6_OTA_DIR to the monorepo's projects/c6-ota)" >&2
        status=1
    fi
    [ $status -eq 0 ] && echo "vendor.sh: ota-client.js $here: the copy, SOURCE.json and the monorepo agree"
    exit $status
fi

[ -f "$SRC" ] || { echo "vendor.sh: no $SRC (set C6_OTA_DIR to the monorepo's projects/c6-ota)" >&2; exit 1; }
cp "$SRC" "$DEST"
# C6_OTA_COMMIT names the commit when git can't read the monorepo here (a
# container's git older than the monorepo's relativeworktrees extension);
# safe.directory: a container's root does not own a bind-mounted repo
if [ -n "${C6_OTA_COMMIT:-}" ]; then
    COMMIT=$C6_OTA_COMMIT
else
    COMMIT=$(git -c safe.directory='*' -C "$SRC_DIR" log -1 --format=%H -- js/ota-client.js 2>/dev/null || echo unknown)
    DIRTY=$(git -c safe.directory='*' -C "$SRC_DIR" status --porcelain -- js/ota-client.js 2>/dev/null || echo)
    [ -n "$DIRTY" ] && COMMIT="$COMMIT (with uncommitted changes)"
fi
{
    printf '{\n'
    printf '  "file": "ota-client.js",\n'
    printf '  "source": "github.com/esensible/esensible projects/c6-ota/js/ota-client.js",\n'
    printf '  "commit": "%s",\n' "$COMMIT"
    printf '  "sha256": "%s",\n' "$(sha "$DEST")"
    printf '  "changes": "none: byte for byte the monorepo file"\n'
    printf '}\n'
} > "$META"
echo "vendor.sh: ota-client.js $(sha "$DEST") from $COMMIT"
