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
- `guide/`: User Guide screenshots (`.webp`) and short screen recordings (`.webm` with an
  `.mp4` fallback and a `-poster.webp`). Copied into `docs/assets/guide/` only, so they never
  ship on the marketing host. Recordings play muted and looped while on screen and wait for
  a click when the visitor prefers reduced motion. They were captured from a local run of
  the app with demo data (a "Northwind Marketing" workspace), signed in through the
  directory-review account.
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

## Cutover: app to app.artifactry.app, apex to the marketing site

This is a clean break: old `artifactry.app/a/…` and `/s/…` links and AI connectors set up
against `artifactry.app/api/v1/mcp` stop working once the apex moves.

1. On the `artifact-library` Pages project, add the custom domain `app.artifactry.app`
   and wait until it is Active.
2. Merge the PR. The app redeploys with `APP_ORIGIN=https://app.artifactry.app`.
3. Redeploy the preview surface, which does not auto-deploy: `npm run deploy:preview`.
   Until then, HTML previews will not frame inside the app.
4. Create and deploy `artifactry-site` and `artifactry-docs` (commands above). Attach
   `docs.artifactry.app` to `artifactry-docs`.
5. Remove `artifactry.app` (and `www.artifactry.app`, if set) from `artifact-library`, then
   attach both to `artifactry-site`.
6. In each AI app, remove the old Artifactry connector and add
   `https://app.artifactry.app/api/v1/mcp`.
7. Send one test entry through Request a Feature and check the Splitforms dashboard.

## Request a Feature form

The form posts straight to Splitforms (`https://splitforms.com/api/submit`) with the
access key in the form. After deploying, send one test entry and check it appears in the
Splitforms dashboard.
