#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
test_dir=$(mktemp -d /tmp/relio-editor-test.XXXXXX)
trap 'rm -rf "$test_dir"' EXIT
# Keep the production app entry point intact; compile its model and view declarations for this runner.
sed '/^@main$/d' Sources/RelioApp/RelioApp.swift > "$test_dir/AppDeclarations.swift"
swiftc Sources/RelioApp/Core.swift Sources/RelioApp/ShortMaker.swift Sources/RelioApp/TranscriptSelection.swift Sources/RelioApp/GeminiSelection.swift Sources/RelioApp/SubjectFraming.swift \
  Sources/RelioApp/EditorWorkspace.swift Sources/RelioApp/Theme.swift Sources/RelioApp/Account.swift Sources/RelioApp/Notifier.swift Sources/RelioApp/Updater.swift "$test_dir/AppDeclarations.swift" Tests/EditorModel.swift \
  -Xcc -fmodule-map-file=Sources/CSQLite/module.modulemap -lsqlite3 \
  -F .build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64 -framework Sparkle -Xlinker -rpath -Xlinker "$PWD/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64" -o "$test_dir/editor-test"
"$test_dir/editor-test" "${1:-test-output/pictures.mov}"
