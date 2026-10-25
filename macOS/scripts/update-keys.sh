#!/bin/zsh
# One time: creates Prism's update signing key (EdDSA) in your login Keychain and puts its public half in the app.
# Every update is signed with the private key; the app installs only updates whose signature matches the public key.
set -euo pipefail
cd "${0:A:h}/.."
swift package resolve >/dev/null
bin=.build/artifacts/sparkle/Sparkle/bin
account=prism-updates
# Creates the key the first time; later runs just print the existing public key.
$bin/generate_keys --account $account
public=$($bin/generate_keys --account $account -p)
/usr/libexec/PlistBuddy -c "Set :SUPublicEDKey $public" packaging/Info.plist
echo
echo "Public key saved in packaging/Info.plist: $public"
echo "Commit that change. Then back up the private key, because without it you can never ship another update:"
echo "  $bin/generate_keys --account $account -x ~/Desktop/prism-update-key.txt"
echo "Store that file in your password manager and delete it from the Desktop. Never commit it."
