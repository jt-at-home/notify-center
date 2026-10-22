#!/usr/bin/env python3
"""Notification Center collector.

This is *not* a notification server. Cinnamon keeps owning
org.freedesktop.Notifications. The Cinnamon applet writes one small JSON file
per notification into ~/.local/share/notify-center/spool/ and this process
drains that spool into a SQLite database.

It also maintains ~/.local/share/notify-center/status.json so the applet can
show an unread badge without touching SQLite from the Cinnamon process.

Only the Python standard library is required.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import shutil
import signal
import sqlite3
import sys
import threading
import time
import traceback
from pathlib import Path

APP_NAME = "notify-center"
SCHEMA_VERSION = 2
MAX_SPOOL_BYTES = 1024 * 1024
PROCESSED_TTL = 7 * 86400

DEFAULT_CONFIG = {
    "retention_days": 30,
    "max_rows": 5000,
    "ignore_transient": True,
    "ignore_apps": [],
    # Persistence is opt-in. The collector ignores these; the applet uses them
    # only if you want a notification to stay in Cinnamon's tray.
    "persistent_apps": [],
    "persistent_categories": [],
}

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS notifications (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session       TEXT    NOT NULL DEFAULT '',
    source_id     INTEGER,
    spool_key     TEXT,
    app           TEXT    NOT NULL DEFAULT '',
    desktop_entry TEXT,
    title         TEXT    NOT NULL DEFAULT '',
    body          TEXT    NOT NULL DEFAULT '',
    category      TEXT,
    urgency       INTEGER NOT NULL DEFAULT 1,
    transient     INTEGER NOT NULL DEFAULT 0,
    icon          TEXT,
    actions       TEXT,
    hints         TEXT,
    received_at   INTEGER NOT NULL,
    read_at       INTEGER,
    closed_at     INTEGER,
    close_reason  INTEGER,
    UNIQUE (session, source_id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_received
    ON notifications (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread
    ON notifications (read_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_app
    ON notifications (app COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_notifications_category
    ON notifications (category);

CREATE TABLE IF NOT EXISTS processed (
    spool_key    TEXT PRIMARY KEY,
    processed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_processed_at ON processed (processed_at);
"""


# ---------------------------------------------------------------------------
# helpers


def log(message: str) -> None:
    print(f"[notify-center] {message}", file=sys.stderr, flush=True)


def default_data_dir() -> Path:
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / APP_NAME


def default_config_path() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / APP_NAME / "config.json"


def _as_int(value, default: int, low: int | None = None, high: int | None = None) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    if low is not None:
        number = max(low, number)
    if high is not None:
        number = min(high, number)
    return number


def _str_list(value) -> list[str]:
    if not isinstance(value, list):
        return []
    result = []
    for item in value:
        if isinstance(item, str):
            item = item.strip()
            if item:
                result.append(item)
    return result


def load_config(path: Path, verbose: bool = False) -> dict:
    config = dict(DEFAULT_CONFIG)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return config
    except (OSError, ValueError) as exc:
        log(f"cannot read {path}: {exc}; using defaults")
        return config

    if not isinstance(raw, dict):
        log(f"{path} is not a JSON object; using defaults")
        return config

    config["retention_days"] = _as_int(raw.get("retention_days"), 30, 1, 3650)
    config["max_rows"] = _as_int(raw.get("max_rows"), 5000, 100, 100_000)
    config["ignore_transient"] = bool(raw.get("ignore_transient", True))

    # v1 compatibility: "apps"/"categories" were the old key names.
    apps = raw["persistent_apps"] if "persistent_apps" in raw else raw.get("apps", [])
    cats = raw["persistent_categories"] if "persistent_categories" in raw else raw.get("categories", [])
    config["ignore_apps"] = _str_list(raw.get("ignore_apps"))
    config["persistent_apps"] = _str_list(apps)
    config["persistent_categories"] = _str_list(cats)

    if verbose:
        log(
            "config: retention=%d days, max_rows=%d, ignore_transient=%s"
            % (config["retention_days"], config["max_rows"], config["ignore_transient"])
        )
    return config


def ensure_dirs(data_dir: Path) -> tuple[Path, Path]:
    spool = data_dir / "spool"
    failed = data_dir / "failed"
    for directory in (data_dir, spool, failed):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(directory, 0o700)
        except OSError:
            pass
    return spool, failed


def cleanup_failed(failed_dir: Path) -> None:
    """Remove quarantined spool files older than the processed TTL."""
    cutoff = time.time() - PROCESSED_TTL
    try:
        entries = list(failed_dir.iterdir())
    except OSError:
        return
    for path in entries:
        try:
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError:
            pass


def open_db(data_dir: Path) -> sqlite3.Connection:
    data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    db_path = data_dir / "notifications.db"
    conn = sqlite3.connect(str(db_path), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=10000")
    conn.execute("PRAGMA temp_store=MEMORY")
    ensure_schema(conn)
    try:
        os.chmod(db_path, 0o600)
    except OSError:
        pass
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version > SCHEMA_VERSION:
        raise RuntimeError(
            f"database schema v{version} is newer than this collector (v{SCHEMA_VERSION})"
        )
    if version == 0:
        conn.executescript(SCHEMA_SQL)
        conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        conn.commit()
        return
    if version < SCHEMA_VERSION:
        # No migrations exist yet (v2 is the first schema). Keep the door open.
        conn.executescript(SCHEMA_SQL)
        conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        conn.commit()


# ---------------------------------------------------------------------------
# record handling


def _clean_text(value, limit: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        value = str(value)
    return value[:limit]


def _json_or_none(value) -> str | None:
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return None


def _sanitize_hints(hints) -> str | None:
    if not isinstance(hints, dict):
        return None
    drop = {"image-data", "image_data", "icon_data", "image_data"}
    clean = {}
    for key, value in hints.items():
        if not isinstance(key, str) or key in drop:
            continue
        if value is None or isinstance(value, (str, int, float, bool)):
            clean[key] = value
        elif isinstance(value, list) and all(
            isinstance(item, (str, int, float, bool)) for item in value
        ):
            clean[key] = value
    if not clean:
        return None
    encoded = json.dumps(clean, ensure_ascii=False, default=str)
    if len(encoded) > 8192:
        return json.dumps({"truncated": True, "keys": sorted(clean)})
    return encoded


def _normalize_app(value) -> str:
    text = _clean_text(value, 512).strip().lower()
    if text.endswith(".desktop"):
        text = text[: -len(".desktop")]
    return text


def _is_ignored(app: str, desktop_entry: str, patterns: list[str]) -> bool:
    names = {_normalize_app(app), _normalize_app(desktop_entry)}
    names.discard("")
    for pattern in patterns:
        if _normalize_app(pattern) in names:
            return True
    return False


def apply_record(
    conn: sqlite3.Connection,
    record: dict,
    config: dict,
    spool_key: str,
    verbose: bool = False,
) -> str:
    """Insert or update one notification. Returns a short outcome label."""
    hints = record.get("hints") if isinstance(record.get("hints"), dict) else {}
    desktop_entry = _clean_text(
        record.get("desktop_entry") or hints.get("desktop-entry"), 512
    )
    app = _clean_text(record.get("app"), 512)

    if config["ignore_transient"] and bool(record.get("transient")):
        if verbose:
            log(f"skip transient notification from {app!r}")
        return "transient"

    if _is_ignored(app, desktop_entry, config["ignore_apps"]):
        if verbose:
            log(f"skip ignored app {app!r}")
        return "ignored"

    session = _clean_text(record.get("session"), 128) or "unknown"
    source_id = record.get("source_id")
    try:
        source_id = int(source_id) if source_id is not None else None
    except (TypeError, ValueError):
        source_id = None
    if source_id is not None and source_id <= 0:
        source_id = None

    title = _clean_text(record.get("title"), 4096)
    body = _clean_text(record.get("body"), 65536)
    category = _clean_text(record.get("category"), 256) or None
    urgency = _as_int(record.get("urgency"), 1, 0, 2)
    transient = 1 if record.get("transient") else 0
    icon = _clean_text(record.get("icon") or hints.get("image-path"), 1024) or None

    actions = record.get("actions")
    actions_json = _json_or_none(actions) if isinstance(actions, list) else None
    hints_json = _sanitize_hints(hints)

    now = int(time.time())
    try:
        received_at = int(record.get("timestamp"))
    except (TypeError, ValueError):
        received_at = now
    if received_at < 946684800 or received_at > now + 86400:
        received_at = now

    with conn:
        cursor = conn.execute(
            "INSERT OR IGNORE INTO processed (spool_key, processed_at) VALUES (?, ?)",
            (spool_key, now),
        )
        if cursor.rowcount == 0:
            return "duplicate"

        conn.execute(
            """
            INSERT INTO notifications
                (session, source_id, spool_key, app, desktop_entry, title, body,
                 category, urgency, transient, icon, actions, hints, received_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (session, source_id) DO UPDATE SET
                spool_key     = excluded.spool_key,
                app           = excluded.app,
                desktop_entry = excluded.desktop_entry,
                title         = excluded.title,
                body          = excluded.body,
                category      = excluded.category,
                urgency       = excluded.urgency,
                transient     = excluded.transient,
                icon          = excluded.icon,
                actions       = excluded.actions,
                hints         = excluded.hints,
                received_at   = excluded.received_at
            """,
            (
                session,
                source_id,
                spool_key,
                app,
                desktop_entry or None,
                title,
                body,
                category,
                urgency,
                transient,
                icon,
                actions_json,
                hints_json,
                received_at,
            ),
        )
    return "updated" if record.get("is_update") else "inserted"


def quarantine(path: Path, failed_dir: Path) -> None:
    target = failed_dir / path.name
    if target.exists():
        target = failed_dir / f"{int(time.time())}-{path.name}"
    try:
        shutil.move(str(path), str(target))
        log(f"quarantined bad spool file {path.name}")
    except OSError as exc:
        log(f"cannot quarantine {path.name}: {exc}")


def drain_once(
    conn: sqlite3.Connection,
    spool_dir: Path,
    failed_dir: Path,
    config: dict,
    verbose: bool = False,
) -> int:
    processed = 0
    files = sorted(spool_dir.glob("*.json"), key=lambda item: item.name)
    for path in files:
        try:
            if path.stat().st_size > MAX_SPOOL_BYTES:
                raise ValueError("spool file is too large")
            raw = path.read_text(encoding="utf-8")
            record = json.loads(raw)
            if not isinstance(record, dict):
                raise ValueError("spool file is not a JSON object")
        except (OSError, ValueError) as exc:
            log(f"bad spool file {path.name}: {exc}")
            quarantine(path, failed_dir)
            continue

        try:
            outcome = apply_record(conn, record, config, path.name, verbose)
        except sqlite3.Error:
            # Keep the file: the next loop will retry.
            raise
        except Exception as exc:  # defensive: never crash on one record
            log(f"cannot process {path.name}: {exc}")
            quarantine(path, failed_dir)
            continue

        try:
            path.unlink()
        except FileNotFoundError:
            pass
        except OSError as exc:
            log(f"cannot remove {path.name}: {exc}")
        processed += 1
        if verbose:
            log(f"{outcome}: {path.name}")
    return processed


# ---------------------------------------------------------------------------
# maintenance / status


def prune(conn: sqlite3.Connection, config: dict) -> None:
    now = int(time.time())
    cutoff = now - int(config["retention_days"]) * 86400
    with conn:
        conn.execute("DELETE FROM notifications WHERE received_at < ?", (cutoff,))
        conn.execute(
            """
            DELETE FROM notifications
            WHERE id NOT IN (
                SELECT id FROM notifications
                ORDER BY received_at DESC, id DESC
                LIMIT ?
            )
            """,
            (int(config["max_rows"]),),
        )
        conn.execute(
            "DELETE FROM processed WHERE processed_at < ?", (now - PROCESSED_TTL,)
        )
    try:
        conn.execute("PRAGMA optimize")
    except sqlite3.Error:
        pass


def counts(conn: sqlite3.Connection) -> tuple[int, int]:
    row = conn.execute(
        """
        SELECT COUNT(*) AS total,
               COALESCE(SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END), 0) AS unread
        FROM notifications
        """
    ).fetchone()
    return int(row["unread"]), int(row["total"])


def write_status(
    conn: sqlite3.Connection,
    data_dir: Path,
    state: dict,
    force: bool = False,
) -> None:
    unread, total = counts(conn)
    now = int(time.time())
    if (
        not force
        and state.get("counts") == (unread, total)
        and now - state.get("written", 0) < 30
    ):
        return

    payload = {
        "version": 1,
        "unread": unread,
        "total": total,
        "updated": now,
    }
    target = data_dir / "status.json"
    temporary = data_dir / f".status-{os.getpid()}.tmp"
    try:
        temporary.write_text(json.dumps(payload), encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
        state["counts"] = (unread, total)
        state["written"] = now
    except OSError as exc:
        log(f"cannot write {target}: {exc}")
        try:
            temporary.unlink()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# main loop


def acquire_lock(data_dir: Path):
    handle = open(data_dir / ".collector.lock", "a+")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        return None
    return handle


def run(args) -> int:
    os.umask(0o077)
    data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
    config_path = Path(args.config) if args.config else default_config_path()
    spool_dir, failed_dir = ensure_dirs(data_dir)
    cleanup_failed(failed_dir)

    lock = acquire_lock(data_dir)
    if lock is None:
        log("another collector is already running; exiting")
        return 0

    conn = open_db(data_dir)
    config = load_config(config_path, args.verbose)
    state: dict = {}
    last_prune = 0

    stop_event = threading.Event()

    def stop(signum, frame):
        stop_event.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    if args.verbose:
        log(f"data dir: {data_dir}")
        log(f"database: {data_dir / 'notifications.db'}")
        log(f"spool:    {spool_dir}")
        log(f"config:   {config_path}")

    if args.once:
        prune(conn, config)
        drained = drain_once(conn, spool_dir, failed_dir, config, args.verbose)
        write_status(conn, data_dir, state, force=True)
        if args.verbose:
            log(f"one-shot drain complete: {drained} file(s)")
        conn.close()
        lock.close()
        return 0

    log("collector started")
    while not stop_event.is_set():
        try:
            now = int(time.time())
            if now - last_prune > 3600:
                config = load_config(config_path, args.verbose)
                prune(conn, config)
                cleanup_failed(failed_dir)
                last_prune = now
            drained = drain_once(conn, spool_dir, failed_dir, config, args.verbose)
            if drained:
                config = load_config(config_path, args.verbose)
            write_status(conn, data_dir, state)
        except sqlite3.Error as exc:
            log(f"database error: {exc}")
        except Exception:
            log("unexpected error:\n" + traceback.format_exc())
        stop_event.wait(max(0.5, args.poll))

    log("collector stopped")
    conn.close()
    lock.close()
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Notification Center collector")
    parser.add_argument("--data-dir", help="override the data directory")
    parser.add_argument("--config", help="override the config file path")
    parser.add_argument("--once", action="store_true", help="drain once and exit")
    parser.add_argument(
        "--poll", type=float, default=2.0, help="seconds between spool scans"
    )
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
