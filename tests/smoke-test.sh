#!/usr/bin/env bash
#
# End-to-end smoke test for Notification Center.
# Does not install anything and does not touch the real database.
#
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -- "${HERE}/.." && pwd)"

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/notify-center-smoke.XXXXXX")"
cleanup() { rm -rf "$ROOT"; }
trap cleanup EXIT

export XDG_DATA_HOME="${ROOT}/data"
export XDG_CONFIG_HOME="${ROOT}/config"
mkdir -p "${XDG_DATA_HOME}/notify-center/spool" "${XDG_CONFIG_HOME}/notify-center"
cp "${REPO}/config/config.json" "${XDG_CONFIG_HOME}/notify-center/config.json"

say() { printf '\n== %s\n' "$*"; }

say "seeding spool"
python3 - "${XDG_DATA_HOME}/notify-center/spool" <<'PY'
import json
import pathlib
import sys
import time

spool = pathlib.Path(sys.argv[1])
now = int(time.time())
records = [
    {
        "session": "smoke", "source_id": 1, "is_update": False,
        "app": "Thunderbird", "desktop_entry": "thunderbird.desktop",
        "title": "New email", "body": "From Alice", "category": "email.arrived",
        "urgency": 2, "transient": False, "hints": {"category": "email.arrived"},
        "timestamp": now - 60,
    },
    {
        "session": "smoke", "source_id": 2, "is_update": False,
        "app": "Signal", "title": "Message from Bob", "body": "hi",
        "category": "im.received", "urgency": 1, "transient": False,
        "hints": {}, "timestamp": now - 30,
    },
    {
        "session": "smoke", "source_id": 3, "is_update": False,
        "app": "Spotify", "title": "Now playing", "body": "A song",
        "category": None, "urgency": 0, "transient": True,
        "hints": {"transient": True}, "timestamp": now - 10,
    },
]
for index, record in enumerate(records):
    (spool / f"{now}{index:03d}-smoke.json").write_text(json.dumps(record))
print(f"wrote {len(records)} spool files")
PY

say "collector --once"
python3 "${REPO}/collector/notify-center-collector.py" --once --verbose

say "checking database"
python3 - "${XDG_DATA_HOME}/notify-center" <<'PY'
import json
import sqlite3
import sys

data = sys.argv[1]
conn = sqlite3.connect(f"{data}/notifications.db")
rows = conn.execute("SELECT app, title FROM notifications ORDER BY id").fetchall()
conn.close()
assert len(rows) == 2, rows
assert rows[0][0] == "Thunderbird", rows
assert rows[1][0] == "Signal", rows
status = json.load(open(f"{data}/status.json"))
assert status["unread"] == 2, status
assert status["total"] == 2, status
print("database and status OK")
PY

say "collector unit tests"
python3 -m unittest discover -s "${REPO}/tests" -p 'test_*.py' -q

say "viewer self-test"
if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
    python3 "${REPO}/viewer/notify-center-viewer.py" --self-test
else
    echo "no display; skipping viewer self-test"
fi

say "applet harness"
"${HERE}/applet-harness/run.sh"

say "Cinnamon API compatibility"
"${HERE}/check-cinnamon-api.sh"

say "installer/uninstaller"
"${HERE}/test-installer.sh"

say "smoke test passed"
