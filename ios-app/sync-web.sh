#!/bin/bash
# 親フォルダの Web アプリ本体を www/ にコピーする（ネイティブアプリに同梱するため）
# sw.js（Service Worker）はネイティブでは使わないのでコピーしない
set -euo pipefail
cd "$(dirname "$0")"
SRC=".."
DEST="www"
rm -rf "$DEST"
mkdir -p "$DEST"
# index.html は必須。無ければ止める（空のアプリを作らないため）
if [ ! -f "$SRC/index.html" ]; then
  echo "エラー: $SRC/index.html がありません" >&2
  exit 1
fi
# 同梱するファイルだけをコピー（tools / docs / ios-app などの開発物は入れない）
for f in index.html manifest.json icon.svg icon-192.png icon-512.png apple-touch-icon.png; do
  if [ -f "$SRC/$f" ]; then
    cp "$SRC/$f" "$DEST/"
  else
    echo "注意: $SRC/$f がありません（とばします）" >&2
  fi
done
echo "Web資産を www/ にコピーしました:"
ls -1 "$DEST"
