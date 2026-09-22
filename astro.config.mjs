// @ts-check
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import { parseWorkDate } from './src/lib/work-date.mjs';

// Test-only page for tests/banner/ (see tests/banner/README.md). It is injected
// only when BANNER_TEST=1, so production builds (`npm run build`, CI) never
// contain it.
/** @type {import('astro').AstroIntegration} */
const bannerTestPage = {
  name: 'banner-test-page',
  hooks: {
    'astro:config:setup': ({ injectRoute }) => {
      injectRoute({
        pattern: '/__banner-test',
        entrypoint: './tests/banner/BannerTestPage.astro',
      });
    },
  },
};

// YAML rolls impossible unquoted dates over before the schema sees them
// (`date: 2023-02-29` arrives as 1 March), so check each work's raw `date:` text
// against the schema's rule (see src/content.config.ts). Runs at the start of
// every `astro build` / `astro dev`; in dev, restart after editing a date.
/** @type {import('astro').AstroIntegration} */
const worksDateCheck = {
  name: 'works-date-check',
  hooks: {
    'astro:config:setup': ({ config }) => {
      const dir = new URL('src/content/works/', config.root);
      for (const file of readdirSync(dir).filter((name) => name.endsWith('.md'))) {
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(new URL(file, dir), 'utf8'))?.[1] ?? '';
        const raw = /^date:[ \t]*(.*)$/m.exec(frontmatter)?.[1];
        if (raw === undefined) continue; // a missing date is the schema's error to report
        const text = raw.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
        if (!parseWorkDate(text)) {
          throw new Error(`Invalid date in ${fileURLToPath(new URL(file, dir))}: "date: ${raw.trim()}". `
            + 'Use YYYY, YYYY-MM or YYYY-MM-DD with a real month and day, and no time.');
        }
      }
    },
  },
};

// https://astro.build/config
export default defineConfig({
  site: 'https://wensenliu.com',
  integrations: [worksDateCheck, ...(process.env.BANNER_TEST === '1' ? [bannerTestPage] : [])],
});
