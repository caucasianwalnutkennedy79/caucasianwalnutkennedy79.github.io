# Boat banner regression tests (built site)

The same checks as `prototypes/tests/` (boat arrival and waypoint routing, resize
handling, pointer and keyboard input, ship trajectory identity, selector storage,
telemetry wrapping, pennant behaviour), run in headless Firefox against the
**built** site instead of the prototype.

Run from the repository root:

```sh
npm run test:banner
```

which does:

1. `npm run build` — the production build in `dist/`.
2. `BANNER_TEST=1 astro build --outDir .banner-test-dist` — the same site plus one
   test-only page, `/__banner-test/`, injected by `astro.config.mjs` only when
   `BANNER_TEST=1`. It renders the real layout (real `BoatBanner` component, global
   CSS and colour tokens) and puts `initBoatBanner` from `src/scripts/boat-banner.js`
   on `window` — the module the component itself imports, bundled into one shared
   chunk. The `persistsAcrossReload` check reloads the shipped home page `/`.
3. `python3 tests/banner/run_regression.py` — first fails if any file in `dist/`
   contains the test-only marker string from `BannerTestPage.astro` (which must be
   present in the test build's HTML and JS) or any `__banner-test` path exists in
   `dist/`, then serves `.banner-test-dist/` at `/` and `regression.html`
   at `/__banner-harness/` (so the harness is never in any build output), drives
   Firefox via Marionette and reads JSON from `#output.textContent` (Marionette's
   Xray sandbox does not expose page-created `window` expandos).

Besides the prototype's checks on a harness-built banner, `componentChecks` drive the
test page's real `<BoatBanner />` as initialized by the component's own script
(canvas backing store sized, tap queues a waypoint, telemetry updates, clear stops the
route, the ship select persists). Page errors are collected from the start of page
load by an inline script on the test page; any error, or a missing collector, fails
the run.

Expected: `PASS: 838/838 navigation cases and all extra checks`, exit code 0.

Requirements: Python 3 and Firefox. Set `FIREFOX` if the Firefox executable is not
on `PATH` (the Snap build at `/snap/firefox/current/usr/lib/firefox/firefox` is
tried automatically). The npm script uses POSIX `VAR=value` syntax.
