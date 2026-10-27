# Testing

Run from the repository root:

```bash
# Collector unit tests (spool, dedupe, retention, hint sanitizing)
python3 -m unittest discover -s tests -p 'test_*.py' -v

# Applet logic against stubbed Cinnamon modules
./tests/applet-harness/run.sh

# Check the private Cinnamon APIs this applet uses still exist
./tests/check-cinnamon-api.sh

# Install/uninstall into a throwaway HOME
./tests/test-installer.sh

# Everything, end to end
./tests/smoke-test.sh
```

`smoke-test.sh` seeds a spool, runs the collector, checks the database and
status file, runs the collector tests, starts the viewer in self-test mode
(`notify-center-viewer --self-test` builds the UI, prints the row count and
exits), and runs the applet harness.

The applet harness stubs `St`, so it covers toast and sound *gating* (config,
ignored apps, `suppress-sound`, clamping) but not the rendered toast itself.
Toast placement, styling and click behaviour need a live Cinnamon session.
