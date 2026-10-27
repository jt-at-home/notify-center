#!/usr/bin/env bash
#
# Install Notification Center for Cinnamon.
#
# Everything is installed under the current user's XDG directories. No file
# contains a hard-coded /home/... path: the applet, collector and viewer all
# resolve their paths at runtime.
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_UUID="notification-center@jt-at-home"

BIN_DIR="${HOME}/.local/bin"
DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"
DATA_DIR="${DATA_HOME}/notify-center"
CONFIG_DIR="${CONFIG_HOME}/notify-center"
SYSTEMD_DIR="${CONFIG_HOME}/systemd/user"
APPLET_DIR="${DATA_HOME}/cinnamon/applets/${APP_UUID}"
APPLICATIONS_DIR="${DATA_HOME}/applications"
SERVICE="notify-center-collector.service"

NO_SERVICE=0

usage() {
    cat <<'EOF'
Usage: install-notify-center.sh [--no-service]

  --no-service   Install the files but do not enable/start the systemd user
                 service. Useful in containers or when systemd --user is not
                 available.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --no-service) NO_SERVICE=1 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

if [ "$(id -u)" -eq 0 ]; then
    echo "Refusing to install as root. Run this as your desktop user." >&2
    exit 1
fi

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# dependencies

command -v python3 >/dev/null 2>&1 || fail "python3 is required"
python3 - <<'PY' || fail "python3 is missing the sqlite3 module"
import sqlite3  # noqa: F401
PY

if ! python3 - <<'PY' >/dev/null 2>&1
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk  # noqa: F401
PY
then
    fail "GTK 3 Python bindings are missing. Install: sudo apt install python3-gi gir1.2-gtk-3.0"
fi

if ! command -v cinnamon >/dev/null 2>&1; then
    say "warning: 'cinnamon' was not found on PATH; installing the files anyway."
fi

for file in \
    "${SCRIPT_DIR}/collector/notify-center-collector.py" \
    "${SCRIPT_DIR}/viewer/notify-center-viewer.py" \
    "${SCRIPT_DIR}/applet/applet.js" \
    "${SCRIPT_DIR}/applet/metadata.json" \
    "${SCRIPT_DIR}/config/config.json"
do
    [ -f "$file" ] || fail "missing file: $file"
done

# ---------------------------------------------------------------------------
# files

say "Installing Notification Center"
say "  user:   $(id -un)"
say "  prefix: ${HOME}"

install -d -m 0755 "$BIN_DIR"
install -m 0755 "${SCRIPT_DIR}/collector/notify-center-collector.py" \
    "${BIN_DIR}/notify-center-collector"
install -m 0755 "${SCRIPT_DIR}/viewer/notify-center-viewer.py" \
    "${BIN_DIR}/notify-center-viewer"

install -d -m 0700 "$DATA_DIR" "$DATA_DIR/spool" "$DATA_DIR/failed"
install -d -m 0700 "$CONFIG_DIR"
if [ -e "$CONFIG_DIR/config.json" ]; then
    say "Keeping existing config: ${CONFIG_DIR}/config.json"
else
    say "No config file yet; notify-center will use its built-in defaults."
fi

install -d -m 0755 "$APPLET_DIR"
install -m 0644 "${SCRIPT_DIR}/applet/applet.js" "$APPLET_DIR/applet.js"
install -m 0644 "${SCRIPT_DIR}/applet/metadata.json" "$APPLET_DIR/metadata.json"

install -d -m 0755 "$APPLICATIONS_DIR"
cat > "${APPLICATIONS_DIR}/notify-center.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Notification Center
Comment=Browse, search and manage notification history
Exec="${BIN_DIR}/notify-center-viewer"
Icon=dialog-information
Terminal=false
Categories=Utility;GTK;
StartupNotify=true
EOF
chmod 0644 "${APPLICATIONS_DIR}/notify-center.desktop"
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------------------
# systemd user service

install -d -m 0755 "$SYSTEMD_DIR"
cat > "${SYSTEMD_DIR}/${SERVICE}" <<EOF
[Unit]
Description=Notification Center collector
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
ExecStart=%h/.local/bin/notify-center-collector
Restart=on-failure
RestartSec=3
Environment=PYTHONUNBUFFERED=1
Environment="XDG_DATA_HOME=${DATA_HOME}"
Environment="XDG_CONFIG_HOME=${CONFIG_HOME}"

[Install]
WantedBy=default.target
EOF
chmod 0644 "${SYSTEMD_DIR}/${SERVICE}"

RUNNING=0
if [ "$NO_SERVICE" -eq 1 ]; then
    say "Skipping systemd (--no-service requested)."
elif systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user daemon-reload
    systemctl --user enable "$SERVICE" >/dev/null
    systemctl --user restart "$SERVICE" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
        if systemctl --user is-active --quiet "$SERVICE"; then
            RUNNING=1
            break
        fi
        sleep 0.25
    done
    if [ "$RUNNING" -eq 1 ]; then
        say "Collector service is running."
    else
        say "warning: ${SERVICE} did not become active."
        systemctl --user status "$SERVICE" --no-pager -n 20 || true
    fi
else
    say "warning: systemd --user is not available; the collector was not started."
    say "         Start it manually: ${BIN_DIR}/notify-center-collector &"
fi

# Legacy v1 applet: report, do not delete.
LEGACY_APPLET="${DATA_HOME}/cinnamon/applets/notification-center@yourname"
if [ -d "$LEGACY_APPLET" ]; then
    say ""
    say "Note: the old v1 applet is still installed at:"
    say "      ${LEGACY_APPLET}"
    say "      Remove it to avoid a duplicate entry in the Applets list:"
    say "      rm -rf \"${LEGACY_APPLET}\""
fi

# Legacy v1 units are unrelated and may restart-loop. Report, do not delete.
if [ "$NO_SERVICE" -eq 0 ] && \
    systemctl --user is-enabled --quiet notifyd.service 2>/dev/null; then
    say ""
    say "Note: the old v1 unit 'notifyd.service' is still enabled. It is not used by v2."
    say "      Disable it with: systemctl --user disable --now notifyd.service"
fi

# ---------------------------------------------------------------------------
# done

say ""
say "Installed files:"
say "  ${BIN_DIR}/notify-center-collector"
say "  ${BIN_DIR}/notify-center-viewer"
say "  ${APPLET_DIR}/"
say "  ${CONFIG_DIR}/config.json"
say "  ${SYSTEMD_DIR}/${SERVICE}"
say "  ${APPLICATIONS_DIR}/notify-center.desktop"
say ""
say "Next steps:"
say "  1. Right-click the Cinnamon panel -> Applets -> Notification Center -> Add to panel."
say "  2. Click the applet icon to open its menu, or middle-click to open the viewer."
say "  3. Notifications will now be recorded from the moment the applet is added."
say ""
say "Service status:  systemctl --user status ${SERVICE}"
say "Collector log:   journalctl --user -u ${SERVICE} -f"
say ""
say "Note: only notifications received while the applet is enabled are recorded;"
say "Cinnamon does not provide a backfill of earlier notifications."
