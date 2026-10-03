# Artifactry marketing site

Static, dependency-free sites built from one source:

| Output | Host | Pages |
|---|---|---|
| `public/` | `artifactry.app` | Home, Features, Request a Feature, Terms, Privacy, Cookie Policy, 404 |
| `docs/` | `docs.artifactry.app` | User Guide + MCP Integration (from `pages/resources.html`) |

Login / Sign up links go to `app.artifactry.app/login` and `/signup`. Neither site is part
of the app's build, so merging does not change the app.

## Layout

- `pages/*.html`: page bodies. Each starts with a JSON header comment (title, description,
  path, nav). Bodies use placeholders (`{{SITE}}`, `{{DOCS}}`, `{{LOGIN_URL}}`,
  `{{MCP_URL}}`, `{{CONTACT}}`, …) so a page works on either host.
- `assets/`, `_headers`: shared CSS, JS, brand files and `og.png`, copied into both outputs.
- `build.mjs`: hosts, URLs and the contact email live at the top. It writes `public/` and
  `docs/` (both committed, so the hosts need no build step), plus sitemaps, robots.txt and
  apex redirects (`/resources`, `/docs`, `/guide` → docs; `/login`, `/signup` → app).

After editing anything:

```bash
node site/build.mjs
```

## Preview locally

```bash
(cd site/public && python3 -m http.server 8787) &   # http://localhost:8787/index.html
(cd site/docs && python3 -m http.server 8788) &     # http://localhost:8788/
```

## Deploy (Cloudflare Pages)

Two new Pages projects, neither of them `artifact-library` (the app):

```bash
npx wrangler pages project create artifactry-site --production-branch main
npx wrangler pages deploy site/public --project-name artifactry-site --branch main

npx wrangler pages project create artifactry-docs --production-branch main
npx wrangler pages deploy site/docs --project-name artifactry-docs --branch main
```

Then attach `docs.artifactry.app` to `artifactry-docs`. `artifactry.app` is currently the
app's custom domain, so it can move to `artifactry-site` only after the app is serving on
`app.artifactry.app`.

## Request a Feature form

The form posts straight to Splitforms (`https://splitforms.com/api/submit`) with the
access key in the form. After deploying, send one test entry and check it appears in the
Splitforms dashboard.
