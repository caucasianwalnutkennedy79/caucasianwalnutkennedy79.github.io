// Heading-outline check over the built site (run `npm run build` first).
//
// For every dist/**/*.html page: prints the h1–h6 outline and fails if the page
// does not have exactly one h1 or if a heading level is skipped (e.g. h2 → h4).
// Regex parsing is adequate here because the input is our own build output.
//
// Usage: npm run test:headings [-- path/to/dist]
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = process.argv[2] ?? fileURLToPath(new URL('../../dist', import.meta.url));

function* htmlFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(path);
    else if (entry.name.endsWith('.html')) yield path;
  }
}

const decode = (text) =>
  text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');

let problems = 0;
for (const file of [...htmlFiles(dist)].sort()) {
  const html = readFileSync(file, 'utf8');
  const headings = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map(([, level, inner]) => ({
    level: Number(level),
    text: decode(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(),
  }));
  const issues = [];
  const h1Count = headings.filter((h) => h.level === 1).length;
  if (h1Count !== 1) issues.push(`expected exactly one h1, found ${h1Count}`);
  if (headings[0] && headings[0].level !== 1) issues.push(`first heading is h${headings[0].level}, not h1`);
  headings.forEach((h, i) => {
    if (i > 0 && h.level > headings[i - 1].level + 1) {
      issues.push(`skipped level: h${headings[i - 1].level} → h${h.level} ("${h.text}")`);
    }
  });

  console.log(`${relative(dist, file)}${issues.length ? '  ✗' : ''}`);
  for (const h of headings) console.log(`  ${'  '.repeat(h.level - 1)}h${h.level} ${h.text}`);
  for (const issue of issues) console.log(`  ✗ ${issue}`);
  problems += issues.length;
}

if (problems) {
  console.error(`\nFAIL: ${problems} heading problem(s)`);
  process.exit(1);
}
console.log('\nPASS: every page has one h1 and no skipped heading levels');
