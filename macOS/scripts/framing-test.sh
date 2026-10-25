#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
swiftc Sources/RelioApp/Core.swift Sources/RelioApp/ShortMaker.swift Sources/RelioApp/TranscriptSelection.swift Sources/RelioApp/GeminiSelection.swift Sources/RelioApp/Account.swift Sources/RelioApp/SubjectFraming.swift Tests/Framing.swift \
  -Xcc -fmodule-map-file=Sources/CSQLite/module.modulemap -lsqlite3 -o /tmp/relio-framing-check
/tmp/relio-framing-check "$@"
