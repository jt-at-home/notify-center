# Notification Center for Cinnamon

[![CI](https://github.com/jt-at-home/notify-center/actions/workflows/ci.yml/badge.svg)](https://github.com/jt-at-home/notify-center/actions/workflows/ci.yml)

A persistent notification history for Cinnamon: record every desktop
notification, search it, mark things read, and get an unread badge in the panel.

![Notification Center viewer](docs/viewer.png)

*Screenshot uses temporary demo data.*

---

## What it does

- **Applet** — shows an unread count in the panel. Click it for a menu with
  *Open Notification Center* and *Notification preferences…*; middle-click
  opens the viewer directly. If the collector is not running, the icon switches
  to a warning icon and the tooltip explains. With `dismiss_after_capture`, it
  also removes each recorded notification from Cinnamon's own popup and tray;
  `toast_enabled` and `sound_enabled` show its own popup and play a sound (both
  on by default for new installs).
- **Viewer** — search across app, title and body; filter by app, category or
  unread; mark read/unread, mark all read, delete, **Ignore App** for selected
  notifications, or clear all; export the current view as JSON. **Preferences**
  edits popups, sound, Cinnamon replacement, history limits and the ignored /
  persistent lists; double-click marks a notification read, and launching again
  focuses the existing window instead of opening a second copy.
- **Collector** — a small `systemd --user` service that turns spooled
  notifications into a local SQLite history with retention and size limits.

## How it works

Cinnamon already implements `org.freedesktop.Notifications`, so nothing outside
the shell can observe notifications. This applet hooks notification delivery
inside the Cinnamon applet (same JS process as the shell), writes one small
JSON file per notification, and the Python collector turns those files into
SQLite. New installs default to replacement: the applet draws its own toast and
plays a sound, and Cinnamon's native popups are turned off. Existing configs
can keep Cinnamon's popups (record-only), or use `dismiss_after_capture` to
close them once recorded.

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

The installer does not create `~/.config/notify-center/config.json`; a new
install uses the built-in defaults until you save Preferences. It never
overwrites an existing config, and it refuses to run as root.

### Debian package

```bash
sudo apt install ./notify-center_<version>_all.deb
```

When installed from a terminal with `sudo`, the package starts the collector in
your session immediately. A GUI installer that does not expose the user starts
it at the next login instead. The applet still has to be added to the panel
once, as above.

The package installs system-wide under `/usr/bin`, `/usr/lib/notify-center`,
`/usr/share/cinnamon/applets`, `/usr/lib/systemd/user` and
`/etc/xdg/autostart`. User data and configuration stay in the same
`~/.local/share/notify-center` and `~/.config/notify-center` paths. Remove it
with `sudo apt purge notify-center`; `dpkg` does not delete your history or
config, so remove those directories yourself if you want them gone.

---

## Replace Cinnamon's notifications

**New installs use notify-center by default.** When the applet is added for the
first time and no config file exists, it enables notify-center's popups and
sound and turns Cinnamon's own notification popups off, so there are no
duplicate popups.

To switch back, or choose another behavior:

1. Right-click the applet → **Notification preferences…** (or open the viewer
   and click **Preferences**).
2. On the **Popups** tab choose:
   - **Cinnamon's own notification popups** — notify-center only records;
   - **notify-center popups (recommended)** — notify-center shows them and
     Cinnamon's are turned off;
   - **No popups (record silently)** — neither shows anything.
3. Click **Save**.

The choices map to the keys below; a config created by an older version keeps
the previous off defaults for keys it does not contain:

```json
{
  "dismiss_after_capture": true,
  "toast_enabled": true,
  "sound_enabled": true
}
```

`dismiss_after_capture` only matters while Cinnamon's popups are enabled; with
them off, notify-center's own popups are the only ones shown. Changes apply
immediately; the applet watches the config file.

---

## Configuration

Most settings are available in the **Preferences** dialog (viewer) and
**Notification preferences…** (applet); the raw values live in
`~/.config/notify-center/config.json`:

If the file does not exist yet, saving **Preferences** (or using **Edit
configuration file**) creates it with the defaults below (mode 0600).

```json
{
  "retention_days": 30,
  "max_rows": 5000,
  "ignore_transient": true,
  "ignore_apps": [],
  "persistent_apps": [],
  "persistent_categories": [],
  "dismiss_after_capture": true,
  "toast_enabled": true,
  "toast_timeout": 5,
  "toast_position": "top-right",
  "sound_enabled": true,
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
| `dismiss_after_capture` | applet | Default `true` for new installs. After a notification is recorded, remove it from Cinnamon's popup and message tray so the history is the only place it lives. Older configs without the key keep `false`. |
| `toast_enabled` | applet | Default `true` for new installs. Show notify-center's own popup for each recorded notification. Drawn by the applet, so it is independent of Cinnamon's notification display setting. Older configs without the key keep `false`. |
| `toast_timeout` | applet | Seconds a toast stays on screen (1–60). Default `5`. |
| `toast_position` | applet | `top-right` (default), `bottom-right`, `top-left` or `bottom-left`. |
| `sound_enabled` | applet | Default `true` for new installs. Play a sound for each recorded notification. Older configs without the key keep `false`. |
| `sound_file` | applet | Optional absolute path to a sound file. Empty uses the desktop's configured notification sound, then the freedesktop `message-new-instant` theme sound. |

History and the unread badge are the primary safety net: every recorded
notification remains searchable and contributes to the unread count even after
its popup and tray item are gone. The `persistent_*` lists are strictly opt-in
for the cases where you also want a notification parked in Cinnamon's tray.
They do not affect recording or the unread count.

**Ignoring apps from the viewer.** Select one or more notifications and click
**Ignore App**. The app (and its desktop-entry id) is added to `ignore_apps`;
future notifications from it are not recorded, toasted, sounded or removed from
Cinnamon. Notifications already in the history stay. The viewer status bar
shows a running total of notifications skipped by the ignore list
(`N ignored`, stored in `ignored.json`), and **Preferences → History** lets you
review or edit the list and reset the counter with **Clear counter** (the
ignore rules are left unchanged).

`dismiss_after_capture` only applies to notifications the applet actually
recorded: ignored apps and ignored transient notifications are left to Cinnamon
unchanged. A matching `persistent_*` rule wins, so those notifications stay
visible. Dismissal happens immediately after Cinnamon queues the notification,
which means its popup may not be visible at all; the history and unread count
still record it.

`toast_enabled` and `sound_enabled` are the applet's own replacement for
Cinnamon's notification UI. Toasts are drawn by the applet, not by Cinnamon, so
they keep working when Cinnamon's own notifications are disabled. New installs
default to this mode; the Preferences dialog sets these keys together:

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
play a sound. Toast and sound settings apply immediately when the config file
changes; the applet also reloads it every 30 seconds as a fallback.

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
~/.local/share/notify-center/ignored.json           # 0600, ignored counter
~/.local/share/notify-center/spool/                 # 0700
~/.local/share/notify-center/failed/                # bad spool files
~/.config/notify-center/config.json                 # created on Save/Edit
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
notify-center-viewer --settings    # open Preferences directly
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

**Two popups for every notification**

Cinnamon's own popups are still enabled. Open **Notification preferences…**,
select **notify-center popups (recommended)** (or **No popups**), then
**Save**.

**An ignored app still has old notifications**

**Ignore App** affects future notifications only; existing history is kept.
The `N ignored` counter in the status bar is the number skipped since the
counter file was created.

**Cinnamon's own popups never show up**

New installs turn Cinnamon's popups off automatically. Open **Notification
preferences…** and choose **Cinnamon's own notification popups**, then **Save**.
Also check `dismiss_after_capture`: when it is `true`, every notification the
applet records is closed in Cinnamon immediately after capture.

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
database, status file, ignored counter and config are created with mode `0600`;
the data and spool directories use `0700`. Nothing is sent off the machine. Set
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
