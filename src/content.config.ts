import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { parseWorkDate } from './lib/work-date.mjs';

/**
 * `works`: every paper, workshop paper, thesis, project and talk.
 *
 * Field names deliberately track CSL-JSON / BibTeX (title, author(s), date ≈
 * issued, venue ≈ container-title/booktitle/journal) so the collection can
 * later be generated from a .bib file; see README.md.
 *
 * Objects are strict: an unknown or misspelt field fails the build instead of
 * being silently ignored.
 */

/** Absolute http(s) URL, or a site-relative path such as `/papers/x.pdf`. */
const href = z.union([
  z.url({ protocol: /^https?$/ }),
  z.string().regex(/^\/(?!\/)/, 'must be an http(s) URL or a site-relative path starting with "/"'),
]);

/**
 * Publication date with its precision. Accepts a YAML date (`2024-05-01`), or a
 * year `2024`, year-month `2024-05` or full date `"2024-05-01"` as a string or
 * number. Anything else fails the build: `z.coerce.date()` would silently turn
 * the YAML number `2024` into 1970. Values are UTC midnight on the first
 * day/month the precision leaves unspecified.
 *
 * A YAML date reaches zod already parsed, so an impossible unquoted date such as
 * `2023-02-29` has been rolled over (to 1 March) before this runs; the
 * `works-date-check` integration in astro.config.mjs rejects those from the raw
 * frontmatter text. Here, a YAML date with a time part is rejected, since it can
 * shift the day.
 */
const workDate = z.union([z.date(), z.string(), z.number()]).transform((input, ctx) => {
  if (input instanceof Date) {
    if (input.getTime() % 86_400_000 === 0) return { value: input, precision: 'day' as const };
  } else {
    const parsed = parseWorkDate(String(input));
    if (parsed) return parsed;
  }
  ctx.addIssue({
    code: 'custom',
    message: `date must be a YAML date or "YYYY", "YYYY-MM" or "YYYY-MM-DD" (got ${JSON.stringify(input)})`,
  });
  return z.NEVER;
});

const works = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/works' }),
  schema: z.strictObject({
    title: z.string().min(1),
    kind: z.enum(['paper', 'workshop', 'thesis', 'project', 'talk']),
    status: z.enum(['under-review', 'accepted', 'published']).default('published'),
    date: workDate,
    venue: z.string().optional(),
    authors: z.array(z.string().min(1)).optional(),
    /** One-liner shown in lists and cards. */
    summary: z.string().min(1),
    /** Longer abstract for the detail page; falls back to `summary`. */
    abstract: z.string().optional(),
    links: z
      .strictObject({
        pdf: href.optional(),
        code: href.optional(),
        video: href.optional(),
        slides: href.optional(),
        site: href.optional(),
      })
      .optional(),
    featured: z.boolean().default(false),
    /** Drafts are listed in `astro dev` but excluded from production builds. */
    draft: z.boolean().default(false),
    /** Card/detail image: a site-relative path (under public/) or URL, plus alt text. */
    image: z.strictObject({ src: href, alt: z.string() }).optional(),
    bibtex: z.string().optional(),
  }),
});

export const collections = { works };
