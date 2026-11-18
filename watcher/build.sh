#!/bin/sh
# Builds the watcher image on Agent37: copies the shared code in, then uploads this folder (no keys in it).
set -e
cd "$(dirname "$0")"
mkdir -p lib
cp ../UI/app/live/twitch.js ../UI/app/live/detector.js lib/
cp ../UI/api/_r2.js lib/_r2.cjs
cp ../UI/icon-192.png logo.png
set -a; . ../.agent37.env; set +a
npx -y agent37 templates build . --name relio-watcher
