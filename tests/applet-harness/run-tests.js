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

Main.notificationDaemon._notifyForSource({}, {
    id: 12,
    appName: "Noisy",
    summary: "Ignored",
    body: "Ignored",
    hints: {},
});
check("ignored app skipped", spoolFiles().length === before);

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

const configSpawnBefore = Util.spawned.length;
applet._openConfig();
check(
    "config file opened",
    Util.spawned.length === configSpawnBefore + 1 &&
        String(Util.spawned[Util.spawned.length - 1][0]) === "xdg-open",
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

if (failures.length > 0) {
    print("\n" + failures.length + " failure(s):");
    for (const failure of failures) {
        print(" - " + failure);
    }
    System.exit(1);
}

print("\n" + passed + " applet checks passed");
System.exit(0);
