# Notification Center for Cinnamon

[![CI](https://github.com/jt-at-home/notify-center/actions/workflows/ci.yml/badge.svg)](https://github.com/jt-at-home/notify-center/actions/workflows/ci.yml)

A persistent notification history for Cinnamon: record every desktop
notification, search it, mark things read, and get an unread badge in the panel.

![Notification Center viewer](docs/viewer.png)

*Screenshot uses temporary demo data.*

---

## What it does

- **Applet** — shows an unread count in the panel. Click it for a menu with
  *Open Notification Center* and *Open configuration file*; middle-click opens
  the viewer directly. If the collector is not running, the icon switches to a
  warning icon and the tooltip explains. With `dismiss_after_capture`, it also
  removes each recorded notification from Cinnamon's own popup and tray.
  Optionally (`toast_enabled`, `sound_enabled`) it can instead show its own
  notification popup and play a sound.
- **Viewer** — search across app, title and body; filter by app, category or
  unread; mark read/unread, mark all read, delete or clear all; export the
  current view as JSON. Launch it from the application menu or
  `notify-center-viewer`; double-click marks a notification read, and launching
  again focuses the existing window instead of opening a second copy.
- **Collector** — a small `systemd --user` service that turns spooled
  notifications into a local SQLite history with retention and size limits.

## How it works

Cinnamon already implements `org.freedesktop.Notifications`, so nothing outside
the shell can observe notifications. This applet hooks notification delivery
inside the Cinnamon applet (same JS process as the shell), writes one small
JSON file per notification, and the Python collector turns those files into
SQLite. Cinnamon's native notification UI is untouched by default; the optional
`dismiss_after_capture` setting closes a notification in Cinnamon after it has
been recorded, and `toast_enabled` / `sound_enabled` make the applet draw and
play its own notification instead.

```
application
    │ Notify() (still handled by Cinnamon)
    ▼
Cinnamon notificationDaemon._notifyForSource
    │ applet hook: write one JSON file
    ▼
~/.local/share/notify-center/spool/<timestamp>-<random>.json
    │ collector (systemd user service), poll every 2s
    ▼
~/.local/share/notify-center/notifications.db   (SQLite, WAL)
    │                         │
    │ status.json            │ read only
    ▼                         ▼
applet badge / tooltip      GTK viewer (search, filter, mark read, delete, export)
```

---

## Prerequisites

- Cinnamon 6.x (Linux Mint 22 or later)
- Python 3 with `sqlite3` (standard library)
- GTK 3 Python bindings for the viewer:
  `sudo apt install python3-gi gir1.2-gtk-3.0`
- A working `systemd --user` session for the collector (optional; see
  `--no-service`)

The collector itself uses **only** the Python standard library.

---

## Install

```bash
git clone https://github.com/jt-at-home/notify-center.git
cd notify-center
./install-notify-center.sh
```

Then add the applet:

1. Right-click the Cinnamon panel → **Applets**
2. Select **Notification Center** → **Add to panel**

If the applet does not appear in the list, reload Cinnamon (Alt+F2, `r`, Enter)

The collector service is enabled and started automatically. If `systemd --user`
is unavailable, install with `--no-service` and start the collector manually:

```bash
~/.local/bin/notify-center-collector &
```

The installer never overwrites an existing
`~/.config/notify-center/config.json`, and it refuses to run as root.

---

## Configuration

`~/.config/notify-center/config.json`:

If the file does not exist yet, the applet's *Open configuration file* item or
the viewer's *Settings* button creates it with the defaults below (mode 0600).

```json
{
  "retention_days": 30,
  "max_rows": 5000,
  "ignore_transient": true,
  "ignore_apps": [],
  "persistent_apps": [],
  "persistent_categories": [],
  "dismiss_after_capture": false,
  "toast_enabled": false,
  "toast_timeout": 5,
  "toast_position": "top-right",
  "sound_enabled": false,
  "sound_file": ""
}
```

| Key | Used by | Meaning |
| --- | --- | --- |
| `retention_days` | collector | Delete notifications older than this (1–3650). |
| `max_rows` | collector | Keep at most this many rows (100–100000). |
| `ignore_transient` | applet + collector | Skip notifications carrying the `transient` hint. Default `true`; these are usually on-screen display popups, not history. Set to `false` to record every notification. |
| `ignore_apps` | applet + collector | Case-insensitive app names or `.desktop` ids that should not be recorded. |
| `persistent_apps` | applet | Optional. Apps whose notifications should **not** auto-expire (stay in Cinnamon's tray until dismissed). Matches app name or desktop-entry id. Empty by default. |
| `persistent_categories` | applet | Optional. Same, by freedesktop category. A rule matches the category or its prefix (`im` matches `im.received`). Empty by default. |
| `dismiss_after_capture` | applet | Optional, default `false`. After a notification is recorded, remove it from Cinnamon's popup and message tray so the history is the only place it lives. |
| `toast_enabled` | applet | Optional, default `false`. Show notify-center's own popup for each recorded notification. Drawn by the applet, so it is independent of Cinnamon's notification display setting. |
| `toast_timeout` | applet | Seconds a toast stays on screen (1–60). Default `5`. |
| `toast_position` | applet | `top-right` (default), `bottom-right`, `top-left` or `bottom-left`. |
| `sound_enabled` | applet | Optional, default `false`. Play a sound for each recorded notification. |
| `sound_file` | applet | Optional absolute path to a sound file. Empty uses the desktop's configured notification sound, then the freedesktop `message-new-instant` theme sound. |

History and the unread badge are the primary safety net: every recorded
notification remains searchable and contributes to the unread count even after
its popup and tray item are gone. The `persistent_*` lists are strictly opt-in
for the cases where you also want a notification parked in Cinnamon's tray.
They do not affect recording or the unread count.

`dismiss_after_capture` only applies to notifications the applet actually
recorded: ignored apps and ignored transient notifications are left to Cinnamon
unchanged. A matching `persistent_*` rule wins, so those notifications stay
visible. Dismissal happens immediately after Cinnamon queues the notification,
which means its popup may not be visible at all; the history and unread count
still record it. Only a JSON `true` enables it.

`toast_enabled` and `sound_enabled` are the applet's own replacement for
Cinnamon's notification UI. Toasts are drawn by the applet, not by Cinnamon, so
they keep working when Cinnamon's own notifications are disabled. That is the
recommended way to run the applet as a full replacement:

```json
{
  "dismiss_after_capture": true,
  "toast_enabled": true,
  "sound_enabled": true
}
```

If Cinnamon's notifications are left enabled, either enable
`dismiss_after_capture` too or leave `toast_enabled` off, otherwise both popups
appear. Toasts stack up to four, disappear after `toast_timeout`, and open the
viewer when clicked. Notifications carrying the `suppress-sound` hint never
play a sound. Toast and sound settings apply to the next notification; the
applet reloads the config every 30 seconds and whenever its menu is opened.

With `sound_enabled` set to `true` the applet always plays a sound, even if
Cinnamon's own notification sound is unchecked in the sound settings. The file
is still the one configured for *Showing notifications* (so changing that file
changes notify-center's sound), unless `sound_file` overrides it.

`persistent_*` uses Cinnamon internals to remove the notification from its
expiry queue and mark it resident. If a future Cinnamon changes those internals,
the applet catches the error and continues recording. `dismiss_after_capture`
uses the daemon's `CloseNotification` method, with a guarded fallback that
destroys the notification directly; if neither works, the notification simply
stays in Cinnamon.

---

## Files installed

```
~/.local/bin/notify-center-collector
~/.local/bin/notify-center-viewer
~/.local/share/cinnamon/applets/notification-center@jt-at-home/
~/.local/share/notify-center/notifications.db       # 0600
~/.local/share/notify-center/status.json            # 0600
~/.local/share/notify-center/spool/                 # 0700
~/.local/share/notify-center/failed/                # bad spool files
~/.config/notify-center/config.json
~/.config/systemd/user/notify-center-collector.service
~/.local/share/applications/notify-center.desktop
```

Uninstall (keeps history and config):

```bash
./uninstall-notify-center.sh
```

Uninstall and delete the database, spool and config:

```bash
./uninstall-notify-center.sh --purge
```

Add `--no-service` to skip all `systemctl --user` calls and only remove files,
for example in containers or throwaway prefixes where the unit is not managed
by this login session.

---

## CLI

Collector:

```bash
notify-center-collector                 # foreground, poll every 2s
notify-center-collector --once          # drain the spool and exit
notify-center-collector --verbose       # log every file
notify-center-collector --data-dir DIR --config FILE
notify-center-collector --poll 1.0      # faster polling
```

Viewer:

```bash
notify-center-viewer
notify-center-viewer --version
```

If `~/.local/bin` is not on your `PATH`, use `~/.local/bin/notify-center-viewer`.

---

## Troubleshooting

**Applet says "Collector is not running"**

```bash
systemctl --user status notify-center-collector.service
journalctl --user -u notify-center-collector.service -n 50 --no-pager
```

If you installed with `--no-service`, start the collector manually. If you use a
custom `XDG_DATA_HOME`, make sure the service sees the same value; the installer
writes it into the unit, but a service started manually from a different
environment may use a different path.

**No notifications appear**

- Confirm the applet is actually on the panel (Cinnamon only calls the hook for
  an added applet).
- Check the Cinnamon log for
  `Main.notificationDaemon._notifyForSource is unavailable`. If it appears, the
  private API changed; capture is disabled but the rest of the app still works.
- `ignore_transient` defaults to `true`; some apps mark all their notifications
  transient. Set it to `false` temporarily if you suspect this.
- Notifications that Cinnamon itself creates internally (not through the
  freedesktop API) are not seen; the applet only sees app notifications.
- History starts when the applet is added. There is no backfill of older
  notifications.

**Cinnamon's own popups never show up**

Check `dismiss_after_capture` in the config. When it is `true`, every
notification the applet records is closed in Cinnamon immediately after
capture; set it to `false` to get Cinnamon's normal popups and tray back.

**notify-center's toasts never show up**

Set `toast_enabled` to `true`. This is independent of Cinnamon's notification
settings, so turning Cinnamon's popups off does not disable notify-center's.
If the Cinnamon log contains `St is unavailable`, the applet cannot draw
toasts, but recording and the viewer still work.

**No notification sound**

Set `sound_enabled` to `true`. If it is enabled but silent, check that
`sound_file` (when set) points at a readable file, and that the sound player
is not muted. With an empty `sound_file` the applet uses the notification sound
configured in Cinnamon's sound settings.

**Viewer says "No database yet"**

The collector has not run successfully. Start it, or run
`notify-center-collector --once` to create the database.

**Viewer fails with a GTK error**

This viewer is GTK 3 code and pins `gi.require_version("Gtk", "3.0")`. Install
the GTK 3 bindings:

```bash
sudo apt install python3-gi gir1.2-gtk-3.0
```

**The applet is not in the Applets list**

Confirm the files are in
`~/.local/share/cinnamon/applets/notification-center@jt-at-home/` and that
`metadata.json` has `"uuid": "notification-center@jt-at-home"`. Reload Cinnamon
(Alt+F2, `r`, Enter) if you copied the files by hand.

---

## Privacy

Notification bodies can contain message text, email subjects and 2FA codes. The
database and status file are created with mode `0600`; the data and spool
directories use `0700`. Nothing is sent off the machine. Set
`retention_days` and `max_rows` to keep history small, or run
`uninstall-notify-center.sh --purge` to remove it entirely.

---

## Limitations

- The applet relies on Cinnamon's private `_notifyForSource` hook. If a future
  Cinnamon changes it, notification capture is disabled but the rest of the
  app keeps working.
- `dismiss_after_capture` depends on the daemon's `CloseNotification` method
  (or, failing that, the notification object), so a future Cinnamon can make it
  a no-op. The notification then stays in Cinnamon and recording is unaffected.
- `toast_enabled` and `sound_enabled` are applet UI: toasts disappear and sounds
  stop when the applet is removed from the panel. Toasts show the notification
  text only — no action buttons; clicking a toast opens the viewer. Toasts are
  placed on the primary monitor.
- Notification **actions** are stored as JSON and shown only as metadata. The
  viewer cannot invoke an action after the notification has expired.
- Cinnamon notification IDs are reused for replacements, which the collector
  coalesces into one row per logical notification per applet session.
- There is no tray icon in the viewer; the applet is the tray/panel presence.
  This avoids the deprecated X11-only `Gtk.StatusIcon`.
- The viewer and collector are separate processes. If the collector is stopped,
  the viewer still works on the existing database; new notifications are queued
  in the spool and drained when it restarts. The applet keeps at most 2000 spool
  files and drops anything older than 30 days, so a collector that never runs
  cannot fill the disk — the oldest queued notifications are discarded first.

---

## License

MIT. See [LICENSE](LICENSE).
