#!/bin/zsh
# Opens the real tutorial views using a throwaway home, fake account credentials and simulated generation.
set -euo pipefail
cd "${0:A:h}/.."
work=$(mktemp -d /tmp/prism-tutorial-preview.XXXXXX)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/home" test-output/TutorialPreview.app/Contents/MacOS
sed '/^@main$/d' Sources/RelioApp/RelioApp.swift > "$work/AppDeclarations.swift"
sed 's/SecretStore/TutorialPreviewKeys/g' Sources/RelioApp/Account.swift > "$work/Account.swift"
sources=(Sources/RelioApp/*.swift)
sources=(${sources:#Sources/RelioApp/RelioApp.swift})
sources=(${sources:#Sources/RelioApp/Account.swift})
swiftc "${sources[@]}" "$work/Account.swift" "$work/AppDeclarations.swift" Tests/TutorialPreview.swift \
  -Xcc -fmodule-map-file=Sources/CSQLite/module.modulemap -lsqlite3 \
  -F .build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64 -framework Sparkle \
  -Xlinker -rpath -Xlinker "$PWD/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64" \
  -o test-output/TutorialPreview.app/Contents/MacOS/TutorialPreview
cat > test-output/TutorialPreview.app/Contents/Info.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.prism.tutorial-preview</string>
<key>CFBundleExecutable</key><string>TutorialPreview</string>
<key>CFBundleName</key><string>Prism Tutorial Preview</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
CFFIXED_USER_HOME="$work/home" PRISM_TUTORIAL_PREVIEW_ROOT="$work" test-output/TutorialPreview.app/Contents/MacOS/TutorialPreview
