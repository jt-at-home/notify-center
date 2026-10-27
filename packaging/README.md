# Local .deb builds

Build a package for testing without publishing anything:

```bash
./packaging/build-deb.sh
```

Output: `dist/notify-center_<version>-<revision>_all.deb`, where the version
comes from `applet/metadata.json` (the script refuses to build if the viewer's
`APP_VERSION` differs) and the revision defaults to `1`
(`REVISION=2 ./packaging/build-deb.sh` for another build).

When you rebuild after code changes without bumping the app version, bump the
revision too (or set a new version). Otherwise `apt install` sees the same
version already installed and refuses to upgrade to the new contents.

## What the package installs

```
/usr/bin/notify-center-collector
/usr/bin/notify-center-viewer
/usr/lib/notify-center/notify-center-collector-autostart
/usr/share/man/man1/notify-center-collector.1
/usr/share/man/man1/notify-center-viewer.1
/usr/share/cinnamon/applets/notification-center@jt-at-home/
/usr/share/applications/notify-center.desktop
/usr/lib/systemd/user/notify-center-collector.service
/etc/xdg/autostart/notify-center-collector.desktop
/usr/share/notify-center/examples/config.json
/usr/share/doc/notify-center/
```

Dependencies: `python3`, `python3-gi`, `gir1.2-gtk-3.0`. Recommends
`cinnamon (>= 6.0)` and `systemd`.

## How the collector starts

The systemd user unit is shipped but **not enabled** (a package cannot enable a
per-user unit from `postinst`). `postinst` starts it for the installing user
when the package is installed from a terminal with `sudo` (or via `pkexec`, when
`PKEXEC_UID` is available); otherwise `/etc/xdg/autostart` starts
`notify-center-collector-autostart` at login, which:

1. imports any custom `XDG_DATA_HOME`/`XDG_CONFIG_HOME` into the systemd user
   manager,
2. starts `notify-center-collector.service` (supervision, restarts, journald),
3. falls back to `exec /usr/bin/notify-center-collector` if `systemd --user` is
   unavailable.

Users who want the service outside a desktop login can opt in with
`systemctl --user enable --now notify-center-collector.service`; the autostart
start then becomes a no-op. The collector already takes an `flock`, so a
duplicate instance exits quietly.

Logs:

```bash
journalctl --user -u notify-center-collector -f
```

## Testing on a machine with an existing user-local install

The user-local install (`install-notify-center.sh`) shadows `/usr` copies and
would make the test meaningless. Remove it first — history and config are
kept:

```bash
./uninstall-notify-center.sh
systemctl --user daemon-reload

sudo apt install ./dist/notify-center_<version>-<revision>_all.deb
systemctl --user daemon-reload
systemctl --user start notify-center-collector   # or log out and back in
```

Then reload Cinnamon (Alt+F2, `r`, Enter) and add the applet if it is not on the
panel yet.

Verify:

```bash
systemctl --user status notify-center-collector
notify-send "notify-center deb test" "recorded from the packaged install"
~/.local/bin/notify-center-viewer   # or the menu entry
```

## Uninstall

```bash
systemctl --user stop notify-center-collector
sudo apt remove notify-center
```

`~/.local/share/notify-center` (history) and `~/.config/notify-center`
(configuration) are left untouched.
