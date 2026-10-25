#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
# Checks the Sparkle wiring without a network: delegate handlers, release-note lines and the beta channel.
swift package resolve >/dev/null
sparkle=.build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64
test_dir=$(mktemp -d /tmp/prism-updater-test.XXXXXX)
trap 'rm -rf "$test_dir"' EXIT
swiftc -parse-as-library -F $sparkle -framework Sparkle -Xlinker -rpath -Xlinker "$PWD/$sparkle" \
  Sources/RelioApp/Updater.swift Tests/UpdaterCheck.swift -o "$test_dir/updater-test"
"$test_dir/updater-test"
