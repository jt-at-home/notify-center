#!/usr/bin/env bash
#
# Build a local notify-center .deb for testing.
#
# Usage:
#   packaging/build-deb.sh
#
# Output:
#   dist/notify-center_<version>-<revision>_all.deb
#
# Environment overrides: MAINTAINER, REVISION.
#
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -- "${HERE}/.." && pwd)"
OUT_DIR="${REPO}/dist"
MAINTAINER="${MAINTAINER:-jt-at-home <jt-at-home@users.noreply.github.com>}"
REVISION="${REVISION:-1}"
PKG="notify-center"
ARCH="all"

VERSION="$(python3 - "${REPO}/applet/metadata.json" <<'PY'
import json
import sys

print(json.load(open(sys.argv[1], encoding="utf-8"))["version"])
PY
)"

VIEWER_VERSION="$(python3 - "${REPO}/viewer/notify-center-viewer.py" <<'PY'
import pathlib
import re
import sys

text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
match = re.search(r'^APP_VERSION = "([^"]+)"$', text, re.MULTILINE)
if match is None:
    raise SystemExit("APP_VERSION not found")
print(match.group(1))
PY
)"

if [ "$VERSION" != "$VIEWER_VERSION" ]; then
    echo "error: applet version ${VERSION} != viewer version ${VIEWER_VERSION}" >&2
    exit 1
fi

DEB_VERSION="${VERSION}-${REVISION}"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/notify-center-deb.XXXXXX")"
chmod 0755 "$STAGE"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

BIN="${STAGE}/usr/bin"
LIB="${STAGE}/usr/lib/notify-center"
APPLET="${STAGE}/usr/share/cinnamon/applets/notification-center@jt-at-home"
DOC="${STAGE}/usr/share/doc/${PKG}"
UNIT="${STAGE}/usr/lib/systemd/user"
AUTOSTART="${STAGE}/etc/xdg/autostart"
MANDIR="${STAGE}/usr/share/man/man1"

install -d -m 0755 \
    "$BIN" \
    "$LIB" \
    "$APPLET" \
    "$DOC" \
    "$UNIT" \
    "$AUTOSTART" \
    "$MANDIR" \
    "${STAGE}/usr/share/applications" \
    "${STAGE}/usr/share/${PKG}/examples" \
    "${STAGE}/DEBIAN"

install -m 0755 "${REPO}/collector/notify-center-collector.py" "${BIN}/notify-center-collector"
install -m 0755 "${REPO}/viewer/notify-center-viewer.py" "${BIN}/notify-center-viewer"
install -m 0755 "${HERE}/notify-center-collector-autostart" \
    "${LIB}/notify-center-collector-autostart"
install -m 0644 "${HERE}/notify-center-collector.1" "${MANDIR}/notify-center-collector.1"
install -m 0644 "${HERE}/notify-center-viewer.1" "${MANDIR}/notify-center-viewer.1"
gzip -9n "${MANDIR}/notify-center-collector.1" "${MANDIR}/notify-center-viewer.1"

install -m 0644 "${REPO}/applet/applet.js" "${APPLET}/applet.js"
install -m 0644 "${REPO}/applet/metadata.json" "${APPLET}/metadata.json"

install -m 0644 "${HERE}/notify-center.desktop" \
    "${STAGE}/usr/share/applications/notify-center.desktop"
install -m 0644 "${HERE}/notify-center-collector.service" \
    "${UNIT}/notify-center-collector.service"
install -m 0644 "${HERE}/notify-center-collector.desktop" \
    "${AUTOSTART}/notify-center-collector.desktop"

install -m 0644 "${HERE}/copyright" "${DOC}/copyright"
install -m 0644 "${REPO}/config/config.json" "${STAGE}/usr/share/${PKG}/examples/config.json"

{
    printf 'notify-center (%s) unstable; urgency=medium\n\n' "$DEB_VERSION"
    printf '  * Local test build.\n\n'
    printf ' -- %s  %s\n' "$MAINTAINER" "$(LC_ALL=C date -R)"
} > "${DOC}/changelog.Debian"
gzip -9n "${DOC}/changelog.Debian"

gzip -9nc "${REPO}/README.md" > "${DOC}/README.md.gz"
chmod 0644 "${DOC}/README.md.gz" "${DOC}/copyright" "${DOC}/changelog.Debian.gz"

cat > "${STAGE}/DEBIAN/control" <<EOF
Package: ${PKG}
Version: ${DEB_VERSION}
Architecture: ${ARCH}
Maintainer: ${MAINTAINER}
Installed-Size: $(du -sk "$STAGE" | cut -f1)
Depends: python3, python3-gi, gir1.2-gtk-3.0
Recommends: cinnamon (>= 6.0), systemd
Section: utils
Priority: optional
Homepage: https://github.com/jt-at-home/notify-center
Description: persistent notification history for Cinnamon
 Notification Center records every Cinnamon desktop notification into a local
 SQLite history, shows an unread badge in the panel, and provides a GTK viewer
 with search, filters, read/unread state and JSON export.
EOF

cat > "${STAGE}/DEBIAN/conffiles" <<'EOF'
/etc/xdg/autostart/notify-center-collector.desktop
EOF

install -m 0755 "${HERE}/postinst" "${STAGE}/DEBIAN/postinst"

( cd "$STAGE" && find usr etc -type f -print0 | sort -z | xargs -0 md5sum > DEBIAN/md5sums )

mkdir -p "$OUT_DIR"
DEB="${OUT_DIR}/${PKG}_${DEB_VERSION}_${ARCH}.deb"
rm -f "$DEB"
dpkg-deb --root-owner-group --build "$STAGE" "$DEB" >/dev/null

echo "Built ${DEB}"
echo
dpkg-deb --info "$DEB" | sed -n '1,25p'
echo
echo "Install with:"
echo "  sudo apt install ${DEB}"
