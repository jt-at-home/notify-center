// Fake Cinnamon notification daemon for the applet test harness.
var notificationDaemon = {
    calls: [],
    restarted: 0,
    _expireNotifications: [],
    _notifyForSource: function (source, ndata) {
        this.calls.push({ source: source, ndata: ndata });
        return "shown";
    },
    _restartExpire: function () {
        this.restarted += 1;
    },
};
