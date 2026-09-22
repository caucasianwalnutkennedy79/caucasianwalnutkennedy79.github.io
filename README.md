# wensenliu.github.io

Source for <https://wensenliu.com> — Wensen Liu's research portfolio. Built with
[Astro](https://astro.build) (static output, no UI framework) and deployed to
GitHub Pages by `.github/workflows/deploy.yml` on every push to `main`.

## Toolchain

Node 24 (CI uses the same major via `withastro/action`'s `node-version`).
Locally everything runs in the conda env `website`:

```sh
conda run -n website npm ci
conda run -n website npm run dev          # http://localhost:4321 (drafts visible)
conda run -n website npm run build        # production build -> dist/
conda run -n website npm run check        # astro check (TypeScript, strict)
conda run -n website npm run test:banner  # banner regression suite on the built site
conda run -n website npm run test:schema  # year-only dates render as the year; bad `kind`/`date` fail the build
conda run -n website npm run test:headings  # one h1 per page, no skipped levels (after build)
```

`test:banner` needs Python 3 and Firefox; see `tests/banner/README.md`.

## Layout

```text
src/
  content.config.ts        `works` collection schema (zod)
  content/works/*.md       one file per paper / workshop / thesis / project / talk
  components/BoatBanner.astro   banner markup + init
  scripts/boat-banner.js   banner behaviour (single source of truth, exports initBoatBanner)
  styles/global.css        colour tokens (from the prototype) + all site CSS
  layouts/BaseLayout.astro header/nav, banner, main, footer on every page
  pages/                   /, /research/, /research/<slug>/, /projects/, /projects/<slug>/, /cv/, /about/
prototypes/                frozen reference prototype and its own test suite (not used by the site)
tests/                     banner, schema and heading checks (never shipped in dist/)
```

## Adding work

Create `src/content/works/<slug>.md`; the file name becomes the URL slug.
`kind: project` pages live under `/projects/<slug>/`, everything else under
`/research/<slug>/`. Frontmatter fields (see `src/content.config.ts`):

| field | notes |
| --- | --- |
| `title` | required |
| `kind` | `paper` \| `workshop` \| `thesis` \| `project` \| `talk` |
| `status` | `under-review` \| `accepted` \| `published` (default); badge shown for `paper`/`workshop` only |
| `date` | `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, shown at that precision; lists sort newest first |
| `venue`, `authors` | optional; the owner's name is highlighted in author lists |
| `summary` | one-liner for lists and cards |
| `abstract` | optional; detail page "Abstract"/"Overview" (falls back to `summary`) |
| `links` | optional `pdf`, `code`, `video`, `slides`, `site`: http(s) URLs or `/site-relative` paths |
| `featured` | show on the home page |
| `draft` | shown by `npm run dev`, excluded from production builds |
| `image` | optional `{ src, alt }` (a `/path` under `public/` or a URL) |
| `bibtex` | optional; enables the "Cite" control |

Unknown fields, unknown `kind`/`status` values and malformed dates fail the build. Markdown body
headings start at `##` — the title is the page's only `h1`.

A CV PDF is linked from `/cv/` automatically if `public/cv.pdf` exists at build time.

### Moving to BibTeX later

The data model deliberately stays close to BibTeX / CSL-JSON: `title`,
`authors` (BibTeX `author`, CSL `author`), `date` (`year`/`month`, CSL
`issued`), `venue` (`booktitle`/`journal`, CSL `container-title`), and `kind`
maps onto entry types (`paper` → `@article`, `workshop` → `@inproceedings`,
`thesis` → `@phdthesis`/`@mastersthesis`, `talk` → `@misc`). A later step
could replace the glob loader for publications with a loader that parses a
`.bib` file into the same schema; site-only fields (`summary`, `featured`,
`draft`, `links`, `image`) would then live in a small side file keyed by
citation key. Not implemented yet.

## Deployment

The custom domain is set in the repository's Pages settings (Settings → Pages →
Custom domain, with Pages source = "GitHub Actions"). There is intentionally no
`CNAME` file: Actions-based deployments ignore it.
