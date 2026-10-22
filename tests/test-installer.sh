#!/usr/bin/env bash
#
# Install/uninstall into a throwaway HOME. Never touches the real install.
#
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -- "${HERE}/.." && pwd)"

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/notify-center-installer.XXXXXX")"
cleanup() { rm -rf "$ROOT"; }
trap cleanup EXIT

export HOME="${ROOT}/home"
export XDG_DATA_HOME="${ROOT}/data"
export XDG_CONFIG_HOME="${ROOT}/config"
# Point the user bus lookup at a throwaway runtime dir so that any stray
# `systemctl --user` call cannot reach the caller's real user manager.
export XDG_RUNTIME_DIR="${ROOT}/run"
mkdir -p "$HOME" "$XDG_RUNTIME_DIR"
chmod 0700 "$XDG_RUNTIME_DIR"

say() { printf '\n== %s\n' "$*"; }

say "install (--no-service)"
"${REPO}/install-notify-center.sh" --no-service

test -x "${HOME}/.local/bin/notify-center-collector"
test -x "${HOME}/.local/bin/notify-center-viewer"
test -f "${XDG_DATA_HOME}/cinnamon/applets/notification-center@jt-at-home/applet.js"
test -f "${XDG_DATA_HOME}/cinnamon/applets/notification-center@jt-at-home/metadata.json"
test -f "${XDG_CONFIG_HOME}/notify-center/config.json"
test -f "${XDG_CONFIG_HOME}/systemd/user/notify-center-collector.service"
test -f "${XDG_DATA_HOME}/applications/notify-center.desktop"
test -d "${XDG_DATA_HOME}/notify-center/spool"

python3 - "${XDG_DATA_HOME}" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
meta = json.loads(
    (root / "cinnamon/applets/notification-center@jt-at-home/metadata.json").read_text()
)
assert meta["uuid"] == "notification-center@jt-at-home", meta
assert meta["max-instances"] == 1, meta
assert meta["cinnamon-version"], meta
print("applet metadata OK")
PY

grep -q "ExecStart=%h/.local/bin/notify-center-collector" \
    "${XDG_CONFIG_HOME}/systemd/user/notify-center-collector.service"
grep -q "XDG_DATA_HOME=" \
    "${XDG_CONFIG_HOME}/systemd/user/notify-center-collector.service"
grep -q "notify-center-viewer" "${XDG_DATA_HOME}/applications/notify-center.desktop"
echo "unit and desktop entry OK"

echo "installed files OK"

# Custom config must survive a reinstall.
echo '{"custom": true}' > "${XDG_CONFIG_HOME}/notify-center/config.json"
"${REPO}/install-notify-center.sh" --no-service >/dev/null
grep -q '"custom": true' "${XDG_CONFIG_HOME}/notify-center/config.json"
echo "existing config preserved"

say "uninstall (keep data)"
"${REPO}/uninstall-notify-center.sh" --no-service
test ! -e "${HOME}/.local/bin/notify-center-collector"
test ! -e "${HOME}/.local/bin/notify-center-viewer"
test ! -e "${XDG_DATA_HOME}/cinnamon/applets/notification-center@jt-at-home"
test ! -e "${XDG_CONFIG_HOME}/systemd/user/notify-center-collector.service"
test ! -e "${XDG_DATA_HOME}/applications/notify-center.desktop"
test -d "${XDG_DATA_HOME}/notify-center"
test -d "${XDG_CONFIG_HOME}/notify-center"
echo "uninstall kept data and config"

say "install + uninstall --purge"
"${REPO}/install-notify-center.sh" --no-service >/dev/null
"${REPO}/uninstall-notify-center.sh" --purge --no-service
test ! -e "${XDG_DATA_HOME}/notify-center"
test ! -e "${XDG_CONFIG_HOME}/notify-center"
echo "purge removed data and config"

say "installer test passed"
