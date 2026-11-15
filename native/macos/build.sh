#!/bin/bash
set -euo pipefail
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The Core Bluetooth helper builds on macOS only." >&2
  exit 1
fi
native_dir="$(cd "$(dirname "$0")" && pwd)"
app_dir="$native_dir/.build/InkRelayBluetooth.app"
binary="$app_dir/Contents/MacOS/InkRelayBluetooth"
if [[ -f "$binary" && "$binary" -nt "$native_dir/BluetoothBridge.swift" && "$binary" -nt "$native_dir/Info.plist" && "$binary" -nt "$0" ]]; then
  echo "macOS Bluetooth helper is up to date."
  exit 0
fi
mkdir -p "$app_dir/Contents/MacOS"
cp "$native_dir/Info.plist" "$app_dir/Contents/Info.plist"
export MACOSX_DEPLOYMENT_TARGET=12.0
swift_flags=(-module-cache-path "$native_dir/.build/ModuleCache")
# Some Command Line Tools upgrades leave both the old module.modulemap and
# bridging.modulemap defining SwiftBridging. Hide only that duplicate via a
# build-local VFS overlay; never alter the developer's system headers.
swift_bin="$(xcrun --find swiftc)"
swift_include="$(cd "$(dirname "$swift_bin")/../include/swift" && pwd)"
if [[ -f "$swift_include/module.modulemap" && -f "$swift_include/bridging.modulemap" ]] \
  && grep -q 'module SwiftBridging' "$swift_include/module.modulemap" \
  && grep -q 'module SwiftBridging' "$swift_include/bridging.modulemap"; then
  empty_map="$native_dir/.build/empty.modulemap"
  overlay="$native_dir/.build/swift-overlay.json"
  : > "$empty_map"
  node -e 'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], JSON.stringify({version: 0, roots: [{type: "file", name: process.argv[2], "external-contents": process.argv[3]}]}));' \
    "$overlay" "$swift_include/module.modulemap" "$empty_map"
  swift_flags+=(-vfsoverlay "$overlay" -Xcc -ivfsoverlay -Xcc "$overlay")
fi
xcrun swiftc -swift-version 5 -O -framework CoreBluetooth -framework Foundation \
  "${swift_flags[@]}" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$native_dir/Info.plist" \
  "$native_dir/BluetoothBridge.swift" -o "$binary"
codesign --force --sign - --identifier net.inkrelay.bluetooth "$app_dir"
echo "Built $app_dir"
