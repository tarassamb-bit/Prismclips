#!/bin/zsh
# Regenerates the README images in assets/readme. Builds a demo library of illustrated footage in a throwaway
# home folder, renders the real app screens and Shorts from it, and composes the brand images. Your projects never appear.
set -euo pipefail
cd "${0:A:h}/.."
work=$(mktemp -d /tmp/prism-readme.XXXXXX)
trap 'rm -rf "$work"' EXIT
sed '/^@main$/d' Sources/RelioApp/RelioApp.swift > "$work/AppDeclarations.swift"
swiftc Sources/RelioApp/Core.swift Sources/RelioApp/ShortMaker.swift Sources/RelioApp/TranscriptSelection.swift Sources/RelioApp/GeminiSelection.swift \
  Sources/RelioApp/SubjectFraming.swift Sources/RelioApp/EditorWorkspace.swift Sources/RelioApp/Theme.swift Sources/RelioApp/Account.swift Sources/RelioApp/Notifier.swift Sources/RelioApp/Updater.swift "$work/AppDeclarations.swift" \
  scripts/readme-assets/*.swift -Xcc -fmodule-map-file=Sources/CSQLite/module.modulemap -lsqlite3 \
  -F .build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64 -framework Sparkle -Xlinker -rpath -Xlinker "$PWD/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64" -o "$work/readme-assets"
mkdir -p "$work/home" assets/readme
CFFIXED_USER_HOME="$work/home" "$work/readme-assets" "$work" assets/readme
swift scripts/generate-icon.swift "$work/icon.png"
sips -Z 256 "$work/icon.png" --out assets/readme/icon.png >/dev/null
