#!/bin/zsh
# Publishes a Prism update for macOS: builds and signs the app, signs the update (EdDSA), adds it to the appcast
# and uploads both to the Cloudflare R2 bucket behind https://updates.prismclips.app.
#
#   zsh scripts/publish-update.sh 0.4.0 --notes "Faster Shorts on long videos" --notes "Calmer update banner"
#   zsh scripts/publish-update.sh 0.5.0-beta.1 --beta --notes "Try the new caption styles"
#
# Optional settings (environment):
#   RELIO_SIGNING_IDENTITY  "Developer ID Application: …" (recommended: Gatekeeper trusts it; otherwise the local identity)
#   PRISM_NOTARY_PROFILE    a notarytool keychain profile; when set, the app is notarized and stapled before upload
#   PRISM_SKIP_UPLOAD=1     build and sign only; the files stay in dist/updates
set -euo pipefail
cd "${0:A:h}/.."

version=${1:-}
if [[ -z $version || $version == -* ]]; then echo "Usage: publish-update.sh <version> [--beta] --notes \"…\" [--notes \"…\"]"; exit 64; fi
shift
channel=()
notes=()
while (( $# )); do
  case $1 in
    --beta) channel=(--channel beta) ;;
    --notes) notes+=("$2"); shift ;;
    *) echo "Unknown option: $1"; exit 64 ;;
  esac
  shift
done
if (( ${#notes} == 0 )); then echo "Add 1–3 short lines of release notes with --notes \"…\""; exit 64; fi
if (( ${#notes} > 3 )); then echo "Keep release notes to 3 lines; the update banner shows at most 3."; exit 64; fi

feed_base=https://prismclips.vercel.app/updates
bucket=${PRISM_R2_BUCKET:-prism-updates}
bin=.build/artifacts/sparkle/Sparkle/bin
public_key=${PRISM_UPDATE_PUBLIC_KEY:-$(/usr/libexec/PlistBuddy -c "Print :SUPublicEDKey" packaging/Info.plist 2>/dev/null || true)}
if [[ -z $public_key ]]; then echo "No update key yet. Run: zsh scripts/update-keys.sh"; exit 1; fi
# The private key normally comes from your Keychain; PRISM_UPDATE_KEY_FILE points at an exported copy instead (CI, tests).
if [[ -n "${PRISM_UPDATE_KEY_FILE:-}" ]]; then signing_key=(--ed-key-file "$PRISM_UPDATE_KEY_FILE"); else signing_key=(--account prism-updates); fi

# 1. Build and code-sign the app with this version.
swift package resolve >/dev/null
PRISM_VERSION=$version PRISM_UPDATE_PUBLIC_KEY=$public_key zsh scripts/package-app.sh

# 2. Notarize, so Gatekeeper opens fresh downloads without warnings.
if [[ -n "${PRISM_NOTARY_PROFILE:-}" ]]; then
  ditto -c -k --keepParent --noextattr --noqtn dist/Prism.app dist/Prism-notarize.zip
  xcrun notarytool submit dist/Prism-notarize.zip --keychain-profile "$PRISM_NOTARY_PROFILE" --wait
  xcrun stapler staple dist/Prism.app
  rm -f dist/Prism-notarize.zip
fi

# 3. dist/updates mirrors the bucket. Start from the live appcast so earlier releases stay listed.
updates=dist/updates
mkdir -p $updates
if [[ ! -f $updates/appcast.xml ]]; then
  curl -fsSL "$feed_base/appcast.xml" -o $updates/appcast.xml 2>/dev/null || rm -f $updates/appcast.xml
fi
archive=$updates/Prism-$version.zip
if [[ -e $archive ]]; then echo "$archive already exists; versions are never re-published. Pick a new version."; exit 1; fi
ditto -c -k --keepParent --noextattr --noqtn dist/Prism.app $archive
{
  print -n "<ul>"
  for line in "${notes[@]}"; do
    print -rn -- "<li>${${${line//&/&amp;}//</&lt;}//>/&gt;}</li>"
  done
  print "</ul>"
} > $updates/Prism-$version.html

# 4. Sign the archive with the private key from your Keychain and add it to the appcast.
$bin/generate_appcast "${signing_key[@]}" "${channel[@]}" --embed-release-notes \
  --download-url-prefix "$feed_base/" $updates
if ! grep -q "Prism-$version.zip" $updates/appcast.xml; then echo "The appcast does not list $version"; exit 1; fi

# 5. Publish: the Vercel site serves UI/updates, so the archive and appcast go there (the archive first, then the appcast,
#    so the feed never points at a missing file). Deploy the site to put them live.
if [[ "${PRISM_SKIP_UPLOAD:-}" == 1 ]]; then
  echo "Skipped publish. Files are in $updates."
else
  mkdir -p ../UI/updates
  cp $archive ../UI/updates/
  cp $updates/appcast.xml ../UI/updates/appcast.xml
  echo "Copied to UI/updates. Deploy the site: cd UI && npx vercel --prod"
fi

echo
echo "Published Prism $version${channel:+ (beta)}."
echo "Feed: $feed_base/appcast.xml · Archive: $feed_base/Prism-$version.zip"
