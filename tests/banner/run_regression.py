#!/usr/bin/env python3
"""Run the boat-banner regression harness against the built site in headless Firefox.

Copy of prototypes/tests/run_regression.py adapted to the Astro build. It serves
the BANNER_TEST=1 build (default .banner-test-dist/) at the site root and this
directory's regression.html at /__banner-harness/, so the harness never ships in
dist/. It also checks that the production build (dist/) contains no test files.
Run via `npm run test:banner`, which builds both first.
"""

import argparse
import functools
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request


TESTS_DIR = Path(__file__).resolve().parent
REPO_DIR = TESTS_DIR.parent.parent
HARNESS_PREFIX = "/__banner-harness/"
TEST_PAGE = "__banner-test"
# Unique string that exists only in test-only code (tests/banner/BannerTestPage.astro).
LEAK_MARKER = b"BANNER_TEST_MARKER_7c41e0d9"
EXPECTED_CASES = 838
SNAP_FIREFOX = Path("/snap/firefox/current/usr/lib/firefox/firefox")
# Client-side navigation away from the test page with the real <ClientRouter />.
NAVIGATION_CHECKS = (
    "voyageStarted",
    "clientSideNavigation",
    "canvasPersisted",
    "initOnce",
    "positionContinuous",
    "queueContinued",
    "shipUnchanged",
    "loopRunning",
    "bannerNotAnimated",
    "titleAndCanonicalUpdated",
    "ariaCurrentUpdated",
    "routeAnnounced",
    "scrollResetForward",
    "focusReset",
    "resizeAfterNav",
    "tapAfterNav",
    "pausesOffscreen",
    "resumesInView",
    "detailScrollReset",
    "copyBibtexAfterNav",
    "backRestoresScroll",
    "copyBibtexRevisit",
    "stillSameDocument",
    "skipLinkAfterNav",
    "returnPersistsBanner",
    "noBannerPageDropsBanner",
    "revivedBannerInitialised",
    "revivedBannerLoopRunning",
    "revivedBannerTapQueued",
)
EXPECTED_CHECKS = {
    "telemetryChecks": ("wrapsRoundedHeading",),
    "pointerChecks": (
        "tapQueued",
        "swipeIgnored",
        "longPressIgnored",
        "cancelIgnored",
        "shiftClears",
        "keyRepeatIgnored",
        "zeroSizeSafe",
        "waypointLimitClamped",
    ),
    "shipChecks": (
        "trajectoryIdentical",
        "trajectoriesSettled",
        "midVoyageSwitchPreservesState",
        "stoppedSwitchStaysIdle",
        "pennantFixedLength",
        "pennantAlwaysAft",
        "reducedMotionPennantStatic",
        "stoppedPennantStatic",
        "selectDoesNotQueue",
        "selectKeysDoNotQueue",
        "bogusStorageFallsBack",
        "storedShipOverridesOption",
        "optionAppliesWithoutPersisting",
        "bogusApiShipIgnored",
        "blockedStorageSafe",
        "persistsAcrossReload",
    ),
    # The real, component-initialized <BoatBanner /> on the test page.
    "componentChecks": (
        "elementsPresent",
        "backingStoreSized",
        "tapQueuesWaypoint",
        "telemetryUpdates",
        "clearStopsRoute",
        "selectPersistsShip",
    ),
    "navigationChecks": NAVIGATION_CHECKS,
    # The same with the View Transition API and moveBefore() deleted (?fallback=1):
    # the router's fallback swap, as in Safari and older browsers.
    "navigationFallbackChecks": NAVIGATION_CHECKS + ("fallbackPathTaken",),
}


class RunnerError(RuntimeError):
    pass


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass


class SiteHandler(QuietHandler):
    """Serve the built site at /, and tests/banner/ files under HARNESS_PREFIX."""

    def translate_path(self, path):
        route = path.split("?", 1)[0].split("#", 1)[0]
        if route.startswith(HARNESS_PREFIX):
            name = route[len(HARNESS_PREFIX):]
            if "/" in name or name not in {"regression.html"}:
                return str(TESTS_DIR / "__missing__")
            return str(TESTS_DIR / name)
        return super().translate_path(path)


def files_containing_marker(root):
    return [
        str(path.relative_to(root))
        for path in sorted(root.rglob("*"))
        if path.is_file() and LEAK_MARKER in path.read_bytes()
    ]


def check_production_dist(dist, site):
    """Production build must exist and contain no test-only artefacts.

    Every file in dist/ is searched for LEAK_MARKER. The test build must contain
    the marker in both the page and its JS, or the search would prove nothing.
    """
    if not (dist / "index.html").is_file():
        raise RunnerError(f"production build missing: {dist}/index.html (run npm run build)")
    marked = files_containing_marker(site)
    if not any(name.endswith(".html") for name in marked) or not any(name.endswith(".js") for name in marked):
        raise RunnerError(
            f"leak marker not found in both HTML and JS of the test build {site} "
            f"(found in: {marked or 'nothing'}); the dist/ leak check would be vacuous"
        )
    leaked = [f"{name} (contains test-only marker)" for name in files_containing_marker(dist)]
    leaked += [
        str(path.relative_to(dist))
        for path in dist.rglob("*")
        if TEST_PAGE in str(path.relative_to(dist))
    ]
    if leaked:
        raise RunnerError("test-only files leaked into production dist/: " + ", ".join(leaked))
    return marked


class Marionette:
    def __init__(self, connection):
        self.connection = connection
        self.command_id = 0

    def receive(self):
        digits = b""
        while True:
            byte = self.connection.recv(1)
            if not byte:
                raise RunnerError("Firefox closed the Marionette connection")
            if byte == b":":
                break
            digits += byte
        size = int(digits)
        payload = b""
        while len(payload) < size:
            chunk = self.connection.recv(size - len(payload))
            if not chunk:
                raise RunnerError("Firefox closed the Marionette connection")
            payload += chunk
        return json.loads(payload)

    def command(self, name, args=None):
        self.command_id += 1
        message = json.dumps(
            [0, self.command_id, name, args or {}], separators=(",", ":")
        ).encode()
        packet = str(len(message)).encode() + b":" + message
        self.connection.sendall(packet)
        reply = self.receive()
        if reply[2] is not None:
            raise RunnerError(f"{name}: {reply[2]}")
        result = reply[3]
        if isinstance(result, dict) and set(result) == {"value"}:
            return result["value"]
        return result

    def close(self):
        try:
            self.connection.close()
        except OSError:
            pass


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--site",
        default=str(REPO_DIR / ".banner-test-dist"),
        help="BANNER_TEST=1 build to test (default: .banner-test-dist/)",
    )
    parser.add_argument(
        "--production-dist",
        default=str(REPO_DIR / "dist"),
        help="production build to check for leaked test files (default: dist/)",
    )
    parser.add_argument("--timeout", type=float, default=60.0, help=argparse.SUPPRESS)
    return parser.parse_args()


def firefox_candidates():
    configured = os.environ.get("FIREFOX")
    if configured:
        candidate = shutil.which(configured) or str(Path(configured).expanduser())
        if Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return [candidate]
        raise RunnerError(f"FIREFOX is not executable: {configured}")

    candidates = []
    candidate = shutil.which("firefox")
    if candidate:
        candidates.append(candidate)
    if SNAP_FIREFOX.is_file() and os.access(SNAP_FIREFOX, os.X_OK):
        candidates.append(str(SNAP_FIREFOX))
    if not candidates:
        raise RunnerError("Firefox not found; set FIREFOX to its executable path")
    return list(dict.fromkeys(candidates))


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def connect_marionette(port, process, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RunnerError(f"Firefox exited before Marionette was ready ({process.returncode})")
        try:
            connection = socket.create_connection(("127.0.0.1", port), timeout=1)
            connection.settimeout(timeout)
            return connection
        except OSError:
            time.sleep(0.1)
    raise RunnerError(f"Marionette did not start on port {port} within {timeout:g}s")


def launch_firefox(candidates, profile, port, timeout):
    errors = []
    log_path = Path(profile) / "firefox.log"
    for executable in candidates:
        process = None
        try:
            with log_path.open("w", encoding="utf-8") as log:
                process = subprocess.Popen(
                    [
                        executable,
                        "--headless",
                        "--no-remote",
                        "--marionette",
                        "--profile",
                        profile,
                    ],
                    stdout=log,
                    stderr=subprocess.STDOUT,
                )
                connection = connect_marionette(port, process, timeout)
            return executable, process, connection
        except (RunnerError, OSError, subprocess.SubprocessError) as error:
            stop_process(process)
            log_tail = ""
            try:
                log_tail = "\n".join(log_path.read_text(encoding="utf-8").splitlines()[-8:])
            except OSError:
                pass
            detail = f"{executable}: {error}"
            if log_tail:
                detail += f"\n{log_tail}"
            errors.append(detail)
    raise RunnerError("Firefox startup failed:\n" + "\n".join(errors))


def execute_script(client, script):
    return client.command(
        "WebDriver:ExecuteScript",
        {
            "script": script,
            "args": [],
            "newSandbox": False,
            "sandbox": "default",
            "line": 0,
            "filename": "boat-regression-runner.js",
        },
    )


def poll_results(client, process, timeout):
    deadline = time.monotonic() + timeout
    script = (
        'return document.querySelector("#output") '
        '? document.querySelector("#output").textContent : null;'
    )
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RunnerError(f"Firefox exited while the harness was running ({process.returncode})")
        text = execute_script(client, script)
        if text and text.strip() != "running":
            try:
                return json.loads(text)
            except json.JSONDecodeError as error:
                raise RunnerError(f"Harness returned invalid JSON: {error}") from error
        time.sleep(0.25)
    raise RunnerError(f"Regression harness timed out after {timeout:g}s")


def result_issues(results):
    issues = []
    if "harnessError" in results:
        issues.append(results["harnessError"])
        return issues
    if results.get("total") != EXPECTED_CASES:
        issues.append(f"expected {EXPECTED_CASES} navigation cases, got {results.get('total')}")
    if results.get("failures"):
        issues.append(f"{len(results['failures'])} navigation case(s) failed")
    for name, group in results.get("byGroup", {}).items():
        if group.get("failures"):
            issues.append(f"group {name} has {group['failures']} failure(s)")
    resize = results.get("resizeChecks", {})
    if not resize.get("allArrive"):
        issues.append("one or more resize-shrink cases failed")
    resize_cases = resize.get("cases", {})
    for name in ("left", "right", "top", "bottom"):
        if not resize_cases.get(name, {}).get("passed"):
            issues.append(f"resizeChecks.{name} failed or is missing")
    for section_name, names in EXPECTED_CHECKS.items():
        section = results.get(section_name, {})
        for name in names:
            if section.get(name) is not True:
                issues.append(f"{section_name}.{name} failed or is missing")
    if results.get("pointerChecks", {}).get("touchAction") != "pan-y":
        issues.append("pointerChecks.touchAction is not pan-y")
    lengths = results.get("shipChecks", {}).get("trajectoryLengths", {})
    if set(lengths) != {"motorboat", "pirate", "catamaran"} or len(set(lengths.values())) != 1:
        issues.append("ship trajectory lengths are missing or differ")
    if results.get("pageErrors"):
        issues.append(f"browser reported {len(results['pageErrors'])} page error(s)")
    return issues


def print_results(browser_version, results, issues):
    print(f"Firefox {browser_version}")
    print()
    print(f"{'Group':<12} {'Cases':>7} {'Failures':>9} {'Worst':>9}")
    for name, group in results.get("byGroup", {}).items():
        print(
            f"{name:<12} {group['count']:>7} {group['failures']:>9} "
            f"{group['worstTime']:>8.2f}s"
        )
    print(f"{'total':<12} {results.get('total', 0):>7} {len(results.get('failures', [])):>9}")

    print("\nResize shrink")
    for name, check in results.get("resizeChecks", {}).get("cases", {}).items():
        status = "PASS" if check.get("passed") else "FAIL"
        print(f"  {name:<8} {status} ({check.get('time', 0):.2f}s)")

    print("\nExtra checks")
    for section_name in ("telemetryChecks", "pointerChecks", "shipChecks", "componentChecks",
                         "navigationChecks", "navigationFallbackChecks"):
        label = section_name[:-6] if section_name.endswith("Checks") else section_name
        for name, value in results.get(section_name, {}).items():
            if isinstance(value, bool):
                print(f"  {label}.{name}: {'PASS' if value else 'FAIL'}")
            elif name == "touchAction":
                print(f"  {label}.{name}: {value}")
            elif name == "trajectoryLengths":
                lengths = ", ".join(f"{ship}={count}" for ship, count in value.items())
                print(f"  {label}.{name}: {lengths}")
            elif name == "info":
                for key, detail in value.items():
                    print(f"  {label}.info.{key}: {json.dumps(detail)}")

    page_errors = results.get("pageErrors", [])
    print(f"\nPage errors: {len(page_errors)}")
    for error in page_errors:
        print(f"  {error}")
    if issues:
        print("\nFAIL")
        for issue in issues:
            print(f"  {issue}")
    else:
        print(f"\nPASS: {results['total']}/{results['total']} navigation cases and all extra checks")


def stop_process(process):
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def run(args):
    site = Path(args.site).resolve()
    if not (site / TEST_PAGE / "index.html").is_file():
        raise RunnerError(
            f"{site} has no {TEST_PAGE}/index.html; build it with "
            "BANNER_TEST=1 astro build --outDir .banner-test-dist"
        )
    production = Path(args.production_dist).resolve()
    marked = check_production_dist(production, site)
    candidates = firefox_candidates()
    profile = tempfile.TemporaryDirectory(prefix="boat-banner-firefox-")
    server = None
    server_thread = None
    process = None
    client = None
    try:
        handler = functools.partial(SiteHandler, directory=str(site))
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        http_port = server.server_address[1]
        harness_url = f"http://127.0.0.1:{http_port}{HARNESS_PREFIX}regression.html"
        try:
            with urllib.request.urlopen(harness_url, timeout=5) as response:
                if response.status != 200:
                    raise RunnerError(f"harness returned HTTP {response.status}: {harness_url}")
        except (urllib.error.URLError, OSError) as error:
            raise RunnerError(f"harness unavailable at {harness_url}: {error}") from error

        marionette_port = free_port()
        profile_path = Path(profile.name)
        (profile_path / "user.js").write_text(
            f'user_pref("marionette.port", {marionette_port});\n'
            'user_pref("marionette.enabled", true);\n'
            'user_pref("browser.shell.checkDefaultBrowser", false);\n',
            encoding="utf-8",
        )
        firefox, process, connection = launch_firefox(
            candidates,
            profile.name,
            marionette_port,
            min(args.timeout, 20),
        )
        client = Marionette(connection)
        handshake = client.receive()
        if handshake.get("applicationType") != "gecko":
            raise RunnerError(f"unexpected Marionette handshake: {handshake}")
        session = client.command("WebDriver:NewSession", {"capabilities": {}})
        browser_version = session["capabilities"]["browserVersion"]
        client.command("WebDriver:Navigate", {"url": harness_url})
        results = poll_results(client, process, args.timeout)
        issues = result_issues(results)
        print(f"Executable: {firefox}")
        print(f"Site under test: {site}")
        print(f"Production dist checked (no test files, no leak marker): {production}")
        print(f"Leak marker present in test build: {', '.join(marked)}")
        print_results(browser_version, results, issues)
        return 1 if issues else 0
    finally:
        if client is not None:
            try:
                client.command("Marionette:Quit", {"flags": ["eForceQuit"]})
            except Exception:
                pass
            client.close()
        stop_process(process)
        if server is not None:
            server.shutdown()
            server.server_close()
        if server_thread is not None:
            server_thread.join(timeout=5)
        profile.cleanup()


def main():
    args = parse_args()
    try:
        return run(args)
    except KeyboardInterrupt:
        print("\nInterrupted", file=sys.stderr)
        return 130
    except (RunnerError, OSError, subprocess.SubprocessError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
