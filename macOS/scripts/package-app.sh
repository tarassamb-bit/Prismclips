#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
configuration=${RELIO_BUILD_CONFIGURATION:-release}
# Assembled and signed outside the repo: iCloud Drive's File Provider tags folders on the Desktop with Finder
# attributes that strict code signing rejects. The verified app is then copied to dist/Prism.app.
stage=$(mktemp -d "${TMPDIR:-/tmp}/prism-package.XXXXXX")
trap 'rm -rf "$stage"' EXIT
app=$stage/Prism.app
swift build -c "$configuration"
mkdir -p $app/Contents/MacOS
cp .build/"$configuration"/Relio $app/Contents/MacOS/Relio
cp packaging/Info.plist $app/Contents/Info.plist
# PRISM_VERSION is what people see (0.3.0, 0.3.0-beta.1); PRISM_BUILD must grow with every release, because Sparkle
# compares it to decide what is newer. The UTC build time always grows, even for a beta and a stable cut from one commit.
plist=$app/Contents/Info.plist
if [[ -n "${PRISM_VERSION:-}" ]]; then /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $PRISM_VERSION" $plist; fi
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${PRISM_BUILD:-$(date -u +%Y%m%d%H%M)}" $plist
# The public half of the update signing key (scripts/update-keys.sh); without it the app never installs updates.
if [[ -n "${PRISM_UPDATE_PUBLIC_KEY:-}" ]]; then /usr/libexec/PlistBuddy -c "Set :SUPublicEDKey $PRISM_UPDATE_PUBLIC_KEY" $plist; fi
# Only for testing the updater against a local or staging feed; releases use the prismclips.app feed in Info.plist.
if [[ -n "${PRISM_FEED_URL:-}" ]]; then /usr/libexec/PlistBuddy -c "Set :SUFeedURL $PRISM_FEED_URL" $plist; fi
# Sparkle, the updater, ships inside the app.
rm -rf $app/Contents/Frameworks
mkdir -p $app/Contents/Frameworks
ditto .build/"$configuration"/Sparkle.framework $app/Contents/Frameworks/Sparkle.framework
mkdir -p dist/Prism.iconset $app/Contents/Resources/Fonts
cp THIRD-PARTY-NOTICES.md $app/Contents/Resources/
cp licenses/OpenShorts-MIT.txt $app/Contents/Resources/
# Prism brand fonts (SIL Open Font License; each license ships beside its font).
cp packaging/Fonts/*.ttf packaging/Fonts/OFL-*.txt $app/Contents/Resources/Fonts/
swift scripts/generate-icon.swift dist/Prism.iconset/icon_512x512@2x.png
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" dist/Prism.iconset/icon_512x512@2x.png --out "dist/Prism.iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" dist/Prism.iconset/icon_512x512@2x.png --out "dist/Prism.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns dist/Prism.iconset -o $app/Contents/Resources/Prism.icns
# The generated bundle can inherit Finder/File Provider attributes from an existing artifact.
# Clear metadata from this build output before signing so codesign sees only app resources.
xattr -cr $app
if [[ -n "${RELIO_SIGNING_IDENTITY:-}" ]]; then
  identity=$RELIO_SIGNING_IDENTITY; signflags=(--options runtime --timestamp)
elif security find-identity -p codesigning | grep -q "Prism Local Signing"; then
  # Stable local identity (scripts/create-signing-identity.sh) keeps Keychain's "Always Allow" across rebuilds.
  identity="Prism Local Signing"; signflags=()
else
  identity=-; signflags=()
fi
# Sign Sparkle's helpers inside out, then the framework, then the app, all with the app's identity (Sparkle's documented order).
sparkle=$app/Contents/Frameworks/Sparkle.framework/Versions/B
for helper in $sparkle/XPCServices/Installer.xpc $sparkle/XPCServices/Downloader.xpc $sparkle/Autoupdate $sparkle/Updater.app; do
  if [[ -e $helper ]]; then codesign --force "${signflags[@]}" --preserve-metadata=entitlements --sign "$identity" $helper; fi
done
codesign --force "${signflags[@]}" --sign "$identity" $app/Contents/Frameworks/Sparkle.framework
codesign --force "${signflags[@]}" --sign "$identity" $app
codesign --verify --strict --deep $app
mkdir -p dist
rm -rf dist/Prism.app
ditto --noextattr --noqtn $app dist/Prism.app
echo "Created dist/Prism.app"
