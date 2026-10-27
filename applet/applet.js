// Notification Center applet for Cinnamon 6.x
//
// Cinnamon owns org.freedesktop.Notifications; a separate process cannot
// listen to it. This applet lives in Cinnamon's own JS process and wraps the
// shell's private _notifyForSource() hook to record notifications. Recording is
// fire-and-forget: one JSON file per notification in the spool directory,
// which notify-center-collector drains into SQLite.
//
// The applet never touches SQLite, never owns a D-Bus name, and never replaces
// Cinnamon's notification UI. If the hook is unavailable, it logs an error and
// leaves Cinnamon alone. Optionally (dismiss_after_capture) a recorded
// notification is closed in Cinnamon right after it is captured, and
// optionally (toast_enabled / sound_enabled) the applet shows its own toast
// and plays a sound, so history can fully replace the built-in notifications.

const Applet = imports.ui.applet;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

const APP_NAME = "notify-center";
const DATA_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), APP_NAME]);
const SPOOL_DIR = GLib.build_filenamev([DATA_DIR, "spool"]);
const STATUS_FILE = GLib.build_filenamev([DATA_DIR, "status.json"]);
const IGNORED_FILE = GLib.build_filenamev([DATA_DIR, "ignored.json"]);
const CONFIG_FILE = GLib.build_filenamev([
    GLib.get_user_config_dir(),
    APP_NAME,
    "config.json",
]);
const VIEWER_NAME = "notify-center-viewer";
const PROJECT_URL = "https://github.com/jt-at-home/notify-center";
const STATUS_STALE_SECONDS = 180;
// The collector drains the spool, so it normally holds a handful of files. If
// the collector is stopped or crash-looping nothing else bounds it, so the
// applet keeps only the newest SPOOL_MAX_FILES files and drops anything older
// than SPOOL_MAX_AGE_SECONDS. With no collector running, the oldest queued
// notification is lost instead of the directory growing without limit.
const SPOOL_MAX_FILES = 2000;
const SPOOL_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const SPOOL_PRUNE_INTERVAL_SECONDS = 60 * 60;

const TOAST_WIDTH = 360;
const TOAST_MARGIN = 24;
const TOAST_MAX = 4;
const TOAST_POSITIONS = [
    "top-right",
    "bottom-right",
    "top-left",
    "bottom-left",
];

// St is part of Cinnamon and does not exist outside a Cinnamon session (for
// example in the applet test harness), so load it lazily and fail soft.
let cachedSt = null;
let cachedClutter = null;

function getSt() {
    if (cachedSt === null) {
        try {
            cachedSt = imports.gi.St;
        } catch (e) {
            cachedSt = false;
            global.logError(
                "notify-center: St is unavailable; notification toasts are disabled"
            );
        }
    }
    return cachedSt || null;
}

function getClutter() {
    if (cachedClutter === null) {
        try {
            cachedClutter = imports.gi.Clutter;
        } catch (e) {
            cachedClutter = false;
        }
    }
    return cachedClutter || null;
}

// ---------------------------------------------------------------------------
// small helpers

function readJson(path, fallback) {
    try {
        let [ok, contents] = GLib.file_get_contents(path);
        if (!ok || !contents) {
            return fallback;
        }
        return JSON.parse(new TextDecoder().decode(contents));
    } catch (e) {
        return fallback;
    }
}

function asString(value) {
    return value === null || value === undefined ? "" : String(value);
}

function normalizedApp(value) {
    let text = asString(value).trim().toLowerCase();
    if (text.endsWith(".desktop")) {
        text = text.slice(0, -".desktop".length);
    }
    return text;
}

function stringList(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    let result = [];
    for (let i = 0; i < value.length; i++) {
        if (typeof value[i] === "string" && value[i].trim()) {
            result.push(value[i].trim().toLowerCase());
        }
    }
    return result;
}

function configList(raw, primary, legacy) {
    if (Array.isArray(raw[primary])) {
        return stringList(raw[primary]);
    }
    if (Array.isArray(raw[legacy])) {
        return stringList(raw[legacy]);
    }
    return [];
}

// Plain single-line text for toasts: notifications can contain markup and
// embedded newlines, neither of which belongs in a small popup.
function plainText(value) {
    let text = asString(value);
    try {
        if (typeof Util.decodeHTML === "function") {
            text = Util.decodeHTML(text);
        }
    } catch (e) {
        // Fall back to the raw text.
    }
    return text.replace(/\s+/g, " ").trim();
}

function numberInRange(value, fallback, min, max) {
    let number = Number(value);
    if (!isFinite(number)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, Math.round(number)));
}

function toastPosition(value) {
    let text = asString(value).trim().toLowerCase();
    return TOAST_POSITIONS.indexOf(text) === -1 ? "top-right" : text;
}

// ---------------------------------------------------------------------------

function NotificationCenterApplet(metadata, orientation, panelHeight, instanceId) {
    this._init(metadata, orientation, panelHeight, instanceId);
}

NotificationCenterApplet.prototype = {
    __proto__: Applet.TextIconApplet.prototype,

    _init: function (metadata, orientation, panelHeight, instanceId) {
        Applet.TextIconApplet.prototype._init.call(
            this,
            orientation,
            panelHeight,
            instanceId
        );

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this.set_applet_icon_name("dialog-information");
        this.set_applet_tooltip("Notification Center");

        this._session =
            String(Date.now()) + "-" + Math.random().toString(36).slice(2, 10);
        this._config = {
            ignoreTransient: true,
            ignoreApps: [],
            persistentApps: [],
            persistentCategories: [],
            dismissAfterCapture: true,
            toastEnabled: true,
            toastTimeout: 5,
            toastPosition: "top-right",
            soundEnabled: true,
            soundFile: "",
        };
        this._hooked = false;
        this._originalNotifyForSource = null;
        this._statusMonitor = null;
        this._configMonitor = null;
        this._timeoutId = 0;
        this._menuCount = null;
        this._lastPrune = 0;
        this._toasts = [];
        this._toastLayer = null;
        this._toastMonitorId = 0;
        this._soundId = 0;
        this._soundSettings = undefined;
        this._configExists = false;
        this._ignoredCount = 0;
        this._ignoredFlushId = 0;
        this._disabledCinnamonPopups = false;

        this._loadConfig();
        if (!this._configExists) {
            this._disableCinnamonPopupsOnFirstRun();
        }
        this._loadIgnoredCount();
        try {
            GLib.mkdir_with_parents(SPOOL_DIR, 0o700);
        } catch (e) {
            global.logError(e);
        }
        this._pruneSpool();

        this._buildMenu(orientation);
        this._setupStatusMonitor();
        this._setupConfigMonitor();
        this._updateBadge();

        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            30,
            () => {
                this._loadConfig();
                this._updateBadge();
                this._maybePruneSpool();
                return true;
            }
        );
    },

    // -- lifecycle --------------------------------------------------------

    on_applet_added_to_panel: function () {
        this._installHook();
        this._loadConfig();
        this._updateBadge();
    },

    on_applet_removed_from_panel: function () {
        this._removeHook();
        this._destroyToasts();
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._statusMonitor) {
            this._statusMonitor.cancel();
            this._statusMonitor = null;
        }
        if (this._configMonitor) {
            this._configMonitor.cancel();
            this._configMonitor = null;
        }
        if (this._ignoredFlushId) {
            GLib.source_remove(this._ignoredFlushId);
            this._ignoredFlushId = 0;
        }
        this._flushIgnoredCount();
        // If we turned Cinnamon's popups off for a fresh install and the user
        // removes the applet before saving any config, put them back: otherwise
        // removing the applet would leave Cinnamon with no notifications at all.
        this._restoreCinnamonPopupsOnRemoval();
        if (this.menu) {
            try {
                this.menu.destroy();
            } catch (e) {
                global.logError(e);
            }
            this.menu = null;
        }
    },

    on_orientation_changed: function (orientation) {
        if (this.menu) {
            try {
                this.menu.destroy();
            } catch (e) {
                global.logError(e);
            }
            this.menu = null;
        }
        this._buildMenu(orientation);
    },

    on_applet_clicked: function () {
        if (this.menu) {
            this.menu.toggle();
        }
    },

    on_applet_middle_clicked: function () {
        this._openViewer();
    },

    // -- menu -------------------------------------------------------------

    _buildMenu: function (orientation) {
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        this._menuCount = new PopupMenu.PopupMenuItem("No unread notifications");
        this._menuCount.actor.reactive = false;
        this._menuCount.actor.can_focus = false;
        this.menu.addMenuItem(this._menuCount);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let openItem = new PopupMenu.PopupMenuItem("Open Notification Center");
        openItem.connect("activate", () => this._openViewer());
        this.menu.addMenuItem(openItem);

        let preferencesItem = new PopupMenu.PopupMenuItem(
            "Notification preferences…"
        );
        preferencesItem.connect("activate", () => this._openPreferences());
        this.menu.addMenuItem(preferencesItem);

        let aboutItem = new PopupMenu.PopupMenuItem("About Notification Center");
        aboutItem.connect("activate", () => this._openAbout());
        this.menu.addMenuItem(aboutItem);

        this.menu.connect("open-state-changed", (menu, isOpen) => {
            if (isOpen) {
                this._loadConfig();
                this._updateBadge();
            }
        });
    },

    _findViewer: function () {
        let onPath = GLib.find_program_in_path(VIEWER_NAME);
        if (onPath) {
            return onPath;
        }
        let fallback = GLib.build_filenamev([
            GLib.get_home_dir(),
            ".local",
            "bin",
            VIEWER_NAME,
        ]);
        if (GLib.file_test(fallback, GLib.FileTest.IS_EXECUTABLE)) {
            return fallback;
        }
        return null;
    },

    _viewerMissing: function () {
        global.logError(
            "notify-center: viewer not found; reinstall with install-notify-center.sh"
        );
        this.set_applet_tooltip("Notification Center — viewer is not installed");
    },

    _openViewer: function () {
        let viewer = this._findViewer();
        if (!viewer) {
            this._viewerMissing();
            return;
        }
        Util.spawn([viewer]);
    },

    _openPreferences: function () {
        let viewer = this._findViewer();
        if (!viewer) {
            this._viewerMissing();
            return;
        }
        Util.spawn([viewer, "--settings"]);
    },

    _openAbout: function () {
        Util.spawn(["xdg-open", PROJECT_URL]);
    },

    // -- config -----------------------------------------------------------

    _loadConfig: function () {
        let raw = readJson(CONFIG_FILE, null);
        let missing = !raw || typeof raw !== "object";
        if (missing) {
            raw = {};
        }
        this._config = {
            ignoreTransient: raw.ignore_transient !== false,
            ignoreApps: stringList(raw.ignore_apps),
            persistentApps: configList(raw, "persistent_apps", "apps"),
            persistentCategories: configList(
                raw,
                "persistent_categories",
                "categories"
            ),
            // New installs default to notify-center; configs created by an
            // older version keep the previous opt-in behavior until the user
            // changes the setting.
            dismissAfterCapture: missing
                ? true
                : raw.dismiss_after_capture === true,
            toastEnabled: missing ? true : raw.toast_enabled === true,
            toastTimeout: numberInRange(raw.toast_timeout, 5, 1, 60),
            toastPosition: toastPosition(raw.toast_position),
            soundEnabled: missing ? true : raw.sound_enabled === true,
            soundFile:
                typeof raw.sound_file === "string" ? raw.sound_file.trim() : "",
        };
        this._configExists = !missing;
    },

    // New installs default to notify-center popups. Turn Cinnamon's own
    // popups off once so the default does not produce duplicates; choosing
    // Cinnamon's popups in Preferences turns them back on.
    _disableCinnamonPopupsOnFirstRun: function () {
        try {
            let settings = new Gio.Settings({
                schema_id: "org.cinnamon.desktop.notifications",
            });
            if (settings.get_boolean("display-notifications")) {
                settings.set_boolean("display-notifications", false);
                this._disabledCinnamonPopups = true;
            }
        } catch (e) {
            global.logError(e);
        }
    },

    _restoreCinnamonPopupsOnRemoval: function () {
        if (!this._disabledCinnamonPopups) {
            return;
        }
        if (GLib.file_test(CONFIG_FILE, GLib.FileTest.EXISTS)) {
            // The user saved settings; keep whatever they chose.
            return;
        }
        try {
            let settings = new Gio.Settings({
                schema_id: "org.cinnamon.desktop.notifications",
            });
            if (!settings.get_boolean("display-notifications")) {
                settings.set_boolean("display-notifications", true);
            }
        } catch (e) {
            global.logError(e);
        }
    },

    _isIgnored: function (name) {
        let normalized = normalizedApp(name);
        return normalized !== "" && this._config.ignoreApps.indexOf(normalized) !== -1;
    },

    _isPersistentApp: function (name) {
        let normalized = normalizedApp(name);
        return (
            normalized !== "" &&
            this._config.persistentApps.indexOf(normalized) !== -1
        );
    },

    _isPersistentCategory: function (category) {
        let normalized = asString(category).trim().toLowerCase();
        if (!normalized) {
            return false;
        }
        for (let i = 0; i < this._config.persistentCategories.length; i++) {
            let rule = this._config.persistentCategories[i];
            if (normalized === rule || normalized.indexOf(rule + ".") === 0) {
                return true;
            }
        }
        return false;
    },

    // -- capture ----------------------------------------------------------

    _installHook: function () {
        if (this._hooked) {
            return;
        }
        let daemon = Main.notificationDaemon;
        if (!daemon || typeof daemon._notifyForSource !== "function") {
            global.logError(
                "notify-center: Main.notificationDaemon._notifyForSource is unavailable; " +
                    "notification capture is disabled on this Cinnamon version"
            );
            return;
        }

        this._originalNotifyForSource = daemon._notifyForSource;
        let self = this;
        daemon._notifyForSource = function (source, ndata) {
            let captured = false;
            try {
                captured = self._capture(ndata);
            } catch (e) {
                global.logError(e);
            }
            try {
                return self._originalNotifyForSource.call(this, source, ndata);
            } finally {
                try {
                    // Persistence is independent of recording: it still applies
                    // to ignored apps. Dismissal only makes sense for a
                    // notification we actually kept a copy of.
                    self._maybePersist(ndata);
                    if (captured) {
                        self._maybeAnnounce(ndata);
                        self._maybeDismiss(ndata);
                    }
                } catch (e) {
                    global.logError(e);
                }
            }
        };
        this._hooked = true;
    },

    _removeHook: function () {
        if (!this._hooked || !this._originalNotifyForSource) {
            return;
        }
        let daemon = Main.notificationDaemon;
        if (daemon) {
            daemon._notifyForSource = this._originalNotifyForSource;
        }
        this._originalNotifyForSource = null;
        this._hooked = false;
    },

    _capture: function (ndata) {
        if (!ndata) {
            return false;
        }
        let hints =
            ndata.hints && typeof ndata.hints === "object" ? ndata.hints : {};
        let transient = hints["transient"] === true;
        if (transient && this._config.ignoreTransient) {
            return false;
        }

        let app = asString(ndata.appName);
        let desktopEntry = asString(hints["desktop-entry"]);
        if (this._isIgnored(app) || this._isIgnored(desktopEntry)) {
            this._noteIgnored();
            return false;
        }

        let urgency = Number(hints["urgency"]);
        if (!isFinite(urgency)) {
            urgency = 1;
        }
        urgency = Math.max(0, Math.min(2, Math.round(urgency)));

        let record = {
            v: 2,
            session: this._session,
            source_id: ndata.id === undefined ? null : ndata.id,
            is_update: !!ndata.notification,
            app: app,
            desktop_entry: desktopEntry || null,
            title: asString(ndata.summary),
            body: asString(ndata.body),
            category: hints["category"] ? asString(hints["category"]) : null,
            urgency: urgency,
            transient: transient,
            icon: ndata.appIcon ? asString(ndata.appIcon) : null,
            actions: Array.isArray(ndata.actions)
                ? ndata.actions.map(asString)
                : [],
            hints: this._sanitizeHints(hints),
            timestamp: Math.floor(Date.now() / 1000),
        };
        return this._writeSpool(record);
    },

    _sanitizeHints: function (hints) {
        let clean = {};
        try {
            for (let key in hints) {
                if (!Object.prototype.hasOwnProperty.call(hints, key)) {
                    continue;
                }
                if (
                    key === "image-data" ||
                    key === "image_data" ||
                    key === "icon_data"
                ) {
                    continue;
                }
                let value = hints[key];
                let type = typeof value;
                if (
                    value === null ||
                    type === "string" ||
                    type === "number" ||
                    type === "boolean"
                ) {
                    clean[key] = value;
                } else if (Array.isArray(value)) {
                    let simple = true;
                    for (let i = 0; i < value.length; i++) {
                        let itemType = typeof value[i];
                        if (
                            itemType !== "string" &&
                            itemType !== "number" &&
                            itemType !== "boolean"
                        ) {
                            simple = false;
                            break;
                        }
                    }
                    if (simple) {
                        clean[key] = value;
                    }
                }
            }
        } catch (e) {
            global.logError(e);
        }
        return clean;
    },

    _writeSpool: function (record) {
        try {
            GLib.mkdir_with_parents(SPOOL_DIR, 0o700);
            let name =
                String(Date.now()) +
                "-" +
                Math.random().toString(36).slice(2, 10) +
                ".json";
            let path = GLib.build_filenamev([SPOOL_DIR, name]);
            if (!GLib.file_set_contents(path, JSON.stringify(record))) {
                global.logError("notify-center: cannot write spool file " + path);
                return false;
            }
            return true;
        } catch (e) {
            global.logError(e);
            return false;
        }
    },

    // -- ignored notifications -------------------------------------------

    _loadIgnoredCount: function () {
        let data = readJson(IGNORED_FILE, null);
        if (data && isFinite(Number(data.count))) {
            this._ignoredCount = Math.max(0, Math.round(Number(data.count)));
        }
    },

    _noteIgnored: function () {
        this._ignoredCount += 1;
        if (this._ignoredFlushId) {
            return;
        }
        this._ignoredFlushId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            2,
            () => {
                this._ignoredFlushId = 0;
                this._flushIgnoredCount();
                return GLib.SOURCE_REMOVE;
            }
        );
    },

    _flushIgnoredCount: function () {
        try {
            GLib.mkdir_with_parents(DATA_DIR, 0o700);
            let payload = JSON.stringify({
                count: this._ignoredCount,
                updated: Math.floor(Date.now() / 1000),
            });
            if (!GLib.file_set_contents(IGNORED_FILE, payload)) {
                global.logError("notify-center: cannot write " + IGNORED_FILE);
                return;
            }
            try {
                Gio.File.new_for_path(IGNORED_FILE).set_attribute_uint32(
                    "unix::mode",
                    0o600,
                    Gio.FileQueryInfoFlags.NONE,
                    null
                );
            } catch (e) {
                global.logError(e);
            }
        } catch (e) {
            global.logError(e);
        }
    },

    // Pruning walks the spool directory, so run it at start-up and then at
    // most once an hour instead of on every 60 s tick.
    _maybePruneSpool: function () {
        let now = Math.floor(Date.now() / 1000);
        if (now - this._lastPrune < SPOOL_PRUNE_INTERVAL_SECONDS) {
            return;
        }
        this._pruneSpool();
    },

    _pruneSpool: function () {
        this._lastPrune = Math.floor(Date.now() / 1000);
        let entries = [];
        try {
            let directory = Gio.File.new_for_path(SPOOL_DIR);
            if (!directory.query_exists(null)) {
                return;
            }
            let enumerator = directory.enumerate_children(
                "standard::name,standard::type,time::modified",
                Gio.FileQueryInfoFlags.NONE,
                null
            );
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                if (info.get_file_type() !== Gio.FileType.REGULAR) {
                    continue;
                }
                let name = info.get_name();
                if (!name.endsWith(".json")) {
                    continue;
                }
                // Spool names begin with Date.now() in milliseconds, which is
                // finer-grained than time::modified. Fall back to the mtime for
                // anything that does not follow the naming scheme.
                let stamp = parseInt(name, 10);
                if (!isFinite(stamp)) {
                    stamp = info.get_attribute_uint64("time::modified") * 1000;
                }
                if (!stamp) {
                    // Unknown provenance: treat it as fresh rather than delete
                    // a file we cannot date.
                    stamp = Date.now();
                }
                entries.push({ name: name, stamp: stamp });
            }
            enumerator.close(null);
        } catch (e) {
            global.logError(e);
            return;
        }

        entries.sort((a, b) => b.stamp - a.stamp || (a.name < b.name ? 1 : -1));
        let cutoff = Date.now() - SPOOL_MAX_AGE_SECONDS * 1000;
        let removed = 0;
        for (let i = 0; i < entries.length; i++) {
            if (i < SPOOL_MAX_FILES && entries[i].stamp >= cutoff) {
                continue;
            }
            try {
                Gio.File.new_for_path(
                    GLib.build_filenamev([SPOOL_DIR, entries[i].name])
                ).delete(null);
                removed += 1;
            } catch (e) {
                global.logError(e);
            }
        }
        if (removed > 0) {
            global.log("notify-center: pruned " + removed + " stale spool file(s)");
        }
    },

    // True when a persistent_* rule matches this notification, by app name,
    // desktop-entry id or category prefix.
    _matchesPersistent: function (ndata) {
        let hints =
            ndata.hints && typeof ndata.hints === "object" ? ndata.hints : {};
        let app = asString(ndata.appName);
        let desktopEntry = asString(hints["desktop-entry"]);
        let category = asString(hints["category"]);
        return (
            this._isPersistentApp(app) ||
            this._isPersistentApp(desktopEntry) ||
            this._isPersistentCategory(category)
        );
    },

    // Keep rule-matched notifications on screen instead of letting them
    // disappear after the banner timeout. This intentionally relies on
    // Cinnamon internals and is fully guarded.
    _maybePersist: function (ndata) {
        if (!ndata || !ndata.notification) {
            return;
        }
        if (!this._matchesPersistent(ndata)) {
            return;
        }

        let daemon = Main.notificationDaemon;
        try {
            if (daemon && Array.isArray(daemon._expireNotifications)) {
                let index = daemon._expireNotifications.indexOf(ndata);
                if (index !== -1) {
                    daemon._expireNotifications.splice(index, 1);
                }
            }
            ndata.expires = 0;
            if (typeof ndata.notification.setResident === "function") {
                ndata.notification.setResident(true);
            }
            if (daemon && typeof daemon._restartExpire === "function") {
                daemon._restartExpire();
            }
        } catch (e) {
            global.logError(e);
        }
    },

    // Optional: remove a recorded notification from Cinnamon's own banner and
    // message tray so the history is the only place it lives. Persistent rules
    // opt out and keep the notification visible. Guarded like the rest of the
    // Cinnamon-internals use.
    _maybeDismiss: function (ndata) {
        if (!this._config.dismissAfterCapture || !ndata || !ndata.notification) {
            return;
        }
        if (this._matchesPersistent(ndata)) {
            return;
        }
        if (ndata.id === undefined || ndata.id === null) {
            return;
        }

        let daemon = Main.notificationDaemon;
        if (!daemon) {
            return;
        }
        try {
            if (typeof daemon.CloseNotification === "function") {
                daemon.CloseNotification(ndata.id);
                return;
            }
            // Fallback for a daemon without the D-Bus-facing method.
            let entry =
                daemon._notifications && daemon._notifications[ndata.id];
            if (
                entry &&
                entry.notification &&
                typeof entry.notification.destroy === "function"
            ) {
                entry.notification.destroy(
                    MessageTray.NotificationDestroyedReason.SOURCE_CLOSED
                );
                delete daemon._notifications[ndata.id];
            }
        } catch (e) {
            global.logError(e);
        }
    },

    // -- toast and sound --------------------------------------------------

    // Optional replacement for Cinnamon's own notification UI: an opt-in
    // toast drawn by the applet (so it is independent of Cinnamon's
    // display-notifications setting) and an opt-in sound.
    _maybeAnnounce: function (ndata) {
        if (!ndata) {
            return;
        }
        if (!this._config.toastEnabled && !this._config.soundEnabled) {
            return;
        }
        let hints =
            ndata.hints && typeof ndata.hints === "object" ? ndata.hints : {};
        let app = plainText(ndata.appName);
        let title = plainText(ndata.summary) || app || "Notification";
        let body = plainText(ndata.body);
        let icon = asString(ndata.appIcon).trim();

        // Apps ask for silence with the freedesktop suppress-sound hint.
        if (this._config.soundEnabled && hints["suppress-sound"] !== true) {
            this._playNotificationSound();
        }
        if (this._config.toastEnabled) {
            this._showToast({ app: app, title: title, body: body, icon: icon });
        }
    },

    _playNotificationSound: function () {
        try {
            let file = this._config.soundFile;
            if (!file) {
                if (this._soundSettings === undefined) {
                    try {
                        this._soundSettings = new Gio.Settings({
                            schema_id: "org.cinnamon.sounds",
                        });
                    } catch (e) {
                        this._soundSettings = null;
                    }
                }
                if (this._soundSettings) {
                    file = this._soundSettings.get_string("notification-file");
                }
            }

            let manager = Main.soundManager;
            this._soundId = (this._soundId + 1) % 100000;
            if (
                file &&
                GLib.file_test(file, GLib.FileTest.EXISTS) &&
                manager &&
                typeof manager.playSoundFile === "function"
            ) {
                manager.playSoundFile(this._soundId, file);
                return;
            }
            if (manager && typeof manager.playSound === "function") {
                manager.playSound(this._soundId, "message-new-instant");
                return;
            }
            Util.spawn(["canberra-gtk-play", "-i", "message-new-instant"]);
        } catch (e) {
            global.logError(e);
        }
    },

    _showToast: function (data) {
        let St = getSt();
        if (!St || !this._config.toastEnabled) {
            return;
        }
        try {
            if (!this._toastLayer) {
                this._ensureToastLayer(St);
            }
            if (!this._toastLayer) {
                return;
            }

            let toast = new St.Button({
                reactive: true,
                can_focus: false,
                x_expand: true,
                style:
                    "background-color: rgba(24, 24, 24, 0.96);" +
                    " background-image: none;" +
                    " border: 1px solid rgba(255, 255, 255, 0.14);" +
                    " border-radius: 8px; padding: 10px 12px;" +
                    " box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45);",
            });
            let content = new St.BoxLayout({
                vertical: false,
                style: "spacing: 10px;",
            });
            toast.set_child(content);

            content.add_child(this._makeToastIcon(St, data.icon));

            let textBox = new St.BoxLayout({
                vertical: true,
                style: "spacing: 2px;",
                x_expand: true,
            });
            content.add_child(textBox);

            if (data.app) {
                let appLabel = new St.Label({
                    text: data.app,
                    style: "color: #bdbdbd; font-size: 0.85em;",
                });
                textBox.add_child(appLabel);
            }

            let title = data.title;
            if (title.length > 120) {
                title = title.slice(0, 117) + "...";
            }
            let titleLabel = new St.Label({
                text: title,
                style: "color: #ffffff; font-weight: bold;",
            });
            titleLabel.clutter_text.line_wrap = true;
            textBox.add_child(titleLabel);

            if (data.body) {
                let body = data.body;
                if (body.length > 240) {
                    body = body.slice(0, 237) + "...";
                }
                let bodyLabel = new St.Label({
                    text: body,
                    style: "color: #e0e0e0;",
                });
                bodyLabel.clutter_text.line_wrap = true;
                textBox.add_child(bodyLabel);
            }

            toast.connect("clicked", () => {
                this._openViewer();
                this._removeToast(toast);
            });

            this._toasts.push(toast);
            this._toastLayer.add_child(toast);
            if (this._toasts.length > TOAST_MAX) {
                this._removeToast(this._toasts[0]);
            }

            toast.opacity = 0;
            let Clutter = getClutter();
            if (Clutter && Clutter.AnimationMode) {
                toast.ease({
                    opacity: 255,
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                toast.opacity = 255;
            }

            this._positionToasts();

            let seconds = numberInRange(this._config.toastTimeout, 5, 1, 60);
            toast._notifyCenterTimeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                seconds,
                () => {
                    toast._notifyCenterTimeoutId = 0;
                    this._removeToast(toast);
                    return GLib.SOURCE_REMOVE;
                }
            );
        } catch (e) {
            global.logError(e);
        }
    },

    _makeToastIcon: function (St, iconName) {
        try {
            if (iconName && iconName.charAt(0) === "/") {
                return new St.Icon({
                    gicon: new Gio.FileIcon({
                        file: Gio.File.new_for_path(iconName),
                    }),
                    icon_size: 32,
                });
            }
        } catch (e) {
            global.logError(e);
        }
        return new St.Icon({
            icon_name: iconName || "dialog-information",
            icon_size: 32,
        });
    },

    _ensureToastLayer: function (St) {
        this._toastLayer = new St.BoxLayout({
            vertical: true,
            reactive: false,
            style: "spacing: 8px; width: " + TOAST_WIDTH + "px;",
        });
        Main.layoutManager.addChrome(this._toastLayer, {
            visibleInFullscreen: false,
        });
        this._toastLayer.connect("notify::height", () =>
            this._positionToasts()
        );
        this._toastMonitorId = Main.layoutManager.connect(
            "monitors-changed",
            () => this._positionToasts()
        );
        this._positionToasts();
    },

    _positionToasts: function () {
        if (!this._toastLayer) {
            return;
        }
        let area = null;
        try {
            area = global.workspace_manager
                .get_active_workspace()
                .get_work_area_for_monitor(Main.layoutManager.primaryIndex);
        } catch (e) {
            area = null;
        }
        if (!area) {
            area = Main.layoutManager.primaryMonitor;
        }
        if (!area) {
            return;
        }
        let position = this._config.toastPosition;
        let onLeft = position.indexOf("left") !== -1;
        let onBottom = position.indexOf("bottom") !== -1;
        this._toastLayer.x = onLeft
            ? area.x + TOAST_MARGIN
            : area.x + area.width - TOAST_WIDTH - TOAST_MARGIN;
        this._toastLayer.y = onBottom
            ? area.y + area.height - this._toastLayer.height - TOAST_MARGIN
            : area.y + TOAST_MARGIN;
    },

    _removeToast: function (toast) {
        let index = this._toasts.indexOf(toast);
        if (index === -1) {
            return;
        }
        this._toasts.splice(index, 1);
        if (toast._notifyCenterTimeoutId) {
            GLib.source_remove(toast._notifyCenterTimeoutId);
            toast._notifyCenterTimeoutId = 0;
        }
        try {
            toast.destroy();
        } catch (e) {
            global.logError(e);
        }
        this._positionToasts();
    },

    _destroyToasts: function () {
        for (let i = 0; i < this._toasts.length; i += 1) {
            let toast = this._toasts[i];
            if (toast._notifyCenterTimeoutId) {
                GLib.source_remove(toast._notifyCenterTimeoutId);
                toast._notifyCenterTimeoutId = 0;
            }
        }
        this._toasts = [];
        if (this._toastLayer) {
            try {
                Main.layoutManager.removeChrome(this._toastLayer);
            } catch (e) {
                global.logError(e);
            }
            this._toastLayer.destroy();
            this._toastLayer = null;
        }
        if (this._toastMonitorId) {
            try {
                Main.layoutManager.disconnect(this._toastMonitorId);
            } catch (e) {
                global.logError(e);
            }
            this._toastMonitorId = 0;
        }
    },

    // -- status -----------------------------------------------------------

    _setupStatusMonitor: function () {
        try {
            GLib.mkdir_with_parents(DATA_DIR, 0o700);
            let directory = Gio.File.new_for_path(DATA_DIR);
            this._statusMonitor = directory.monitor_directory(
                Gio.FileMonitorFlags.NONE,
                null
            );
            this._statusMonitor.connect(
                "changed",
                (monitor, file, otherFile, eventType) => {
                    let name = "";
                    try {
                        name = file ? file.get_basename() : "";
                    } catch (e) {
                        name = "";
                    }
                    if (name === "status.json") {
                        this._updateBadge();
                    }
                }
            );
        } catch (e) {
            global.logError(e);
        }
    },

    // The viewer writes config.json atomically (temporary file + rename), so
    // watch the directory rather than the file itself and filter by name.
    _setupConfigMonitor: function () {
        try {
            let directory = GLib.build_filenamev([
                GLib.get_user_config_dir(),
                APP_NAME,
            ]);
            GLib.mkdir_with_parents(directory, 0o700);
            this._configMonitor = Gio.File.new_for_path(
                directory
            ).monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._configMonitor.connect(
                "changed",
                (monitor, file, otherFile, eventType) => {
                    let name = "";
                    try {
                        name = file ? file.get_basename() : "";
                    } catch (e) {
                        name = "";
                    }
                    if (name === "config.json") {
                        this._loadConfig();
                        this._updateBadge();
                    }
                }
            );
        } catch (e) {
            global.logError(e);
        }
    },

    _updateBadge: function () {
        let status = readJson(STATUS_FILE, null);
        let unread = 0;
        if (status && isFinite(Number(status.unread))) {
            unread = Math.max(0, Math.round(Number(status.unread)));
        }

        let stale = true;
        if (status && isFinite(Number(status.updated))) {
            let age = Math.floor(Date.now() / 1000) - Number(status.updated);
            stale = age > STATUS_STALE_SECONDS;
        }

        this.set_applet_label(unread > 0 ? String(unread) : "");
        this.set_applet_icon_name(stale ? "dialog-warning" : "dialog-information");

        let tooltip =
            unread > 0
                ? "Notification Center — " + unread + " unread"
                : "Notification Center";
        if (stale) {
            tooltip += "\nCollector is not running";
        }
        this.set_applet_tooltip(tooltip);

        if (this._menuCount) {
            this._menuCount.setLabel(
                unread > 0 ? unread + " unread" : "No unread notifications"
            );
        }
    },
};

function main(metadata, orientation, panelHeight, instanceId) {
    return new NotificationCenterApplet(
        metadata,
        orientation,
        panelHeight,
        instanceId
    );
}
