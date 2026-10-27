#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/notify-center-applet-test.XXXXXX")"
cleanup() { rm -rf "$ROOT"; }
trap cleanup EXIT

export HOME="$ROOT/home"
export XDG_DATA_HOME="$ROOT/data"
export XDG_CONFIG_HOME="$ROOT/config"
mkdir -p \
    "$HOME/.local/bin" \
    "$XDG_DATA_HOME/notify-center/spool" \
    "$XDG_CONFIG_HOME/notify-center"

cat > "$HOME/.local/bin/notify-center-viewer" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod 0755 "$HOME/.local/bin/notify-center-viewer"
# The applet prefers a viewer found on PATH. Make sure the throwaway one wins
# even when the real v2 install exists in the developer's ~/.local/bin.
export PATH="$HOME/.local/bin:${PATH}"

cat > "$XDG_CONFIG_HOME/notify-center/config.json" <<'EOF'
{
  "ignore_transient": true,
  "ignore_apps": ["Noisy"],
  "persistent_apps": ["Thunderbird"],
  "persistent_categories": ["im.received"],
  "dismiss_after_capture": false,
  "toast_enabled": false,
  "toast_timeout": 5,
  "toast_position": "top-right",
  "sound_enabled": false,
  "sound_file": ""
}
EOF

export NOTIFY_CENTER_APPLET="$HERE/../../applet/applet.js"
export GJS_PATH="$HERE/js"

# Prefer Cinnamon's cjs (the engine the applet really runs on), but fall back
# to plain gjs so the harness also works in CI and on non-Cinnamon machines.
GJS_BIN="${GJS_BIN:-}"
if [ -z "$GJS_BIN" ]; then
    if command -v cjs >/dev/null 2>&1; then
        GJS_BIN="cjs"
    elif command -v gjs >/dev/null 2>&1; then
        GJS_BIN="gjs"
    else
        echo "error: neither cjs nor gjs was found on PATH" >&2
        exit 2
    fi
fi

status=0
"$GJS_BIN" "$HERE/run-tests.js" || status=$?
exit "$status"
