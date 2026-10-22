#!/usr/bin/env python3
"""Unit tests for notify-center-collector.

Run from the repository root with:
    python3 -m unittest discover -s tests -p 'test_*.py' -v
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stderr
from pathlib import Path

HERE = Path(__file__).resolve().parent
COLLECTOR_PATH = HERE.parent / "collector" / "notify-center-collector.py"

spec = importlib.util.spec_from_file_location("notify_center_collector", COLLECTOR_PATH)
collector = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(collector)


class CollectorTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="notify-center-test-")
        root = Path(self._tmp.name)
        self.data = root / "data"
        self.config_dir = root / "config"
        self.data.mkdir()
        self.config_dir.mkdir()
        self.spool = self.data / "spool"
        self.failed = self.data / "failed"
        self.config_path = self.config_dir / "config.json"
        self.config = {
            "retention_days": 30,
            "max_rows": 5000,
            "ignore_transient": True,
            "ignore_apps": [],
            "persistent_apps": [],
            "persistent_categories": [],
        }
        self.write_config()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    # -- helpers ---------------------------------------------------------

    def write_config(self, **overrides) -> None:
        config = dict(self.config)
        config.update(overrides)
        self.config_path.write_text(json.dumps(config), encoding="utf-8")

    def record(self, **overrides) -> dict:
        record = {
            "v": 2,
            "session": "session-1",
            "source_id": 1,
            "is_update": False,
            "app": "Thunderbird",
            "desktop_entry": "thunderbird.desktop",
            "title": "New email",
            "body": "Hello",
            "category": "email.arrived",
            "urgency": 1,
            "transient": False,
            "icon": "mail-unread",
            "actions": ["default"],
            "hints": {"category": "email.arrived", "urgency": 1},
            "timestamp": int(time.time()),
        }
        record.update(overrides)
        return record

    def write_spool(self, name: str, payload) -> Path:
        path = self.spool / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(payload, str):
            path.write_text(payload, encoding="utf-8")
        else:
            path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def run_once(self) -> int:
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            code = collector.main(
                [
                    "--once",
                    "--data-dir",
                    str(self.data),
                    "--config",
                    str(self.config_path),
                ]
            )
        self.assertEqual(code, 0, stderr.getvalue())
        return code

    def open_db(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.data / "notifications.db")
        conn.row_factory = sqlite3.Row
        return conn

    def rows(self) -> list[sqlite3.Row]:
        conn = self.open_db()
        try:
            return conn.execute(
                "SELECT * FROM notifications ORDER BY id"
            ).fetchall()
        finally:
            conn.close()

    def status(self) -> dict:
        return json.loads((self.data / "status.json").read_text(encoding="utf-8"))

    # -- tests -----------------------------------------------------------

    def test_inserts_notification_and_updates_status(self) -> None:
        self.write_spool("001.json", self.record())
        self.run_once()

        rows = self.rows()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["app"], "Thunderbird")
        self.assertEqual(row["title"], "New email")
        self.assertEqual(row["body"], "Hello")
        self.assertEqual(row["desktop_entry"], "thunderbird.desktop")
        self.assertEqual(row["urgency"], 1)
        self.assertIsNone(row["read_at"])

        status = self.status()
        self.assertEqual(status["unread"], 1)
        self.assertEqual(status["total"], 1)
        self.assertEqual(list(self.spool.glob("*.json")), [])

    def test_replacement_updates_existing_row(self) -> None:
        self.write_spool("001.json", self.record())
        self.run_once()
        self.write_spool(
            "002.json",
            self.record(
                is_update=True,
                title="New email (updated)",
                body="Updated body",
                urgency=2,
                timestamp=int(time.time()) + 1,
            ),
        )
        self.run_once()

        rows = self.rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["title"], "New email (updated)")
        self.assertEqual(rows[0]["body"], "Updated body")
        self.assertEqual(rows[0]["urgency"], 2)

    def test_transient_is_filtered_by_default(self) -> None:
        self.write_spool("001.json", self.record(transient=True, app="Spotify"))
        self.run_once()
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.status()["total"], 0)
        self.assertEqual(list(self.spool.glob("*.json")), [])

    def test_transient_can_be_kept(self) -> None:
        self.write_config(ignore_transient=False)
        self.write_spool("001.json", self.record(transient=True))
        self.run_once()
        self.assertEqual(len(self.rows()), 1)

    def test_ignored_app_is_filtered(self) -> None:
        self.write_config(ignore_apps=["Noisy"])
        self.write_spool(
            "001.json", self.record(app="Noisy", desktop_entry="noisy.desktop")
        )
        self.run_once()
        self.assertEqual(self.rows(), [])

    def test_same_spool_key_is_not_applied_twice(self) -> None:
        self.write_spool("001.json", self.record())
        self.run_once()
        self.assertEqual(len(self.rows()), 1)

        # Simulate a crash between commit and unlink: the same file reappears.
        self.write_spool("001.json", self.record(title="Should be ignored"))
        self.run_once()
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["title"], "New email")

    def test_malformed_spool_file_is_quarantined(self) -> None:
        self.write_spool("bad.json", "{not json")
        self.run_once()
        self.assertEqual(self.rows(), [])
        self.assertEqual(list(self.spool.glob("*.json")), [])
        self.assertEqual(len(list((self.data / "failed").glob("*.json"))), 1)

    def test_retention_prunes_old_rows(self) -> None:
        self.write_config(retention_days=30)
        self.write_spool(
            "old.json", self.record(timestamp=int(time.time()) - 40 * 86400)
        )
        self.run_once()  # prune runs before the drain; the old row is inserted
        self.assertEqual(len(self.rows()), 1)
        self.run_once()  # now prune sees it and removes it
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.status()["total"], 0)

    def test_max_rows_prunes_oldest(self) -> None:
        now = int(time.time())
        for index in range(105):
            self.write_spool(
                f"{index:03d}.json",
                self.record(
                    source_id=index + 1,
                    title=f"Notification {index}",
                    timestamp=now - (105 - index),
                ),
            )
        self.write_config(max_rows=100)
        self.run_once()
        self.run_once()
        rows = self.rows()
        self.assertEqual(len(rows), 100)
        self.assertEqual(rows[-1]["title"], "Notification 104")

    def test_old_failed_files_are_cleaned(self) -> None:
        failed = self.data / "failed"
        failed.mkdir(parents=True, exist_ok=True)
        old = failed / "old.json"
        old.write_text("{}", encoding="utf-8")
        old_time = time.time() - 8 * 86400
        os.utime(old, (old_time, old_time))
        self.write_spool("001.json", self.record())
        self.run_once()
        self.assertFalse(old.exists())

    def test_hints_are_sanitized(self) -> None:
        self.write_spool(
            "001.json",
            self.record(
                hints={
                    "category": "email.arrived",
                    "urgency": 1,
                    "image-data": "binary",
                    "image_data": "binary",
                    "string-hint": "value",
                    "nested": {"drop": "me"},
                }
            ),
        )
        self.run_once()
        row = self.rows()[0]
        hints = json.loads(row["hints"])
        self.assertEqual(hints["string-hint"], "value")
        self.assertNotIn("image-data", hints)
        self.assertNotIn("image_data", hints)
        self.assertNotIn("nested", hints)

    def test_bad_timestamp_falls_back_to_now(self) -> None:
        self.write_spool("001.json", self.record(timestamp=0))
        self.run_once()
        received = self.rows()[0]["received_at"]
        self.assertGreater(received, int(time.time()) - 60)

    def test_missing_config_uses_defaults(self) -> None:
        self.config_path.unlink()
        self.write_spool("001.json", self.record())
        self.run_once()
        self.assertEqual(len(self.rows()), 1)

    def test_newer_schema_is_rejected(self) -> None:
        self.write_spool("001.json", self.record())
        self.run_once()
        conn = self.open_db()
        try:
            conn.execute("PRAGMA user_version=99")
            conn.commit()
        finally:
            conn.close()
        with self.assertRaises(RuntimeError):
            collector.open_db(self.data)


if __name__ == "__main__":
    unittest.main(verbosity=2)
