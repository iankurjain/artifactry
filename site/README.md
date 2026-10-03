# Artifactry marketing site

Static, dependency-free marketing site: Home, Features, Resources (User Guide + MCP setup),
Request a Feature, Terms, Privacy and Cookie Policy. It is separate from the app and is not
part of the app's build, so merging it does not change artifactry.app.

## Layout

- `pages/*.html` — page bodies. Each starts with a JSON header comment (title, description,
  path, nav).
- `build.mjs` — wraps each page in the shared head, navbar and footer and writes
  `public/*.html`, `sitemap.xml` and `robots.txt`. `APP_URL`, `SITE_URL` and `MCP_URL` live
  at the top of this file.
- `public/` — the deployable output (committed, so the host needs no build step).
  `assets/site.css`, `assets/site.js`, brand files and `og.png` live here.

After editing a page or the layout:

```bash
node site/build.mjs
```

## Preview locally

```bash
cd site/public && python3 -m http.server 8787
# open http://localhost:8787/index.html  (clean URLs like /features work on Cloudflare Pages)
```

## Deploy (Cloudflare Pages)

Create a **new** Pages project for the site; do not deploy it to `artifact-library`,
which serves the app.

```bash
npx wrangler pages project create artifactry-site --production-branch main
npx wrangler pages deploy site/public --project-name artifactry-site --branch main
```

Then add a custom domain (for example `www.artifactry.app`) under the project's Custom
domains. If you use a different domain, change `SITE_URL` in `build.mjs` and rebuild so
canonical links, Open Graph tags and the sitemap point at it.

## Request a Feature form

The form posts straight to Splitforms (`https://splitforms.com/api/submit`) with the
access key in the form. After deploying, send one test entry and check it appears in the
Splitforms dashboard.
