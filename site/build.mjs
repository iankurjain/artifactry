#!/usr/bin/env node
/**
 * Marketing + docs site builder.
 *
 * Two static sites come out of one source, each for its own Cloudflare Pages
 * project (both separate from the app):
 *
 *   public/  → artifactry.app        Home, Features, Request a Feature, legal pages
 *   docs/    → docs.artifactry.app   User Guide + MCP Integration (pages/resources.html)
 *
 * Each page in pages/ is a body fragment that starts with a JSON header comment:
 *
 *   <!--{"title": "...", "description": "...", "path": "/features", "nav": "features"}-->
 *
 * Bodies use placeholders so the same fragment works on either host:
 *   {{SITE}}        marketing origin ('' on the marketing site, absolute on docs)
 *   {{DOCS}}        docs origin
 *   {{LOGIN_URL}}   {{SIGNUP_URL}}   {{APP_ORIGIN}}   {{APP_HOST}}
 *   {{MCP_URL}}     {{CONTACT}}      {{DISCLAIMER}}
 *
 * The generated folders are committed, so the hosts need no build step: run
 * `node site/build.mjs` after editing a page, an asset or this file.
 */

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const SITE_URL = 'https://artifactry.app'
const DOCS_URL = 'https://docs.artifactry.app'
const APP_HOST = 'app.artifactry.app'
const APP_ORIGIN = `https://${APP_HOST}`
const LOGIN_URL = `${APP_ORIGIN}/login`
const SIGNUP_URL = `${APP_ORIGIN}/signup`
const MCP_URL = `${APP_ORIGIN}/api/v1/mcp`
const CONTACT = 'admin@artifactry.app'

const DISCLAIMER =
  'These documents are provided for informational purposes only. Artifactry / the site operator assumes no legal responsibility for the accuracy, completeness, or suitability of this content. Consult a qualified attorney for legal advice.'

// The outlined wordmark, recoloured to follow the theme: ink parts use
// currentColor and the spark uses --spark (Volt on dark, Volt Deep on light).
const LOGO = readFileSync(join(here, 'assets/brand/artifactry-horizontal-reversed.svg'), 'utf8')
  .replace('<svg ', '<svg class="logo-svg" role="img" aria-label="Artifactry" ')
  .replace(/ width="909" height="256"/, '')
  .replace(/<title>[^<]*<\/title>/, '')
  .replaceAll('fill="#F5F6F2"', 'fill="currentColor"')
  .replace('fill="#B8F23A"', 'class="logo-spark"')

const TARGETS = {
  site: { origin: SITE_URL, dir: 'public', site: '', docs: DOCS_URL },
  docs: { origin: DOCS_URL, dir: 'docs', site: SITE_URL, docs: '' }
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const fill = (html, t) =>
  html
    .replaceAll('{{SITE}}', t.site)
    .replaceAll('{{DOCS}}', t.docs)
    .replaceAll('{{LOGIN_URL}}', LOGIN_URL)
    .replaceAll('{{SIGNUP_URL}}', SIGNUP_URL)
    .replaceAll('{{APP_ORIGIN}}', APP_ORIGIN)
    .replaceAll('{{APP_HOST}}', APP_HOST)
    .replaceAll('{{MCP_URL}}', MCP_URL)
    .replaceAll('{{CONTACT}}', CONTACT)
    .replaceAll('{{DISCLAIMER}}', DISCLAIMER)

function layout(meta, body, t) {
  const url = t.origin + (meta.path === '/' ? '/' : meta.path)
  const title = meta.home ? meta.title : `${meta.title} · Artifactry`
  const nav = [
    { id: 'home', href: `${t.site}/`, label: 'Home' },
    { id: 'use-cases', href: `${t.site}/use-cases`, label: 'Use cases' },
    { id: 'features', href: `${t.site}/features`, label: 'Features' },
    { id: 'resources', href: `${t.docs}/`, label: 'Docs' },
    { id: 'request', href: `${t.site}/request-feature`, label: 'Request a Feature' }
  ]
  const navLinks = nav
    .map(
      (n) =>
        `<a href="${n.href}" class="nav-link"${meta.nav === n.id ? ' aria-current="page"' : ''}>${n.label}</a>`
    )
    .join('')

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(meta.description)}">
<link rel="canonical" href="${url}">
<meta name="theme-color" content="#12151c">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Artifactry">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(meta.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${t.origin}/assets/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(meta.description)}">
<meta name="twitter:image" content="${t.origin}/assets/og.png">
${meta.noindex ? '<meta name="robots" content="noindex">\n' : ''}<link rel="icon" href="/assets/brand/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/assets/brand/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/assets/brand/apple-touch-icon.png">
<script>document.documentElement.classList.add('js');try{var t=localStorage.getItem('artifactry-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/assets/site.css">
${meta.splitforms ? '<script src="https://splitforms.com/embed.js" async></script>\n' : ''}<script src="/assets/site.js" defer></script>
</head>
<body class="page-${meta.nav || 'other'}">
<a class="skip-link" href="#main">Skip to content</a>
<header class="nav" id="top">
  <div class="nav-inner">
    <a href="${t.site}/" class="brand" aria-label="Artifactry home">${LOGO}</a>
    <nav class="nav-links" id="nav-links" aria-label="Main">${navLinks}</nav>
    <div class="nav-actions">
      <span class="beta-pill" title="Artifactry is free while in beta">Free beta</span>
      <button class="icon-btn theme-toggle" type="button" aria-label="Switch to light mode" data-theme-toggle>
        <svg class="i-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/></svg>
        <svg class="i-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></svg>
      </button>
      <a class="btn btn-primary btn-sm nav-cta" href="${LOGIN_URL}" data-app-link>Log in / Sign up</a>
      <button class="icon-btn menu-toggle" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="nav-links" data-menu-toggle>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
      </button>
    </div>
  </div>
</header>
<main id="main" tabindex="-1">
${body}
</main>
<footer class="footer">
  <div class="container footer-grid">
    <div class="footer-brand">
      <a href="${t.site}/" class="brand" aria-label="Artifactry home">${LOGO}</a>
      <p>The second brain for multi-AI work. Save, hand off and reuse everything your team's AI tools create.</p>
      <p class="muted small">Free during beta · <a href="mailto:${CONTACT}">${CONTACT}</a></p>
    </div>
    <nav class="footer-col" aria-label="Product">
      <h2>Product</h2>
      <a href="${t.site}/use-cases">Use cases</a>
      <a href="${t.site}/features">Features</a>
      <a href="${t.docs}/#guide">User Guide</a>
      <a href="${t.docs}/#mcp">MCP Integration</a>
      <a href="${t.site}/request-feature">Request a Feature</a>
      <a href="${LOGIN_URL}" data-app-link>Log in / Sign up</a>
    </nav>
    <nav class="footer-col" aria-label="Legal">
      <h2>Legal</h2>
      <a href="${t.site}/terms">Terms of Use</a>
      <a href="${t.site}/privacy">Privacy Policy</a>
      <a href="${t.site}/cookies">Cookie Policy</a>
    </nav>
  </div>
  <div class="container footer-bottom">
    <p class="disclaimer">${DISCLAIMER}</p>
    <p class="muted small">© <span data-year>2026</span> Artifactry. Artifactry is in beta and provided as is.</p>
  </div>
</footer>
</body>
</html>
`
}

function readPage(file) {
  const raw = readFileSync(join(here, 'pages', file), 'utf8')
  const match = raw.match(/^<!--(\{[\s\S]*?\})-->\n?/)
  if (!match) throw new Error(`${file}: missing JSON header comment`)
  return { meta: JSON.parse(match[1]), body: raw.slice(match[0].length) }
}

function prepare(t) {
  const out = join(here, t.dir)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  cpSync(join(here, 'assets'), join(out, 'assets'), { recursive: true })
  cpSync(join(here, '_headers'), join(out, '_headers'))
  return out
}

function writeSeo(out, origin, paths) {
  writeFileSync(
    join(out, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `  <url><loc>${origin}${p}</loc></url>`).join('\n')}
</urlset>
`
  )
  writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`)
}

// ---- artifactry.app ----
const site = TARGETS.site
const siteOut = prepare(site)
const sitePaths = []
for (const file of readdirSync(join(here, 'pages')).filter((f) => f.endsWith('.html')).sort()) {
  if (file === 'resources.html') continue
  const { meta, body } = readPage(file)
  writeFileSync(join(siteOut, file), layout(meta, fill(body, site), site))
  if (!meta.noindex) sitePaths.push(meta.path)
}
// Old and guessable paths on the apex go to the docs host.
writeFileSync(
  join(siteOut, '_redirects'),
  `/resources ${DOCS_URL}/ 301\n/docs ${DOCS_URL}/ 301\n/guide ${DOCS_URL}/#guide 301\n/login ${LOGIN_URL} 302\n/signup ${SIGNUP_URL} 302\n`
)
writeSeo(siteOut, site.origin, sitePaths)

// ---- docs.artifactry.app ----
const docs = TARGETS.docs
const docsOut = prepare(docs)
// Guide screenshots and animations are docs-only, so they stay off the marketing host.
cpSync(join(here, 'guide'), join(docsOut, 'assets/guide'), { recursive: true })
const guide = readPage('resources.html')
writeFileSync(join(docsOut, 'index.html'), layout({ ...guide.meta, path: '/' }, fill(guide.body, docs), docs))
const notFound = readPage('404.html')
writeFileSync(join(docsOut, '404.html'), layout(notFound.meta, fill(notFound.body, docs), docs))
writeSeo(docsOut, docs.origin, ['/'])

console.log(`Built ${sitePaths.length + 1} pages into ${siteOut} and the docs into ${docsOut}`)
