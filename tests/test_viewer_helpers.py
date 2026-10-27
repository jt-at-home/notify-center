#!/usr/bin/env python3
"""Tests for the viewer's pure helpers and read-only DB access.

These do not open a window. GTK is still imported because the viewer pins GTK 3
at import time; if the bindings are unavailable the whole module is skipped.
"""

from __future__ import annotations

import importlib.util
import io
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
VIEWER_PATH = HERE.parent / "viewer" / "notify-center-viewer.py"


def load_viewer_module():
    try:
        import gi

        gi.require_version("Gtk", "3.0")
        from gi.repository import Gtk  # noqa: F401
    except Exception as exc:  # pragma: no cover - depends on the host
        raise unittest.SkipTest(f"GTK 3 Python bindings unavailable: {exc}")

    spec = importlib.util.spec_from_file_location("notify_center_viewer", VIEWER_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class ViewerHelpersTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="notify-center-viewer-test-")
        previous = os.environ.get("XDG_DATA_HOME")
        os.environ["XDG_DATA_HOME"] = cls.tmp
        try:
            cls.module = load_viewer_module()
        finally:
            if previous is None:
                os.environ.pop("XDG_DATA_HOME", None)
            else:
                os.environ["XDG_DATA_HOME"] = previous
        cls.module.DATA_DIR.mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_escape_like(self) -> None:
        self.assertEqual(
            self.module.escape_like("50%_off\\"), "50\\%\\_off\\\\"
        )

    def test_preview_collapses_whitespace(self) -> None:
        self.assertEqual(self.module.preview("a\n\nb\tc"), "a b c")

    def test_preview_truncates(self) -> None:
        text = self.module.preview("x" * 500, limit=20)
        self.assertEqual(len(text), 21)
        self.assertTrue(text.endswith("…"))

    def test_plain_unescapes_html(self) -> None:
        self.assertEqual(self.module.plain("&amp; &lt;b&gt;"), "& <b>")

    def test_fmt_timestamp_today(self) -> None:
        self.assertRegex(
            self.module.fmt_timestamp(int(time.time())), r"^\d{2}:\d{2}$"
        )

    def test_open_readonly_missing_database(self) -> None:
        self.module.DB_PATH.unlink(missing_ok=True)
        self.assertIsNone(self.module.open_readonly())

    def test_open_readonly_reads_existing_database(self) -> None:
        self.module.DB_PATH.unlink(missing_ok=True)
        conn = sqlite3.connect(self.module.DB_PATH)
        conn.execute(
            "CREATE TABLE notifications "
            "(id INTEGER PRIMARY KEY, app TEXT, title TEXT, body TEXT, "
            "category TEXT, urgency INTEGER, received_at INTEGER, read_at INTEGER)"
        )
        conn.execute(
            "INSERT INTO notifications (app, title, body, received_at) "
            "VALUES ('App', 'Title', 'Body', ?)",
            (int(time.time()),),
        )
        conn.commit()
        conn.close()

        readonly = self.module.open_readonly()
        self.assertIsNotNone(readonly)
        assert readonly is not None
        try:
            count = readonly.execute("SELECT COUNT(*) FROM notifications").fetchone()[0]
        finally:
            readonly.close()
        self.assertEqual(count, 1)

    def test_urgency_name_distinguishes_low(self) -> None:
        self.assertEqual(self.module.urgency_name(0), "Low")
        self.assertEqual(self.module.urgency_name(1), "Normal")
        self.assertEqual(self.module.urgency_name(2), "Critical")

    def test_urgency_name_tolerates_missing_and_bad_values(self) -> None:
        for value in (None, "", "not-a-number"):
            self.assertEqual(self.module.urgency_name(value), "Normal")
        self.assertEqual(self.module.urgency_name("0"), "Low")
        self.assertEqual(self.module.urgency_name(9), "Normal")

    def test_unread_count_counts_only_unread_rows(self) -> None:
        self.module.DB_PATH.unlink(missing_ok=True)
        conn = sqlite3.connect(self.module.DB_PATH)
        conn.execute(
            "CREATE TABLE notifications (id INTEGER PRIMARY KEY, read_at INTEGER)"
        )
        conn.executemany(
            "INSERT INTO notifications (read_at) VALUES (?)",
            [(None,), (None,), (int(time.time()),)],
        )
        conn.commit()
        conn.close()

        readonly = self.module.open_readonly()
        self.assertIsNotNone(readonly)
        assert readonly is not None
        try:
            self.assertEqual(self.module.unread_count(readonly), 2)
        finally:
            readonly.close()

    def test_open_readonly_reports_unreadable_database(self) -> None:
        self.module.DB_PATH.unlink(missing_ok=True)
        self.module.DB_PATH.mkdir()
        try:
            with self.assertRaises(self.module.DatabaseUnavailable):
                self.module.open_readonly()
        finally:
            self.module.DB_PATH.rmdir()

    def test_version_flag(self) -> None:
        output = io.StringIO()
        with redirect_stdout(output):
            code = self.module.main(["notify-center-viewer", "--version"])
        self.assertEqual(code, 0)
        self.assertIn(self.module.APP_VERSION, output.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
