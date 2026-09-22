# Boat banner regression tests

These tests exercise boat arrival and waypoint routing, resize handling, pointer and keyboard input, ship trajectory identity, selector storage, telemetry wrapping, and pennant behavior in headless Firefox.

Run from the repository root:

```sh
python3 prototypes/tests/run_regression.py
```

Requirements: Python 3 and Firefox. Set `FIREFOX` if the Firefox executable is not on `PATH`.

The runner reads JSON from `#output.textContent` because Marionette's Xray sandbox does not expose page-created `window` expandos.
