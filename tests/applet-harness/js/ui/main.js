// Fake Cinnamon notification daemon for the applet test harness.
var notificationDaemon = {
    calls: [],
    closed: [],
    restarted: 0,
    _expireNotifications: [],
    _notifications: {},
    _notifyForSource: function (source, ndata) {
        this.calls.push({ source: source, ndata: ndata });
        return "shown";
    },
    _restartExpire: function () {
        this.restarted += 1;
    },
    CloseNotification: function (id) {
        this.closed.push(id);
        delete this._notifications[id];
    },
};

// Fake Cinnamon sound manager: records whatever would have been played.
var soundManager = {
    played: [],
    playSoundFile: function (id, filename) {
        this.played.push(filename);
    },
    playSound: function (id, name) {
        this.played.push(name);
    },
};
