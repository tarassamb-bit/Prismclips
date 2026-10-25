#!/bin/zsh
# Drives the installed Prism app through System Events. Needs Accessibility permission for the terminal
# (System Settings > Privacy & Security > Accessibility). Read-only except for moving between screens.
set -euo pipefail
app_path=${1:-$HOME/Applications/Prism.app}
[[ -d "$app_path" ]] || { echo "FAIL: $app_path not installed. Run scripts/package-app.sh and install it first."; exit 1; }
osascript -e "tell application \"$app_path\" to activate"
sleep 2
result=$(osascript <<'APPLESCRIPT'
on run
    tell application "System Events"
        -- The executable is still named Relio; the bundle ID finds it whatever the process is called.
        if not (exists (first process whose bundle identifier is "app.relio.prototype")) then return "FAIL: Prism is not running"
        tell (first process whose bundle identifier is "app.relio.prototype")
            -- The window and its contents appear a moment after Prism comes to the front.
            set allText to ""
            repeat 10 times
                set frontmost to true
                delay 0.5
                if (count of windows) > 0 then
                    set w to front window
                    set allText to my labelsOf(entire contents of w)
                    if allText is not "" then exit repeat
                end if
            end repeat
            if allText is "" then return "FAIL: no Prism window"
            if allText does not contain "Start creating" then return "FAIL: home screen is missing 'Start creating'"
            if allText does not contain "Projects" then return "FAIL: home screen is missing the Projects section"
            if allText does not contain "Settings" then return "FAIL: sidebar is missing Settings"
            click (first button of w whose description is "Settings" or name is "Settings")
            delay 1
            set settingsText to my labelsOf(entire contents of front window)
            if settingsText does not contain "AI & Cloud" then return "FAIL: Settings did not open"
            click (first button of front window whose name is "Home" or description is "Home")
            delay 1
            if (my labelsOf(entire contents of front window)) does not contain "Start creating" then return "FAIL: Home did not reopen"
            return "PASS: Prism opens to Home, shows Projects, and moves between Home and Settings"
        end tell
    end tell
end run

on labelsOf(es)
    set out to ""
    tell application "System Events"
        repeat with el in es
            try
                set out to out & (name of el as text) & "|"
            end try
            try
                set out to out & (description of el as text) & "|"
            end try
            -- SwiftUI text exposes its words as the value, not the name.
            try
                set out to out & ((value of el) as text) & "|"
            end try
            try
                set out to out & ((value of attribute "AXHelp" of el) as text) & "|"
            end try
        end repeat
    end tell
    return out
end labelsOf
APPLESCRIPT
)
echo "$result"
[[ "$result" == PASS* ]]
