// Schema tests for the `works` collection (src/content.config.ts).
//
// Runs `astro build` on a throwaway copy of the project (in the OS temp dir,
// with node_modules symlinked), so src/ is never touched even if this script
// is interrupted:
//
// 1. Control + positive cases: the copy plus fixtures with `date: 2024` (a YAML
//    number), `date: 2024-05` and the unquoted leap day `date: 2024-02-29` must
//    build, and their pages must show "2024", "May 2024" and "29 Feb 2024" (not
//    1970, not a made-up month or day).
// 2. Negative cases: fixtures with `kind: worksop`, `date: May-ish`, the
//    unquoted impossible dates `2023-02-29` and `2024-13-01`, and the
//    time-bearing `2025-05-01T20:00:00-05:00` must each fail the build with an
//    error naming the field and the fixture file.
//
// Child builds get a scrubbed environment (no BANNER_TEST, NODE_ENV, ASTRO_*
// or PUBLIC_* from the caller), so e.g. running this under `BANNER_TEST=1`
// cannot change what is built.
//
// Usage: npm run test:schema   (exit 0 = every case behaved as expected)
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'works-schema-'));
const worksDir = join(work, 'src/content/works');

const fixture = (name, fields) => [name, `---
title: "Schema fixture ${name}"
summary: "Schema test fixture."
${fields}
---
`];

const POSITIVE_CASES = [
  // YAML parses `2024` as a number and `2024-05` as a string.
  { date: '2024', expected: '<time datetime="2024">2024</time>', entry: fixture('schema-year-fixture', 'kind: paper\ndate: 2024') },
  { date: '2024-05', expected: '<time datetime="2024-05">May 2024</time>', entry: fixture('schema-month-fixture', 'kind: paper\ndate: 2024-05') },
  // An unquoted leap day is a real date and must survive the raw-text check.
  { date: '2024-02-29', expected: '<time datetime="2024-02-29">29 Feb 2024</time>', entry: fixture('schema-leap-day-fixture', 'kind: paper\ndate: 2024-02-29') },
];
const NEGATIVE_CASES = [
  { field: 'kind', entry: fixture('schema-bad-kind-fixture', 'kind: worksop\ndate: 2026-01-01') },
  { field: 'date', entry: fixture('schema-bad-date-fixture', 'kind: paper\ndate: May-ish') },
  // Unquoted impossible dates: YAML would roll these over to 1 Mar 2023 / 1 Jan 2025.
  { field: 'date', entry: fixture('schema-feb-29-2023-fixture', 'kind: paper\ndate: 2023-02-29') },
  { field: 'date', entry: fixture('schema-month-13-fixture', 'kind: paper\ndate: 2024-13-01') },
  // A time part can shift the rendered day (this one is 2 May in UTC).
  { field: 'date', entry: fixture('schema-date-time-fixture', 'kind: paper\ndate: 2025-05-01T20:00:00-05:00') },
];

// Environment for child builds: drop anything that could change the build.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    !['BANNER_TEST', 'NODE_ENV'].includes(key) && !/^(ASTRO_|PUBLIC_)/.test(key)),
);
childEnv.ASTRO_TELEMETRY_DISABLED = '1';

const astroBuild = () => spawnSync(
  process.execPath,
  [join(repo, 'node_modules/astro/bin/astro.mjs'), 'build'],
  { cwd: work, encoding: 'utf8', env: childEnv },
);

let failures = 0;
const fail = (message) => { failures++; console.error(`FAIL: ${message}`); };

try {
  for (const entry of ['src', 'public', 'astro.config.mjs', 'package.json', 'tsconfig.json']) {
    cpSync(join(repo, entry), join(work, entry), { recursive: true });
  }
  symlinkSync(join(repo, 'node_modules'), join(work, 'node_modules'), 'dir');

  // 1. Control + partial dates: must build, and render at the given precision.
  for (const { entry: [name, body] } of POSITIVE_CASES) writeFileSync(join(worksDir, `${name}.md`), body);
  const control = astroBuild();
  if (control.status !== 0) {
    throw new Error(`control build (copy + date fixtures) failed (exit ${control.status}):\n${control.stdout}\n${control.stderr}`);
  }
  for (const { entry: [name], date, expected } of POSITIVE_CASES) {
    const page = readFileSync(join(work, 'dist/research', name, 'index.html'), 'utf8');
    const time = page.match(/<time\b[^>]*>[^<]*<\/time>/)?.[0] ?? '(no <time> element)';
    if (time === expected && !page.includes('1970')) {
      console.log(`PASS: control build (exit 0): "date: ${date}" renders ${time}`);
    } else {
      fail(`"date: ${date}" should render ${expected}, got ${time}`);
    }
    unlinkSync(join(worksDir, `${name}.md`));
  }

  // 2. Each invalid fixture on its own must fail the build, naming the field and file.
  for (const { field, entry: [name, body] } of NEGATIVE_CASES) {
    const path = join(worksDir, `${name}.md`);
    writeFileSync(path, body);
    const build = astroBuild();
    unlinkSync(path);
    const output = `${build.stdout}\n${build.stderr}`;
    if (build.status !== 0 && new RegExp(`\\b${field}\\b`).test(output) && output.includes(name)) {
      console.log(`PASS: build rejected invalid \`${field}\` (astro build exit code ${build.status}).`);
      const detail = output.split('\n').filter((line) => new RegExp(`${field}|${name}|InvalidContentEntry`, 'i').test(line));
      for (const line of detail.slice(0, 6)) console.log(`  | ${line.trim()}`);
    } else {
      fail(`expected a schema error about "${field}" in ${name}; astro build exit code ${build.status}.\n${output}`);
    }
  }
} catch (error) {
  fail(error.message);
} finally {
  // Remove the node_modules symlink itself first so cleanup can never follow it.
  const link = join(work, 'node_modules');
  if (existsSync(link) && lstatSync(link).isSymbolicLink()) unlinkSync(link);
  rmSync(work, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
