#!/usr/bin/env bash
#
# Uninstall Notification Center.
#
set -euo pipefail

APP_UUID="notification-center@jt-at-home"
BIN_DIR="${HOME}/.local/bin"
DATA_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/notify-center"
CONFIG_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/notify-center"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
APPLET_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/cinnamon/applets/${APP_UUID}"
APPLICATIONS_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/applications"
SERVICE="notify-center-collector.service"

PURGE=0
NO_SERVICE=0

usage() {
    cat <<'EOF'
Usage: uninstall-notify-center.sh [--purge] [--no-service]

  --purge        Also delete the notification database, spool and config.
                 Without it, history and configuration are kept.
  --no-service   Do not stop, disable or reload the systemd user service.
                 Use this when working on a throwaway prefix; systemctl --user
                 always targets the caller's real user manager, not $HOME.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --purge) PURGE=1 ;;
        --no-service) NO_SERVICE=1 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

say() { printf '%s\n' "$*"; }

if [ "$NO_SERVICE" -eq 0 ] && command -v systemctl >/dev/null 2>&1 \
    && systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user disable --now "$SERVICE" >/dev/null 2>&1 || true
fi

rm -f -- "${SYSTEMD_DIR}/${SERVICE}"
if [ "$NO_SERVICE" -eq 0 ] && command -v systemctl >/dev/null 2>&1 \
    && systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
fi

rm -f -- "${BIN_DIR}/notify-center-collector"
rm -f -- "${BIN_DIR}/notify-center-viewer"
rm -f -- "${APPLICATIONS_DIR}/notify-center.desktop"
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
fi

if [ -d "$APPLET_DIR" ]; then
    rm -rf -- "${APPLET_DIR:?}"
fi

say "Removed the Notification Center files."

if [ "$PURGE" -eq 1 ]; then
    rm -rf -- "${DATA_DIR:?}"
    rm -rf -- "${CONFIG_DIR:?}"
    say "Deleted the notification database, spool and configuration."
else
    say "Kept history and configuration:"
    say "  ${DATA_DIR}"
    say "  ${CONFIG_DIR}"
    say "Run with --purge to delete them."
fi

say ""
say "Remove the applet from the panel first if you have not already:"
say "  right-click the panel -> Applets -> Notification Center -> Remove"
