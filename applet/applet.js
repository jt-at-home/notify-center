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
// leaves Cinnamon alone.

const Applet = imports.ui.applet;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

const APP_NAME = "notify-center";
const DATA_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), APP_NAME]);
const SPOOL_DIR = GLib.build_filenamev([DATA_DIR, "spool"]);
const STATUS_FILE = GLib.build_filenamev([DATA_DIR, "status.json"]);
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
        };
        this._hooked = false;
        this._originalNotifyForSource = null;
        this._statusMonitor = null;
        this._timeoutId = 0;
        this._menuCount = null;
        this._lastPrune = 0;

        this._loadConfig();
        try {
            GLib.mkdir_with_parents(SPOOL_DIR, 0o700);
        } catch (e) {
            global.logError(e);
        }
        this._pruneSpool();

        this._buildMenu(orientation);
        this._setupStatusMonitor();
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
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._statusMonitor) {
            this._statusMonitor.cancel();
            this._statusMonitor = null;
        }
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

        let configItem = new PopupMenu.PopupMenuItem("Open configuration file");
        configItem.connect("activate", () => this._openConfig());
        this.menu.addMenuItem(configItem);

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

    _openViewer: function () {
        let candidates = [];
        let onPath = GLib.find_program_in_path(VIEWER_NAME);
        if (onPath) {
            candidates.push(onPath);
        }
        candidates.push(
            GLib.build_filenamev([
                GLib.get_home_dir(),
                ".local",
                "bin",
                VIEWER_NAME,
            ])
        );

        for (let i = 0; i < candidates.length; i++) {
            if (GLib.file_test(candidates[i], GLib.FileTest.IS_EXECUTABLE)) {
                Util.spawn([candidates[i]]);
                return;
            }
        }
        global.logError(
            "notify-center: viewer not found; reinstall with install-notify-center.sh"
        );
        this.set_applet_tooltip("Notification Center — viewer is not installed");
    },

    _openConfig: function () {
        let target = GLib.file_test(CONFIG_FILE, GLib.FileTest.EXISTS)
            ? CONFIG_FILE
            : GLib.build_filenamev([GLib.get_user_config_dir(), APP_NAME]);
        Util.spawn(["xdg-open", target]);
    },

    _openAbout: function () {
        Util.spawn(["xdg-open", PROJECT_URL]);
    },

    // -- config -----------------------------------------------------------

    _loadConfig: function () {
        let raw = readJson(CONFIG_FILE, null);
        if (!raw || typeof raw !== "object") {
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
        };
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
            try {
                self._capture(ndata);
            } catch (e) {
                global.logError(e);
            }
            try {
                return self._originalNotifyForSource.call(this, source, ndata);
            } finally {
                try {
                    self._maybePersist(ndata);
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
            return;
        }
        let hints =
            ndata.hints && typeof ndata.hints === "object" ? ndata.hints : {};
        let transient = hints["transient"] === true;
        if (transient && this._config.ignoreTransient) {
            return;
        }

        let app = asString(ndata.appName);
        let desktopEntry = asString(hints["desktop-entry"]);
        if (this._isIgnored(app) || this._isIgnored(desktopEntry)) {
            return;
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
        this._writeSpool(record);
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

    // Keep rule-matched notifications on screen instead of letting them
    // disappear after the banner timeout. This intentionally relies on
    // Cinnamon internals and is fully guarded.
    _maybePersist: function (ndata) {
        if (!ndata || !ndata.notification) {
            return;
        }
        let hints =
            ndata.hints && typeof ndata.hints === "object" ? ndata.hints : {};
        let app = asString(ndata.appName);
        let desktopEntry = asString(hints["desktop-entry"]);
        let category = asString(hints["category"]);
        if (
            !this._isPersistentApp(app) &&
            !this._isPersistentApp(desktopEntry) &&
            !this._isPersistentCategory(category)
        ) {
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
