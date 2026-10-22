// Fake misc.util for the applet test harness.
var spawned = [];

function spawn(argv) {
    spawned.push(argv);
    return true;
}

function spawnCommandLine(command) {
    spawned.push(command);
    return true;
}
