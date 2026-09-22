// Pure date-text validator shared by the `works` schema (src/content.config.ts)
// and the raw-frontmatter check in astro.config.mjs. Plain .mjs so the Astro
// config can import it without a TypeScript loader.

const DATE_PATTERN = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/**
 * Parses "YYYY", "YYYY-MM" or "YYYY-MM-DD" to UTC midnight on the first
 * day/month the precision leaves unspecified. Returns null for anything else,
 * including impossible dates and values with a time part.
 * @param {string} text
 * @returns {{ value: Date, precision: 'year' | 'month' | 'day' } | null}
 */
export function parseWorkDate(text) {
  const match = DATE_PATTERN.exec(text);
  if (!match) return null;
  const [, year, month, day] = match;
  const value = new Date(Date.UTC(Number(year), Number(month ?? 1) - 1, Number(day ?? 1)));
  // Round-trip check rejects e.g. 2024-13 or 2024-02-30 (Date.UTC would roll them over).
  if (!value.toISOString().startsWith(text)) return null;
  return { value, precision: day ? 'day' : month ? 'month' : 'year' };
}
