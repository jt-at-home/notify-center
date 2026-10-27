#!/usr/bin/env python3
"""Notification Center viewer.

Reads the SQLite database maintained by notify-center-collector. The viewer can
mark notifications read/unread, delete them, search, filter and export.

GTK 3 is pinned deliberately: Mint 22.3 / Cinnamon 6.6 is a GTK 3 desktop, and
both GTK 3 and GTK 4 typelibs are normally installed, so without an explicit
version PyGObject would load GTK 4 and this GTK 3 code would crash.
"""

from __future__ import annotations

import html
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gio, GLib, Gtk, Pango  # noqa: E402

APP_NAME = "notify-center"
ALL_APPS = "All apps"
ALL_CATEGORIES = "All categories"
UNCATEGORIZED = "Uncategorized"
ROW_LIMIT = 1000
URGENCY_NAMES = {0: "Low", 1: "Normal", 2: "Critical"}
DB_MISSING_ERROR = "database not created yet"
COLLECTOR_SERVICE = "notify-center-collector.service"
START_PENDING_SECONDS = 45
APP_VERSION = "1.2.1"
PROJECT_URL = "https://github.com/jt-at-home/notify-center"


def data_dir() -> Path:
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / APP_NAME


def config_dir() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / APP_NAME


DATA_DIR = data_dir()
DB_PATH = DATA_DIR / "notifications.db"
STATUS_PATH = DATA_DIR / "status.json"
CONFIG_PATH = config_dir() / "config.json"

# Written on first use so the Settings button works on a clean install.
DEFAULT_CONFIG = {
    "retention_days": 30,
    "max_rows": 5000,
    "ignore_transient": True,
    "ignore_apps": [],
    "persistent_apps": [],
    "persistent_categories": [],
    "dismiss_after_capture": False,
    "toast_enabled": False,
    "toast_timeout": 5,
    "toast_position": "top-right",
    "sound_enabled": False,
    "sound_file": "",
}


def ensure_config_file() -> Path:
    """Create the config file with defaults if it does not exist yet."""
    if CONFIG_PATH.exists():
        return CONFIG_PATH

    directory = CONFIG_PATH.parent
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    CONFIG_PATH.write_text(
        json.dumps(DEFAULT_CONFIG, indent=2) + "\n", encoding="utf-8"
    )
    os.chmod(CONFIG_PATH, 0o600)
    return CONFIG_PATH


# ---------------------------------------------------------------------------
# helpers


def fmt_timestamp(value) -> str:
    try:
        stamp = datetime.fromtimestamp(int(value))
    except (TypeError, ValueError, OSError, OverflowError):
        return ""
    if stamp.date() == datetime.now().date():
        return stamp.strftime("%H:%M")
    return stamp.strftime("%b %d %H:%M")


def preview(text: str, limit: int = 160) -> str:
    text = " ".join((text or "").split())
    if len(text) > limit:
        return text[:limit].rstrip() + "…"
    return text


def escape_like(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def urgency_name(value) -> str:
    """Return the label for a stored urgency (0 = Low, 1 = Normal, 2 = Critical).

    Urgency 0 is falsy, so it must not be coalesced with 1 while normalizing.
    """
    try:
        urgency = 1 if value is None else int(value)
    except (TypeError, ValueError):
        return URGENCY_NAMES[1]
    return URGENCY_NAMES.get(urgency, URGENCY_NAMES[1])


class DatabaseUnavailable(RuntimeError):
    """The database file exists but could not be opened for reading."""


def open_readonly() -> sqlite3.Connection | None:
    """Open the database read-only, or None when it has not been created yet."""
    if not DB_PATH.exists():
        return None
    conn = None
    try:
        conn = sqlite3.connect(
            f"file:{DB_PATH}?mode=ro", uri=True, timeout=5
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000")
    except sqlite3.Error as exc:
        if conn is not None:
            conn.close()
        raise DatabaseUnavailable(str(exc)) from exc
    return conn


def unread_count(conn: sqlite3.Connection) -> int:
    return conn.execute(
        "SELECT COUNT(*) FROM notifications WHERE read_at IS NULL"
    ).fetchone()[0]


def open_write() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    conn = sqlite3.connect(str(DB_PATH), timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def read_status() -> dict | None:
    try:
        return json.loads(STATUS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def plain(text: str) -> str:
    return html.unescape(text or "")


# ---------------------------------------------------------------------------
# application


class ViewerApplication(Gtk.Application):
    def __init__(self, self_test: bool = False):
        application_id = (
            "org.notifycenter.Viewer.SelfTest"
            if self_test
            else "org.notifycenter.Viewer"
        )
        super().__init__(
            application_id=application_id,
            flags=Gio.ApplicationFlags.FLAGS_NONE,
        )
        self.self_test = self_test
        self.window: MainWindow | None = None
        self.failed = False

    def do_activate(self) -> None:
        if self.window is None:
            self.window = MainWindow(self)
        if self.self_test:
            GLib.timeout_add(300, self._finish_self_test)
        else:
            self.window.show_all()
            self.window.present()

    def _finish_self_test(self) -> bool:
        window = self.window
        error = window._db_error if window else None
        if error and error != DB_MISSING_ERROR:
            self.failed = True
            print(f"viewer self-test FAILED: {error}", file=sys.stderr)
            self.quit()
            return False

        count = len(window.store) if window else 0
        if window is not None and count:
            try:
                # Exercise the real SQL filters without writing anything.
                term = window.store[0][2].split()[0][:20]
                window.search_entry.set_text(term)
                if window._search_timeout:
                    GLib.source_remove(window._search_timeout)
                    window._search_timeout = 0
                window._reload()
                if len(window.store) == 0:
                    raise AssertionError(f"search for {term!r} returned no rows")
                window.search_entry.set_text("")
                if window._search_timeout:
                    GLib.source_remove(window._search_timeout)
                    window._search_timeout = 0
                window.unread_toggle.set_active(True)
                window._reload()
                if any(row[7] != "●" for row in window.store):
                    raise AssertionError("unread-only filter returned a read row")
                window.unread_toggle.set_active(False)
                window._reload()
            except Exception as exc:  # pragma: no cover - GUI self-test
                self.failed = True
                print(f"viewer self-test FAILED: {exc}", file=sys.stderr)
                self.quit()
                return False

        print(f"viewer self-test OK ({count} row(s))")
        self.quit()
        return False


class MainWindow(Gtk.ApplicationWindow):
    def __init__(self, app: ViewerApplication):
        super().__init__(application=app, title="Notification Center")
        self.set_default_size(1100, 700)
        self.set_icon_name("dialog-information")
        self._loading = False
        self._selected_ids: list[int] = []
        self.selected_id: int | None = None
        self._db_error: str | None = None
        self._search_timeout = 0
        self._reload_timeout = 0
        self._status_monitor = None
        self._last_reload = 0.0
        self._list_info_base = ""
        self._unread_total: int | None = None
        self._start_pending_until = 0.0

        self._build_ui()
        self._connect_monitors()
        self._reload(initial=True)
        self._start_timers()

    # -- UI ---------------------------------------------------------------

    def _build_ui(self) -> None:
        header = Gtk.HeaderBar()
        header.set_show_close_button(True)
        header.set_title("Notification Center")
        self.set_titlebar(header)

        self.search_entry = Gtk.SearchEntry()
        self.search_entry.set_placeholder_text("Search app, title or body…")
        self.search_entry.set_width_chars(30)
        self.search_entry.connect("search-changed", self._on_search_changed)
        header.pack_start(self.search_entry)

        export_button = Gtk.Button(label="Export")
        export_button.set_tooltip_text("Export the current view as JSON")
        export_button.connect("clicked", self._export)
        header.pack_end(export_button)

        clear_button = Gtk.Button(label="Clear all")
        clear_button.set_tooltip_text("Delete every notification from history")
        clear_button.connect("clicked", self._clear_all)
        header.pack_end(clear_button)

        settings_button = Gtk.Button(label="Settings")
        settings_button.set_tooltip_text("Open the notification-center config file")
        settings_button.connect("clicked", self._open_config)
        header.pack_end(settings_button)

        about_button = Gtk.Button(label="About")
        about_button.set_tooltip_text("About Notification Center")
        about_button.connect("clicked", self._on_about)
        header.pack_end(about_button)

        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.add(outer)

        filters = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        filters.set_border_width(6)
        self.app_filter = Gtk.ComboBoxText()
        self.app_filter.append_text(ALL_APPS)
        self.app_filter.set_active(0)
        self.app_filter.set_tooltip_text("Filter by application")
        self._app_handler = self.app_filter.connect("changed", self._on_filter_changed)
        filters.pack_start(self.app_filter, False, False, 0)

        self.category_filter = Gtk.ComboBoxText()
        self.category_filter.append_text(ALL_CATEGORIES)
        self.category_filter.set_active(0)
        self.category_filter.set_tooltip_text("Filter by notification category")
        self._category_handler = self.category_filter.connect(
            "changed", self._on_filter_changed
        )
        filters.pack_start(self.category_filter, False, False, 0)

        self.unread_toggle = Gtk.ToggleButton(label="Unread only")
        self.unread_toggle.connect("toggled", self._on_filter_changed)
        filters.pack_start(self.unread_toggle, False, False, 0)

        filters.pack_start(Gtk.Separator(orientation=Gtk.Orientation.VERTICAL), False, False, 4)

        self.mark_read_button = Gtk.Button(label="Mark read")
        self.mark_read_button.connect("clicked", self._mark_read)
        filters.pack_start(self.mark_read_button, False, False, 0)

        self.mark_unread_button = Gtk.Button(label="Mark unread")
        self.mark_unread_button.connect("clicked", self._mark_unread)
        filters.pack_start(self.mark_unread_button, False, False, 0)

        self.delete_button = Gtk.Button(label="Delete")
        self.delete_button.connect("clicked", self._delete_selected)
        filters.pack_start(self.delete_button, False, False, 0)

        self.mark_all_button = Gtk.Button(label="Mark all read")
        self.mark_all_button.set_tooltip_text("Mark every unread notification as read")
        self.mark_all_button.connect("clicked", self._mark_all_read)
        filters.pack_start(self.mark_all_button, False, False, 0)

        refresh_button = Gtk.Button(label="Refresh")
        refresh_button.connect("clicked", lambda *_: self._reload())
        filters.pack_end(refresh_button, False, False, 0)

        outer.pack_start(filters, False, False, 0)

        paned = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        paned.set_position(800)
        outer.pack_start(paned, True, True, 0)

        # List ------------------------------------------------------------
        self.store = Gtk.ListStore(int, str, str, str, str, str, str, str, int)
        self.tree = Gtk.TreeView(model=self.store)
        self.tree.set_headers_visible(True)
        self.tree.get_selection().set_mode(Gtk.SelectionMode.MULTIPLE)
        self.tree.get_selection().connect("changed", self._on_selection_changed)
        self.tree.connect("row-activated", self._on_row_activated)

        # Category and urgency live in the detail pane; keeping the list to
        # these five columns lets "Received" fit without horizontal scrolling.
        columns = [
            ("", 7, 22, None),
            ("App", 1, 130, None),
            ("Title", 2, 200, None),
            ("Preview", 3, 270, "preview"),
            ("Received", 6, 115, None),
        ]
        for title, index, width, mode in columns:
            renderer = Gtk.CellRendererText()
            renderer.set_property("ellipsize", Pango.EllipsizeMode.END)
            renderer.set_property("ellipsize-set", True)
            if mode == "preview":
                renderer.set_property("foreground", "#888888")
            column = Gtk.TreeViewColumn(title, renderer, text=index, weight=8)
            column.set_resizable(True)
            column.set_min_width(width)
            column.set_sizing(Gtk.TreeViewColumnSizing.AUTOSIZE)
            self.tree.append_column(column)

        scroller = Gtk.ScrolledWindow()
        scroller.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        scroller.add(self.tree)

        self.list_overlay = Gtk.Overlay()
        self.list_overlay.add(scroller)
        self.empty_label = Gtk.Label(label="No notifications yet.")
        self.empty_label.set_justify(Gtk.Justification.CENTER)
        self.empty_label.set_halign(Gtk.Align.CENTER)
        self.empty_label.set_valign(Gtk.Align.CENTER)
        self.empty_label.set_no_show_all(True)
        self.empty_label.get_style_context().add_class("dim-label")
        self.list_overlay.add_overlay(self.empty_label)
        paned.pack1(self.list_overlay, True, False)

        # Detail ----------------------------------------------------------
        detail_scroller = Gtk.ScrolledWindow()
        detail_scroller.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        detail_scroller.set_size_request(320, -1)
        detail_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        detail_box.set_border_width(12)

        self.detail_app = Gtk.Label(label="")
        self.detail_app.set_xalign(0)
        self.detail_app.get_style_context().add_class("dim-label")
        detail_box.pack_start(self.detail_app, False, False, 0)

        self.detail_title = Gtk.Label(label="No notification selected")
        self.detail_title.set_xalign(0)
        self.detail_title.set_line_wrap(True)
        self.detail_title.set_selectable(True)
        detail_box.pack_start(self.detail_title, False, False, 0)

        self.detail_meta = Gtk.Label(label="")
        self.detail_meta.set_xalign(0)
        self.detail_meta.set_line_wrap(True)
        self.detail_meta.set_selectable(True)
        self.detail_meta.get_style_context().add_class("dim-label")
        detail_box.pack_start(self.detail_meta, False, False, 0)

        detail_box.pack_start(
            Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 0
        )

        body_scroller = Gtk.ScrolledWindow()
        body_scroller.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        body_scroller.set_min_content_height(220)
        self.body_view = Gtk.TextView()
        self.body_view.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
        self.body_view.set_editable(False)
        self.body_view.set_cursor_visible(False)
        self.body_view.set_left_margin(8)
        self.body_view.set_right_margin(8)
        self.body_view.set_top_margin(8)
        self.body_view.set_bottom_margin(8)
        body_scroller.add(self.body_view)
        detail_box.pack_start(body_scroller, True, True, 0)

        detail_scroller.add(detail_box)
        paned.pack2(detail_scroller, False, False)

        # Status bar ------------------------------------------------------
        status_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        status_bar.set_border_width(6)
        self.list_info = Gtk.Label(label="")
        self.list_info.set_xalign(0)
        self.list_info.get_style_context().add_class("dim-label")
        status_bar.pack_start(self.list_info, True, True, 0)
        self.start_collector_button = Gtk.Button(label="Start collector")
        self.start_collector_button.set_relief(Gtk.ReliefStyle.NONE)
        self.start_collector_button.set_tooltip_text(
            "Start the notification history collector"
        )
        self.start_collector_button.connect("clicked", self._on_start_collector)
        self.start_collector_button.set_no_show_all(True)
        status_bar.pack_end(self.start_collector_button, False, False, 0)
        self.collector_info = Gtk.Label(label="")
        self.collector_info.set_xalign(1)
        self.collector_info.get_style_context().add_class("dim-label")
        status_bar.pack_end(self.collector_info, False, False, 0)
        outer.pack_start(status_bar, False, False, 0)

        self.connect("key-press-event", self._on_key_press)
        self.connect("focus-in-event", self._on_focus_in)
        self._set_actions_sensitive(False)

    # -- data -------------------------------------------------------------

    def _current_filters(self) -> tuple[str, str, bool]:
        app = self.app_filter.get_active_text() or ALL_APPS
        category = self.category_filter.get_active_text() or ALL_CATEGORIES
        return app, category, self.unread_toggle.get_active()

    def _where(self) -> tuple[str, list]:
        app, category, unread_only = self._current_filters()
        clauses: list[str] = []
        params: list = []
        if app != ALL_APPS:
            clauses.append("app = ?")
            params.append(app)
        if category == UNCATEGORIZED:
            clauses.append("(category IS NULL OR category = '')")
        elif category != ALL_CATEGORIES:
            clauses.append("category = ?")
            params.append(category)
        if unread_only:
            clauses.append("read_at IS NULL")
        term = self.search_entry.get_text().strip()
        if term:
            like = f"%{escape_like(term)}%"
            clauses.append(
                "(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' "
                "OR app LIKE ? ESCAPE '\\')"
            )
            params.extend([like, like, like])
        if not clauses:
            return "", params
        return " WHERE " + " AND ".join(clauses), params

    def _reload(self, initial: bool = False) -> None:
        if self._loading:
            return
        self._loading = True
        try:
            selected = None if initial else self.selected_id
            apps: list[str] = []
            categories: list[str] = []
            rows: list[sqlite3.Row] = []
            filtered_total = 0
            unread_total: int | None = None
            db_error = None

            conn = None
            try:
                conn = open_readonly()
            except DatabaseUnavailable as exc:
                db_error = str(exc)

            if conn is not None:
                try:
                    apps = [
                        row[0]
                        for row in conn.execute(
                            "SELECT DISTINCT app FROM notifications "
                            "WHERE app <> '' ORDER BY app COLLATE NOCASE"
                        )
                    ]
                    categories = [
                        row[0]
                        for row in conn.execute(
                            "SELECT DISTINCT category FROM notifications "
                            "WHERE category IS NOT NULL AND category <> '' "
                            "ORDER BY category COLLATE NOCASE"
                        )
                    ]
                    uncategorized = conn.execute(
                        "SELECT COUNT(*) FROM notifications "
                        "WHERE category IS NULL OR category = ''"
                    ).fetchone()[0]
                    if uncategorized:
                        categories.append(UNCATEGORIZED)
                    # Refresh the filter values first: if the currently
                    # selected app/category disappeared, _where() must see the
                    # reset selection instead of querying the stale one.
                    self._refresh_filters(apps, categories)
                    where, params = self._where()
                    filtered_total = conn.execute(
                        "SELECT COUNT(*) FROM notifications" + where, params
                    ).fetchone()[0]
                    unread_total = unread_count(conn)
                    rows = [
                        row
                        for row in conn.execute(
                            "SELECT id, app, title, body, category, urgency, received_at, "
                            "read_at FROM notifications"
                            + where
                            + " ORDER BY received_at DESC, id DESC LIMIT ?",
                            params + [ROW_LIMIT],
                        )
                    ]
                except sqlite3.Error as exc:
                    db_error = str(exc)
                    apps, categories, rows, filtered_total = [], [], [], 0
                    unread_total = None
                finally:
                    conn.close()
            elif db_error is None:
                db_error = DB_MISSING_ERROR

            self._db_error = db_error
            self._unread_total = unread_total

            self.store.clear()
            for row in rows:
                unread = row["read_at"] is None
                self.store.append(
                    [
                        int(row["id"]),
                        row["app"] or "Unknown",
                        plain(row["title"]) or "(no title)",
                        preview(plain(row["body"])),
                        row["category"] or "—",
                        urgency_name(row["urgency"]),
                        fmt_timestamp(row["received_at"]),
                        "●" if unread else "",
                        700 if unread else 400,
                    ]
                )

            if selected is not None:
                self._select_id(selected)
            elif initial and len(self.store) > 0:
                # Open with the newest notification selected so the detail
                # pane is useful immediately.
                self._select_id(int(self.store[0][0]), scroll=True)
            else:
                self.tree.get_selection().unselect_all()
                self._update_detail()

            shown = len(self.store)
            if db_error == DB_MISSING_ERROR:
                self._list_info_base = "No database yet"
                self.empty_label.set_text(
                    "No notification database yet.\n"
                    "The collector has not run, or it failed to start.\n\n"
                    "Try: systemctl --user start notify-center-collector"
                )
            elif db_error:
                self._list_info_base = "Database unavailable"
                self.empty_label.set_text(
                    "Cannot read the notification database.\n\n" + db_error
                )
            else:
                self._list_info_base = (
                    f"{shown} of {filtered_total} notifications"
                    + (
                        " (limited to %d)" % ROW_LIMIT
                        if filtered_total > ROW_LIMIT
                        else ""
                    )
                )
                if shown == 0:
                    if self.search_entry.get_text().strip() or self._current_filters() != (
                        ALL_APPS,
                        ALL_CATEGORIES,
                        False,
                    ):
                        self.empty_label.set_text(
                            "No notifications match these filters."
                        )
                    else:
                        self.empty_label.set_text("No notifications yet.")
            self._update_empty_state()
            self._update_status()
            self._set_actions_sensitive(bool(self._selected_ids))
            self._last_reload = time.monotonic()
        finally:
            self._loading = False

    def _refresh_filters(self, apps: list[str], categories: list[str]) -> None:
        for combo, handler, values, all_label in (
            (self.app_filter, self._app_handler, apps, ALL_APPS),
            (self.category_filter, self._category_handler, categories, ALL_CATEGORIES),
        ):
            wanted = [all_label] + list(values)
            model = combo.get_model()
            existing = [row[0] for row in model] if model is not None else []
            if existing == wanted:
                # Rebuilding the combo closes its popup and steals focus, so
                # leave it alone while the set of values is unchanged.
                continue
            current = combo.get_active_text() or all_label
            combo.handler_block(handler)
            combo.remove_all()
            for value in wanted:
                combo.append_text(value)
            target = 0
            for index, row in enumerate(combo.get_model()):
                if row[0] == current:
                    target = index
                    break
            combo.set_active(target)
            combo.handler_unblock(handler)

    def _select_id(self, notification_id: int, scroll: bool = False) -> None:
        for row in self.store:
            if row[0] == notification_id:
                self.tree.get_selection().unselect_all()
                self.tree.get_selection().select_iter(row.iter)
                if scroll:
                    self.tree.scroll_to_cell(row.path, None, False, 0, 0)
                return
        self.tree.get_selection().unselect_all()
        self.selected_id = None
        self._update_detail()

    def _update_empty_state(self) -> None:
        empty = len(self.store) == 0
        if empty:
            self.empty_label.show()
        else:
            self.empty_label.hide()

    def _set_actions_sensitive(self, sensitive: bool) -> None:
        for button in (self.mark_read_button, self.mark_unread_button, self.delete_button):
            button.set_sensitive(sensitive)

    # -- selection / detail ----------------------------------------------

    def _on_selection_changed(self, selection: Gtk.TreeSelection) -> None:
        model, paths = selection.get_selected_rows()
        self._selected_ids = [int(model[path][0]) for path in paths]
        self.selected_id = self._selected_ids[0] if self._selected_ids else None
        self._set_actions_sensitive(bool(self._selected_ids))
        self._update_detail()

    def _clear_detail(self) -> None:
        self.detail_app.set_text("")
        self.detail_title.set_text("No notification selected")
        self.detail_meta.set_text("")
        self.body_view.get_buffer().set_text("")

    def _update_detail(self) -> None:
        if self.selected_id is None:
            self._clear_detail()
            return

        try:
            conn = open_readonly()
        except DatabaseUnavailable:
            conn = None
        if conn is None:
            self._clear_detail()
            return
        try:
            row = conn.execute(
                "SELECT app, title, body, category, urgency, received_at, "
                "desktop_entry, actions FROM notifications WHERE id = ?",
                (self.selected_id,),
            ).fetchone()
        except sqlite3.Error:
            row = None
        finally:
            conn.close()

        if row is None:
            # The row was deleted (here or by retention) while it was selected.
            self._clear_detail()
            return
        self.detail_app.set_text(row["app"] or "Unknown application")
        title = plain(row["title"]) or "(no title)"
        self.detail_title.set_markup(f"<b>{GLib.markup_escape_text(title)}</b>")
        urgency = urgency_name(row["urgency"])
        meta = [
            row["category"] or UNCATEGORIZED,
            f"urgency: {urgency}",
            fmt_timestamp(row["received_at"]),
        ]
        if row["desktop_entry"]:
            meta.append(f"desktop: {row['desktop_entry']}")
        if row["actions"]:
            try:
                actions = json.loads(row["actions"])
                if isinstance(actions, list) and actions:
                    meta.append("actions: " + ", ".join(str(item) for item in actions))
            except (TypeError, ValueError):
                pass
        self.detail_meta.set_text(" · ".join(meta))
        self.body_view.get_buffer().set_text(plain(row["body"]))

    def _on_row_activated(self, tree, path, column) -> None:
        notification_id = int(tree.get_model()[path][0])
        self._mark_ids([notification_id], read=True)

    # -- actions ----------------------------------------------------------

    def _selected_or_none(self) -> list[int]:
        return list(self._selected_ids)

    def _mark_read(self, *_args) -> None:
        self._mark_ids(self._selected_or_none(), read=True)

    def _mark_unread(self, *_args) -> None:
        self._mark_ids(self._selected_or_none(), read=False)

    def _mark_ids(self, ids: list[int], read: bool) -> None:
        if not ids or not DB_PATH.exists():
            return
        try:
            conn = open_write()
        except sqlite3.Error as exc:
            self._error("Cannot open the database", str(exc))
            return
        try:
            with conn:
                conn.executemany(
                    "UPDATE notifications SET read_at = ? WHERE id = ?",
                    [(int(time.time()) if read else None, notification_id) for notification_id in ids],
                )
        except sqlite3.Error as exc:
            self._error("Cannot update notifications", str(exc))
            return
        finally:
            conn.close()
        self._reload()

    def _mark_all_read(self, *_args) -> None:
        if not DB_PATH.exists():
            return
        try:
            conn = open_write()
        except sqlite3.Error as exc:
            self._error("Cannot open the database", str(exc))
            return
        try:
            with conn:
                conn.execute(
                    "UPDATE notifications SET read_at = ? WHERE read_at IS NULL",
                    (int(time.time()),),
                )
        except sqlite3.Error as exc:
            self._error("Cannot mark notifications as read", str(exc))
            return
        finally:
            conn.close()
        self._reload()

    def _delete_selected(self, *_args) -> None:
        ids = self._selected_or_none()
        if not ids:
            return
        if not self._confirm(
            f"Delete {len(ids)} notification(s)?",
            "This removes them from the history permanently.",
            "Delete",
        ):
            return
        try:
            conn = open_write()
            with conn:
                conn.executemany(
                    "DELETE FROM notifications WHERE id = ?",
                    [(notification_id,) for notification_id in ids],
                )
            conn.close()
        except sqlite3.Error as exc:
            self._error("Cannot delete notifications", str(exc))
            return
        self.selected_id = None
        self._selected_ids = []
        self._reload()

    def _clear_all(self, *_args) -> None:
        if not DB_PATH.exists():
            return
        if not self._confirm(
            "Delete all notifications?",
            "The entire history will be erased. This cannot be undone.",
            "Delete all",
        ):
            return
        try:
            conn = open_write()
            with conn:
                conn.execute("DELETE FROM notifications")
            conn.close()
        except sqlite3.Error as exc:
            self._error("Cannot clear history", str(exc))
            return
        self.selected_id = None
        self._selected_ids = []
        self._reload()

    def _export(self, *_args) -> None:
        chooser = Gtk.FileChooserDialog(
            title="Export notifications",
            transient_for=self,
            action=Gtk.FileChooserAction.SAVE,
        )
        chooser.add_buttons(
            Gtk.STOCK_CANCEL,
            Gtk.ResponseType.CANCEL,
            Gtk.STOCK_SAVE,
            Gtk.ResponseType.OK,
        )
        chooser.set_do_overwrite_confirmation(True)
        chooser.set_current_name(
            f"notifications-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
        )
        json_filter = Gtk.FileFilter()
        json_filter.set_name("JSON files")
        json_filter.add_pattern("*.json")
        chooser.add_filter(json_filter)

        response = chooser.run()
        path = chooser.get_filename()
        chooser.destroy()
        if response != Gtk.ResponseType.OK or not path:
            return

        try:
            conn = open_readonly()
        except DatabaseUnavailable as exc:
            self._error("Cannot open the database", str(exc))
            return
        if conn is None:
            self._error("Nothing to export", "The notification database does not exist yet.")
            return
        try:
            where, params = self._where()
            rows = conn.execute(
                "SELECT id, app, desktop_entry, title, body, category, urgency, "
                "transient, icon, actions, hints, received_at, read_at "
                "FROM notifications" + where + " ORDER BY received_at DESC, id DESC",
                params,
            ).fetchall()
        except sqlite3.Error as exc:
            self._error("Cannot export notifications", str(exc))
            return
        finally:
            conn.close()

        payload = {
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "notifications": [dict(row) for row in rows],
        }
        try:
            Path(path).write_text(
                json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
            )
            os.chmod(path, 0o600)
        except OSError as exc:
            self._error("Cannot write the export file", str(exc))

    def _open_config(self, *_args) -> None:
        try:
            target = ensure_config_file()
        except OSError as exc:
            self._error(
                "Cannot create the config file",
                f"{CONFIG_PATH}\n\n{exc}",
            )
            return
        try:
            subprocess.Popen(["xdg-open", str(target)], close_fds=True)
        except OSError as exc:
            self._error("Cannot open the config file", str(exc))

    def _on_about(self, *_args) -> None:
        about = Gtk.AboutDialog(transient_for=self, modal=True)
        about.set_program_name("Notification Center")
        about.set_version(APP_VERSION)
        about.set_comments("Persistent notification history for Cinnamon")
        about.set_website(PROJECT_URL)
        about.set_website_label("GitHub repository")
        about.set_authors(["jt-at-home"])
        about.set_license_type(Gtk.License.MIT_X11)
        about.set_copyright("Copyright © 2026 jt-at-home")
        about.run()
        about.destroy()

    # -- dialogs ----------------------------------------------------------

    def _confirm(self, text: str, secondary: str, ok_label: str) -> bool:
        dialog = Gtk.MessageDialog(
            transient_for=self,
            flags=Gtk.DialogFlags.MODAL,
            message_type=Gtk.MessageType.WARNING,
            buttons=Gtk.ButtonsType.NONE,
            text=text,
        )
        dialog.format_secondary_text(secondary)
        dialog.add_button(Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL)
        dialog.add_button(ok_label, Gtk.ResponseType.OK)
        dialog.set_default_response(Gtk.ResponseType.CANCEL)
        response = dialog.run()
        dialog.destroy()
        return response == Gtk.ResponseType.OK

    def _error(self, title: str, secondary: str) -> None:
        dialog = Gtk.MessageDialog(
            transient_for=self,
            flags=Gtk.DialogFlags.MODAL,
            message_type=Gtk.MessageType.ERROR,
            buttons=Gtk.ButtonsType.CLOSE,
            text=title,
        )
        dialog.format_secondary_text(secondary)
        dialog.run()
        dialog.destroy()

    # -- status / monitors ------------------------------------------------

    def _update_status(self) -> None:
        status = read_status()
        # The list is the source of truth for unread counts: status.json is
        # only a heartbeat and may be stale, missing, or contradicted by a
        # local mark-read. Fall back to it only while the DB is unreadable.
        unread = self._unread_total
        if unread is None and status:
            try:
                unread = int(status.get("unread") or 0)
            except (TypeError, ValueError):
                unread = 0
        base = getattr(self, "_list_info_base", "") or ""
        if unread:
            base = f"{base} · {unread} unread"
        self.list_info.set_text(base)

        if not status:
            self.collector_info.set_text("Collector: not running")
            self._show_start_button(True)
            return
        try:
            age = max(0, int(time.time()) - int(status.get("updated") or 0))
        except (TypeError, ValueError):
            age = 10**6
        pending = time.monotonic() < self._start_pending_until
        if age > 180 and not pending:
            self.collector_info.set_text("Collector: not running")
            self._show_start_button(True)
        elif age > 180 and pending:
            self.collector_info.set_text("Collector: starting…")
            self._show_start_button(False)
        elif age < 5:
            self.collector_info.set_text("Collector: active just now")
            self._show_start_button(False)
        else:
            self.collector_info.set_text(f"Collector: active {age}s ago")
            self._show_start_button(False)

    def _show_start_button(self, visible: bool) -> None:
        if visible:
            self.start_collector_button.set_sensitive(True)
            self.start_collector_button.set_label("Start collector")
            self.start_collector_button.show()
        else:
            self.start_collector_button.hide()

    def _on_start_collector(self, *_args) -> None:
        self.start_collector_button.set_sensitive(False)
        self.start_collector_button.set_label("Starting…")
        self.collector_info.set_text("Collector: starting…")

        error: str | None = None
        systemctl = shutil.which("systemctl")
        if systemctl:
            try:
                completed = subprocess.run(
                    [systemctl, "--user", "start", COLLECTOR_SERVICE],
                    timeout=15,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                if completed.returncode != 0:
                    error = f"systemctl --user start exited with code {completed.returncode}"
            except (OSError, subprocess.TimeoutExpired) as exc:
                error = str(exc)
        else:
            error = "systemctl was not found on PATH"

        if error is None:
            self._start_pending_until = time.monotonic() + START_PENDING_SECONDS
            self._show_start_button(False)
            return

        # No systemd unit to start (e.g. an install with --no-service or a
        # packaged install without systemd): fall back to a detached process.
        bin_path = shutil.which("notify-center-collector")
        if bin_path is None:
            candidate = Path.home() / ".local" / "bin" / "notify-center-collector"
            if candidate.is_file():
                bin_path = str(candidate)
        if bin_path:
            try:
                subprocess.Popen(
                    [bin_path],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
            except OSError as exc:
                self._start_failed(str(exc))
                return
            self._start_pending_until = time.monotonic() + START_PENDING_SECONDS
            self._show_start_button(False)
            return

        self._start_failed(error or "the collector binary was not found")

    def _start_failed(self, detail: str) -> None:
        self._start_pending_until = 0.0
        self.collector_info.set_text("Collector: not running")
        self._show_start_button(True)
        self._error(
            "Could not start the collector",
            f"{detail}\n\n"
            "Start it manually with:\n"
            "  systemctl --user start notify-center-collector\n"
            "or run it directly:\n"
            "  notify-center-collector &",
        )

    def _connect_monitors(self) -> None:
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
        except OSError:
            pass
        try:
            self._status_monitor = Gio.File.new_for_path(str(DATA_DIR)).monitor_directory(
                Gio.FileMonitorFlags.NONE, None
            )
            self._status_monitor.connect("changed", self._on_dir_changed)
        except GLib.Error:
            self._status_monitor = None

    def _on_dir_changed(self, monitor, file, other_file, event_type) -> None:
        try:
            name = file.get_basename() if file else ""
        except Exception:
            name = ""
        if name == "status.json":
            # The collector rewrites its heartbeat every ~30 s. That is not a
            # data change: refreshing the text is enough, and a full reload
            # would rebuild the filter combos and jump the list scroll.
            self._update_status()
            return
        if name not in ("notifications.db", "notifications.db-wal"):
            return
        if self._reload_timeout:
            GLib.source_remove(self._reload_timeout)
        self._reload_timeout = GLib.timeout_add(400, self._reload_later)

    def _reload_later(self) -> bool:
        self._reload_timeout = 0
        self._reload()
        return False

    def _start_timers(self) -> None:
        GLib.timeout_add_seconds(5, self._tick)
        GLib.timeout_add_seconds(60, self._slow_tick)

    def _tick(self) -> bool:
        self._update_status()
        return True

    def _slow_tick(self) -> bool:
        if time.monotonic() - self._last_reload > 30:
            self._reload()
        return True

    # -- input ------------------------------------------------------------

    def _on_search_changed(self, *_args) -> None:
        if self._search_timeout:
            GLib.source_remove(self._search_timeout)
        self._search_timeout = GLib.timeout_add(300, self._search_fired)

    def _search_fired(self) -> bool:
        self._search_timeout = 0
        self._reload()
        return False

    def _on_filter_changed(self, *_args) -> None:
        if not self._loading:
            self._reload()

    def _on_focus_in(self, *_args) -> bool:
        if time.monotonic() - self._last_reload > 2:
            self._reload()
        return False

    def _on_key_press(self, widget, event) -> bool:
        state = event.state & Gtk.accelerator_get_default_mod_mask()
        ctrl = bool(state & Gdk.ModifierType.CONTROL_MASK)
        key = Gdk.keyval_name(event.keyval) or ""
        lowered = key.lower()

        if self.search_entry.has_focus() and key != "Escape":
            return False
        if ctrl and lowered == "f":
            self.search_entry.grab_focus()
            return True
        if ctrl and lowered == "q":
            app = self.get_application()
            if app:
                app.quit()
            return True
        if ctrl and lowered == "r":
            self._reload()
            return True
        if key == "Escape":
            if self.search_entry.get_text():
                self.search_entry.set_text("")
                return True
            return False
        if key == "Delete":
            self._delete_selected()
            return True
        return False


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv if argv is None else argv)
    if "--version" in argv[1:]:
        print(f"notify-center-viewer {APP_VERSION}")
        return 0
    self_test = "--self-test" in argv[1:]
    app = ViewerApplication(self_test=self_test)
    code = app.run([argv[0]])
    if app.self_test and app.failed:
        return 1
    return code


if __name__ == "__main__":
    raise SystemExit(main())
