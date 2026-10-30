#!/bin/zsh
# Shows the real Windows app in your browser, run by .github/workflows/windows-preview.yml on a GitHub Windows machine.
# Usage: zsh Windows/preview.sh   Runs the last commit; Ctrl+C here shuts the machine down (it stops by itself after 3 hours).
set -euo pipefail
cd "${0:A:h}/.."
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
service=prism-windows-preview

password=$(security find-generic-password -s $service -w 2>/dev/null || true)
if [[ -z $password ]]; then
  # VNC passwords stop at 8 characters.
  password=$(openssl rand -base64 32 | tr -dc A-Za-z0-9)
  password=${password[1,8]}
  security add-generic-password -s $service -a "$USER" -w "$password"
  if ! gh secret set PREVIEW_PASSWORD --repo $repo --body "$password"; then
    print "gh could not save the secret. On GitHub open $repo › Settings › Secrets and variables › Actions,"
    print "add a repository secret named PREVIEW_PASSWORD with the value: $password"
    read -r "?Press Return once it is saved. "
  fi
fi

[[ -z $(git status --porcelain) ]] || print "Uncommitted changes are not included: only commit $(git rev-parse --short HEAD) runs."
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Recreating the branch always fires a new push, even for a commit that ran before.
git push -q origin :refs/heads/windows-preview 2>/dev/null || true
git push -q origin HEAD:refs/heads/windows-preview
print "Starting the Windows machine and building Prism (about 5–8 minutes)…"

run=""
trap '[[ -n $run ]] && gh run cancel $run --repo $repo >/dev/null 2>&1; print "\nWindows machine stopped."; exit 0' INT
until [[ -n $run ]]; do
  sleep 5
  run=$(gh run list --repo $repo --workflow windows-preview.yml --branch windows-preview --limit 5 --json databaseId,createdAt \
    -q "[.[] | select(.createdAt >= \"$started\")][0].databaseId // empty")
done

cipher=""
until [[ -n $cipher ]]; do
  sleep 10
  state=$(gh run view $run --repo $repo --json status,conclusion -q '.status + " " + .conclusion')
  if [[ $state == completed* ]]; then
    print "The run ended ($state) before the screen was ready. See: gh run view $run --repo $repo --log-failed"
    exit 1
  fi
  cipher=$(gh api repos/$repo/commits/$(git rev-parse HEAD)/statuses -q ".[] | select(.context == \"windows-preview/$run\") | .description" 2>/dev/null || true)
done

url=$(print -rn -- $cipher | PREVIEW_PASSWORD=$password openssl enc -d -aes-256-cbc -pbkdf2 -md sha256 -a -A -pass env:PREVIEW_PASSWORD)
# The password goes in the # part, which the browser never sends over the network.
open "$url/vnc.html#autoconnect=true&resize=scale&password=$password"
print "Windows is open in your browser ($url/vnc.html, password $password). Press Ctrl+C here to shut it down."
while [[ $(gh run view $run --repo $repo --json status -q .status) != completed ]]; do sleep 60; done
print "The Windows machine has stopped."
