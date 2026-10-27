// Applet test harness: loads the real applet.js against fake Cinnamon modules.
// Run with run.sh so XDG_* and GJS_PATH are set up.

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const System = imports.system;
const Main = imports.ui.main;
const Util = imports.misc.util;

globalThis.global = globalThis;
globalThis.logError = function (error) {
    print("logError: " + error);
};

const HOME = GLib.get_home_dir();
const DATA_DIR = GLib.get_user_data_dir() + "/notify-center";
const SPOOL_DIR = DATA_DIR + "/spool";
const STATUS_FILE = DATA_DIR + "/status.json";
const IGNORED_FILE = DATA_DIR + "/ignored.json";
const CONFIG_FILE = GLib.get_user_config_dir() + "/notify-center/config.json";

let passed = 0;
let failures = [];

function check(name, condition, detail) {
    if (condition) {
        passed += 1;
        print("ok   " + name);
    } else {
        const suffix = detail === undefined ? "" : ": " + detail;
        failures.push(name + suffix);
        print("FAIL " + name + suffix);
    }
}

function readJsonFile(path) {
    let [ok, contents] = GLib.file_get_contents(path);
    if (!ok) {
        throw new Error("cannot read " + path);
    }
    return JSON.parse(new TextDecoder().decode(contents));
}

function writeJsonFile(path, value) {
    if (!GLib.file_set_contents(path, JSON.stringify(value))) {
        throw new Error("cannot write " + path);
    }
}

function spoolFiles() {
    const directory = Gio.File.new_for_path(SPOOL_DIR);
    if (!directory.query_exists(null)) {
        return [];
    }
    const enumerator = directory.enumerate_children(
        "standard::name",
        Gio.FileQueryInfoFlags.NONE,
        null
    );
    const names = [];
    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        const name = info.get_name();
        if (name.endsWith(".json")) {
            names.push(name);
        }
    }
    enumerator.close(null);
    names.sort();
    return names;
}

function allRecords() {
    return spoolFiles().map((name) => readJsonFile(SPOOL_DIR + "/" + name));
}

// ---------------------------------------------------------------------------

const appletPath = GLib.getenv("NOTIFY_CENTER_APPLET");
let [ok, contents] = GLib.file_get_contents(appletPath);
if (!ok) {
    print("cannot read applet at " + appletPath);
    System.exit(2);
}

let mainFunction;
try {
    mainFunction = eval(new TextDecoder().decode(contents) + "\n; main;");
} catch (error) {
    print("applet syntax/load error: " + error);
    System.exit(2);
}

const applet = mainFunction({}, 0, 0, 1);
check("applet initializes", !!applet);
check(
    "uses snake_case icon API",
    applet.icons.indexOf("dialog-information") !== -1,
    JSON.stringify(applet.icons)
);

const originalMethod = Main.notificationDaemon._notifyForSource;
applet.on_applet_added_to_panel();
check("hook installed", Main.notificationDaemon._notifyForSource !== originalMethod);
check("config monitor installed", applet._configMonitor !== null);

const first = {
    id: 10,
    appName: "Thunderbird",
    appIcon: "mail-unread",
    summary: "New email",
    body: "Hello there",
    actions: ["default", "Open"],
    hints: {
        category: "email.arrived",
        urgency: 2,
        "desktop-entry": "thunderbird.desktop",
        "image-data": "binary-blob",
        resident: false,
    },
};
const returned = Main.notificationDaemon._notifyForSource({}, first);
check("original handler still called", Main.notificationDaemon.calls.length === 1);
check("return value passed through", returned === "shown", String(returned));

let records = allRecords();
check("one spool file written", records.length === 1, String(records.length));
const record = records[0] || {};
check("app recorded", record.app === "Thunderbird", record.app);
check("title recorded", record.title === "New email", record.title);
check("body recorded", record.body === "Hello there", record.body);
check("urgency recorded", record.urgency === 2, String(record.urgency));
check("desktop entry recorded", record.desktop_entry === "thunderbird.desktop");
check("new notification is not an update", record.is_update === false);
check("session recorded", typeof record.session === "string" && record.session.length > 0);
check("hints category recorded", record.hints && record.hints.category === "email.arrived");
check("binary image hints dropped", record.hints && record.hints["image-data"] === undefined);
check("timestamp recorded", Number(record.timestamp) > 1600000000);

const resident = {
    resident: false,
    setResident(value) {
        this.resident = value;
    },
};
const update = {
    id: 10,
    appName: "Thunderbird",
    summary: "New email (updated)",
    body: "Second line",
    notification: resident,
    hints: { category: "email.arrived" },
};
Main.notificationDaemon._notifyForSource({}, update);
records = allRecords();
const updateRecord = records.find((item) => item.is_update === true);
check("replacement marked as update", !!updateRecord);
check(
    "replacement has same source id",
    updateRecord && updateRecord.source_id === 10,
    updateRecord && String(updateRecord.source_id)
);

let before = spoolFiles().length;
Main.notificationDaemon._notifyForSource({}, {
    id: 11,
    appName: "Spotify",
    summary: "Now playing",
    body: "A song",
    hints: { transient: true },
});
check("transient notification skipped", spoolFiles().length === before);

const ignoredBefore = applet._ignoredCount;
Main.notificationDaemon._notifyForSource({}, {
    id: 12,
    appName: "Noisy",
    summary: "Ignored",
    body: "Ignored",
    hints: {},
});
check("ignored app skipped", spoolFiles().length === before);
check(
    "ignored counter increments",
    applet._ignoredCount === ignoredBefore + 1,
    String(applet._ignoredCount)
);
applet._flushIgnoredCount();
const ignoredData = readJsonFile(IGNORED_FILE);
check(
    "ignored counter persisted",
    ignoredData.count === ignoredBefore + 1,
    JSON.stringify(ignoredData)
);
applet._ignoredCount = 0;
applet._loadIgnoredCount();
check(
    "ignored counter reloads from disk",
    applet._ignoredCount === ignoredBefore + 1,
    String(applet._ignoredCount)
);

const keepResident = {
    resident: false,
    setResident(value) {
        this.resident = value;
    },
};
const persistent = {
    id: 13,
    appName: "Thunderbird",
    summary: "Keep this",
    body: "Do not expire",
    notification: keepResident,
    hints: {},
};
Main.notificationDaemon._expireNotifications = [persistent];
const restartsBefore = Main.notificationDaemon.restarted;
Main.notificationDaemon._notifyForSource({}, persistent);
check(
    "persistent notification removed from expiry queue",
    Main.notificationDaemon._expireNotifications.indexOf(persistent) === -1
);
check("persistent notification marked resident", keepResident.resident === true);
check("expiry timer restarted", Main.notificationDaemon.restarted > restartsBefore);
check("expires reset", persistent.expires === 0);

// -- dismiss_after_capture --------------------------------------------------

const daemon = Main.notificationDaemon;

function dismissConfig(enabled) {
    writeJsonFile(CONFIG_FILE, {
        ignore_transient: true,
        ignore_apps: ["Noisy"],
        persistent_apps: ["Thunderbird"],
        persistent_categories: ["im.received"],
        dismiss_after_capture: enabled,
    });
    applet._loadConfig();
}

function notify(id, appName, hints, notification) {
    const ndata = {
        id: id,
        appName: appName,
        summary: "Dismiss me",
        body: "body",
        notification: notification || { setResident() {} },
        hints: hints || {},
    };
    daemon._notifyForSource({}, ndata);
    return ndata;
}

daemon.closed.length = 0;
dismissConfig(false);
notify(20, "Signal");
check(
    "dismiss disabled leaves the notification alone",
    daemon.closed.length === 0,
    JSON.stringify(daemon.closed)
);

daemon.closed.length = 0;
dismissConfig(true);
const dismissable = notify(21, "Signal");
check(
    "recorded notification dismissed from Cinnamon",
    daemon.closed.length === 1 && daemon.closed[0] === 21,
    JSON.stringify(daemon.closed)
);
check(
    "dismissed notification still written to the spool",
    allRecords().some((item) => item.source_id === 21)
);

daemon.closed.length = 0;
notify(22, "Noisy");
check(
    "ignored app is not dismissed",
    daemon.closed.length === 0,
    JSON.stringify(daemon.closed)
);

daemon.closed.length = 0;
notify(23, "Signal", { transient: true });
check(
    "ignored transient is not dismissed",
    daemon.closed.length === 0,
    JSON.stringify(daemon.closed)
);

daemon.closed.length = 0;
notify(24, "Thunderbird");
check(
    "persistent app wins over dismissal",
    daemon.closed.length === 0,
    JSON.stringify(daemon.closed)
);

daemon.closed.length = 0;
notify(25, "Signal", { category: "im.received" });
check(
    "persistent category wins over dismissal",
    daemon.closed.length === 0,
    JSON.stringify(daemon.closed)
);

writeJsonFile(CONFIG_FILE, {
    ignore_transient: true,
    ignore_apps: [],
    persistent_apps: [],
    persistent_categories: [],
    dismiss_after_capture: "true",
});
applet._loadConfig();
check(
    "only JSON true enables dismissal",
    applet._config.dismissAfterCapture === false
);

// Older daemons may lack the D-Bus-facing CloseNotification method; the
// fallback destroys the notification object directly.
dismissConfig(true);
const originalClose = daemon.CloseNotification;
delete daemon.CloseNotification;
let destroyedReason = null;
const fallbackNotification = {
    destroy(reason) {
        destroyedReason = reason;
    },
};
daemon._notifications[26] = { notification: fallbackNotification };
notify(26, "Signal", {}, fallbackNotification);
daemon.CloseNotification = originalClose;
check(
    "fallback destroys the notification",
    destroyedReason === imports.ui.messageTray.NotificationDestroyedReason.SOURCE_CLOSED,
    String(destroyedReason)
);
check(
    "fallback clears the daemon map entry",
    !(26 in daemon._notifications)
);

// -- toast and sound --------------------------------------------------------

const toastsShown = [];
const soundsPlayed = [];
const realShowToast = applet._showToast;
const realPlaySound = applet._playNotificationSound;
applet._showToast = function (data) {
    toastsShown.push(data);
};
applet._playNotificationSound = function () {
    soundsPlayed.push(true);
};

function announceConfig(options) {
    writeJsonFile(CONFIG_FILE, {
        ignore_transient: true,
        ignore_apps: ["Noisy"],
        persistent_apps: ["Thunderbird"],
        persistent_categories: ["im.received"],
        dismiss_after_capture: false,
        toast_enabled: options.toast === true,
        toast_timeout: options.timeout === undefined ? 5 : options.timeout,
        toast_position:
            options.position === undefined ? "top-right" : options.position,
        sound_enabled: options.sound === true,
        sound_file: options.soundFile === undefined ? "" : options.soundFile,
    });
    applet._loadConfig();
}

function deliver(id, appName, hints, notification) {
    daemon._notifyForSource({}, {
        id: id,
        appName: appName,
        summary: "Toast title",
        body: "Toast body",
        notification: notification || { setResident() {} },
        hints: hints || {},
    });
}

announceConfig({});
deliver(30, "Signal");
check("no toast when disabled", toastsShown.length === 0, String(toastsShown.length));
check("no sound when disabled", soundsPlayed.length === 0, String(soundsPlayed.length));

announceConfig({ toast: true });
deliver(31, "Signal");
check("toast shown when enabled", toastsShown.length === 1, String(toastsShown.length));
check(
    "toast carries app, title and body",
    toastsShown[0] &&
        toastsShown[0].app === "Signal" &&
        toastsShown[0].title === "Toast title" &&
        toastsShown[0].body === "Toast body",
    JSON.stringify(toastsShown[0])
);
check("toast does not force sound", soundsPlayed.length === 0);

announceConfig({ sound: true });
deliver(32, "Signal");
check("sound played when enabled", soundsPlayed.length === 1, String(soundsPlayed.length));
check("sound alone does not toast", toastsShown.length === 1, String(toastsShown.length));

deliver(33, "Signal", { "suppress-sound": true });
check(
    "suppress-sound hint respected",
    soundsPlayed.length === 1,
    String(soundsPlayed.length)
);

announceConfig({ toast: true, sound: true });
deliver(34, "Noisy");
check(
    "ignored app neither toasts nor sounds",
    toastsShown.length === 1 && soundsPlayed.length === 1
);
deliver(35, "Signal", { transient: true });
check(
    "ignored transient neither toasts nor sounds",
    toastsShown.length === 1 && soundsPlayed.length === 1
);

announceConfig({ timeout: 999, position: "middle" });
check("toast timeout clamped", applet._config.toastTimeout === 60, String(applet._config.toastTimeout));
check("invalid toast position falls back", applet._config.toastPosition === "top-right");

writeJsonFile(CONFIG_FILE, {
    ignore_transient: true,
    toast_enabled: "true",
    sound_enabled: "true",
});
applet._loadConfig();
check(
    "only JSON true enables toast and sound",
    applet._config.toastEnabled === false && applet._config.soundEnabled === false
);

applet._playNotificationSound = realPlaySound;
const soundPath =
    "/usr/share/sounds/freedesktop/stereo/message-new-instant.oga";
applet._config.soundFile = soundPath;
Main.soundManager.played.length = 0;
applet._playNotificationSound();
check(
    "configured sound file is played",
    Main.soundManager.played.length === 1 &&
        Main.soundManager.played[0] === soundPath,
    JSON.stringify(Main.soundManager.played)
);
applet._playNotificationSound = realPlaySound;
applet._showToast = realShowToast;

// Leave the harness config in the state later checks expect.
writeJsonFile(CONFIG_FILE, {
    ignore_transient: true,
    ignore_apps: ["Noisy"],
    persistent_apps: ["Thunderbird"],
    persistent_categories: ["im.received"],
    dismiss_after_capture: false,
});
applet._loadConfig();

writeJsonFile(STATUS_FILE, {
    unread: 7,
    total: 9,
    updated: Math.floor(Date.now() / 1000),
});
applet._updateBadge();
check(
    "badge shows unread count",
    applet.labels[applet.labels.length - 1] === "7",
    applet.labels[applet.labels.length - 1]
);
check(
    "tooltip shows unread count",
    String(applet.tooltips[applet.tooltips.length - 1]).indexOf("7 unread") !== -1,
    applet.tooltips[applet.tooltips.length - 1]
);
check(
    "menu count updated",
    applet._menuCount.label.text === "7 unread",
    applet._menuCount.label.text
);

writeJsonFile(STATUS_FILE, { unread: 0, total: 0, updated: 1 });
applet._updateBadge();
check(
    "stale collector reported",
    String(applet.tooltips[applet.tooltips.length - 1]).indexOf(
        "Collector is not running"
    ) !== -1,
    applet.tooltips[applet.tooltips.length - 1]
);
check("badge cleared", applet.labels[applet.labels.length - 1] === "");
check(
    "stale collector shows warning icon",
    applet.icons[applet.icons.length - 1] === "dialog-warning",
    applet.icons[applet.icons.length - 1]
);

writeJsonFile(STATUS_FILE, {
    unread: 0,
    total: 0,
    updated: Math.floor(Date.now() / 1000),
});
applet._updateBadge();
check(
    "fresh status restores normal icon",
    applet.icons[applet.icons.length - 1] === "dialog-information",
    applet.icons[applet.icons.length - 1]
);

applet.on_applet_clicked();
check("applet click opens menu", applet.menu.isOpen === true);
applet.on_applet_clicked();
check("applet click closes menu", applet.menu.isOpen === false);

const oldMenu = applet.menu;
applet.on_orientation_changed(1);
check(
    "orientation change rebuilds menu",
    applet.menu !== oldMenu && applet.menu !== null
);

const savedConfig = readJsonFile(CONFIG_FILE);

Gio.File.new_for_path(CONFIG_FILE).delete(null);
applet._loadConfig();
check(
    "missing config defaults to notify-center",
    applet._config.toastEnabled === true &&
        applet._config.soundEnabled === true &&
        applet._config.dismissAfterCapture === true
);
writeJsonFile(CONFIG_FILE, savedConfig);
applet._loadConfig();

// An existing config from an older version keeps the opt-in defaults for keys
// it does not have.
writeJsonFile(CONFIG_FILE, { ignore_transient: true });
applet._loadConfig();
check(
    "legacy config keeps the opt-in defaults",
    applet._config.toastEnabled === false &&
        applet._config.soundEnabled === false &&
        applet._config.dismissAfterCapture === false
);
writeJsonFile(CONFIG_FILE, savedConfig);
applet._loadConfig();

// Config changes apply without a Cinnamon restart.
const monitorConfig = readJsonFile(CONFIG_FILE);
writeJsonFile(CONFIG_FILE, { ...monitorConfig, toast_enabled: false });
applet._loadConfig();
check("config monitor baseline", applet._config.toastEnabled === false);

const monitorLoop = new GLib.MainLoop(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
    writeJsonFile(CONFIG_FILE, { ...monitorConfig, toast_enabled: true });
    return GLib.SOURCE_REMOVE;
});
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
    if (applet._config.toastEnabled) {
        monitorLoop.quit();
        return GLib.SOURCE_REMOVE;
    }
    return GLib.SOURCE_CONTINUE;
});
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
    monitorLoop.quit();
    return GLib.SOURCE_REMOVE;
});
monitorLoop.run();
check(
    "config monitor reloads changes without restart",
    applet._config.toastEnabled === true
);
writeJsonFile(CONFIG_FILE, monitorConfig);
applet._loadConfig();

const prefsSpawnBefore = Util.spawned.length;
applet._openPreferences();
check(
    "preferences launched with --settings",
    Util.spawned.length === prefsSpawnBefore + 1 &&
        String(Util.spawned[Util.spawned.length - 1][1]) === "--settings",
    JSON.stringify(Util.spawned[Util.spawned.length - 1])
);

const aboutSpawnBefore = Util.spawned.length;
applet._openAbout();
check(
    "about item opens the repository",
    Util.spawned.length === aboutSpawnBefore + 1 &&
        String(Util.spawned[Util.spawned.length - 1][0]) === "xdg-open" &&
        String(Util.spawned[Util.spawned.length - 1][1]).indexOf(
            "github.com/jt-at-home/notify-center"
        ) !== -1,
    JSON.stringify(Util.spawned[Util.spawned.length - 1])
);

const spawnedBefore = Util.spawned.length;
applet._openViewer();
check(
    "viewer launched",
    Util.spawned.length === spawnedBefore + 1 &&
        Util.spawned[Util.spawned.length - 1][0] ===
            HOME + "/.local/bin/notify-center-viewer",
    JSON.stringify(Util.spawned[Util.spawned.length - 1])
);

writeJsonFile(CONFIG_FILE, {
    ignore_transient: true,
    ignore_apps: [],
    persistent_apps: [],
    persistent_categories: ["im"],
});
applet._loadConfig();
check("category prefix matches", applet._isPersistentCategory("im.received") === true);
check(
    "category prefix does not over-match",
    applet._isPersistentCategory("email.arrived") === false
);

// -- spool retention --------------------------------------------------------

const staleName = Date.now() - 40 * 24 * 60 * 60 * 1000 + "-stale.json";
writeJsonFile(SPOOL_DIR + "/" + staleName, { v: 2 });
applet._pruneSpool();
check(
    "expired spool file pruned",
    spoolFiles().indexOf(staleName) === -1,
    String(spoolFiles().length)
);

const recentCount = spoolFiles().length;
applet._pruneSpool();
check(
    "recent spool files kept under the cap",
    spoolFiles().length === recentCount,
    String(spoolFiles().length)
);

const newestName = String(Date.now() + 1000) + "-newest.json";
writeJsonFile(SPOOL_DIR + "/" + newestName, { v: 2 });
const bulkBase = Date.now() - 7 * 24 * 60 * 60 * 1000;
const oldestBulkName = String(bulkBase) + "-bulk.json";
for (let i = 0; i < 2005; i += 1) {
    writeJsonFile(SPOOL_DIR + "/" + (bulkBase + i) + "-bulk.json", { v: 2 });
}
applet._pruneSpool();
check(
    "spool capped at 2000 files",
    spoolFiles().length === 2000,
    String(spoolFiles().length)
);
check(
    "pruning keeps the newest spool file",
    spoolFiles().indexOf(newestName) !== -1
);
check(
    "pruning drops the oldest spool files first",
    spoolFiles().indexOf(oldestBulkName) === -1
);

applet.on_applet_removed_from_panel();
check(
    "hook restored on removal",
    Main.notificationDaemon._notifyForSource === originalMethod
);
check("menu destroyed on removal", applet.menu === null);
check("config monitor cancelled on removal", applet._configMonitor === null);

if (failures.length > 0) {
    print("\n" + failures.length + " failure(s):");
    for (const failure of failures) {
        print(" - " + failure);
    }
    System.exit(1);
}

print("\n" + passed + " applet checks passed");
System.exit(0);
