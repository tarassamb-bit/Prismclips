#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
test_dir=$(mktemp -d /tmp/relio-gemini-test.XXXXXX)
trap 'rm -rf "$test_dir"' EXIT
swiftc Sources/RelioApp/Core.swift Sources/RelioApp/TranscriptSelection.swift Sources/RelioApp/GeminiSelection.swift Sources/RelioApp/Account.swift Sources/RelioApp/ShortMaker.swift Sources/RelioApp/SubjectFraming.swift Tests/GeminiSelectionTests.swift \
  -Xcc -fmodule-map-file=Sources/CSQLite/module.modulemap -lsqlite3 -o "$test_dir/gemini-test"
"$test_dir/gemini-test"
