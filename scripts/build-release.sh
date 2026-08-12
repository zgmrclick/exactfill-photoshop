#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
DIST="$ROOT/dist"
ARCHIVE="$DIST/ExactFill-$VERSION.zip"
BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/exactfill-release.XXXXXX")"

cleanup() {
    case "$BUILD_ROOT" in
        */exactfill-release.*) rm -rf "$BUILD_ROOT" ;;
        *) echo "Refusing to clean unexpected path: $BUILD_ROOT" >&2 ;;
    esac
}
trap cleanup EXIT

mkdir -p "$DIST" "$BUILD_ROOT/ExactFill/icons" "$BUILD_ROOT/ExactFill/providers"

ROOT_FILES=(
    app-info.js auth.js cache.js capture.js geometry.js history.js i18n.js
    index.html layer-tree.js main.js manifest.json place.js png.js presets.js
    public-ui.js style.css usage.js
)
PROVIDER_FILES=(
    providers/google.js providers/http.js providers/index.js providers/openai.js
)
PANEL_ICON_FILES=(
    panel-dark@1x.png panel-dark@2x.png panel-light@1x.png panel-light@2x.png
)

for file in "${ROOT_FILES[@]}"; do cp "$ROOT/$file" "$BUILD_ROOT/ExactFill/$file"; done
for file in "${PROVIDER_FILES[@]}"; do cp "$ROOT/$file" "$BUILD_ROOT/ExactFill/$file"; done
cp "$ROOT/icons/exactfill.svg" "$BUILD_ROOT/ExactFill/icons/exactfill.svg"
for file in "${PANEL_ICON_FILES[@]}"; do cp "$ROOT/icons/$file" "$BUILD_ROOT/ExactFill/icons/$file"; done
cp "$ROOT/INSTALL.txt" "$BUILD_ROOT/INSTALL.txt"

rm -f "$ARCHIVE"
(
    cd "$BUILD_ROOT"
    zip -q -r "$ARCHIVE" INSTALL.txt ExactFill
)

echo "$ARCHIVE"
