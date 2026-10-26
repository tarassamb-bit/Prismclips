#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
test_dir=$(mktemp -d /tmp/prism-tutorial-test.XXXXXX)
trap 'rm -rf "$test_dir"' EXIT
swiftc Sources/RelioApp/FirstRunTutorial.swift Tests/FirstRunTutorialTests.swift -o "$test_dir/tutorial-test"
"$test_dir/tutorial-test"
