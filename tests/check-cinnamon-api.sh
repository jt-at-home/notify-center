#!/usr/bin/env bash
#
# Verify the Cinnamon internals this applet relies on still exist.
# Run on the target machine; it is a compatibility smoke test, not a unit test.
#
set -euo pipefail

CINNAMON_JS="${CINNAMON_JS:-/usr/share/cinnamon/js}"

if [ ! -d "$CINNAMON_JS" ]; then
    echo "skip: ${CINNAMON_JS} not found (Cinnamon is not installed here)"
    exit 0
fi

missing=0

require() {
    local symbol="$1"
    local file="$2"
    if ! grep -q -- "$symbol" "$CINNAMON_JS/$file"; then
        echo "MISSING: ${symbol} in ${file}"
        missing=1
    fi
}

require "set_applet_icon_name" "ui/applet.js"
require "set_applet_tooltip" "ui/applet.js"
require "set_applet_label" "ui/applet.js"
require "setAllowedLayout" "ui/applet.js"
require "AllowedLayout" "ui/applet.js"
require "AppletPopupMenu" "ui/applet.js"
require "PopupMenuManager" "ui/popupMenu.js"
require "PopupMenuItem" "ui/popupMenu.js"
require "_notifyForSource" "ui/notificationDaemon.js"
require "_expireNotifications" "ui/notificationDaemon.js"
require "_restartExpire" "ui/notificationDaemon.js"
require "setResident" "ui/messageTray.js"

if [ "$missing" -eq 1 ]; then
    echo ""
    echo "This Cinnamon version does not expose everything the applet uses."
    echo "The applet will still load, but notification capture may be disabled."
    exit 1
fi

echo "Cinnamon API check passed"
