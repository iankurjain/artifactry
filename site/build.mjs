#!/usr/bin/env node
/**
 * Marketing site builder.
 *
 * The site is plain static HTML so it can be served by any static host (it is
 * meant for its own Cloudflare Pages project, separate from the app). Each page
 * in pages/ is a body fragment that starts with a JSON header comment:
 *
 *   <!--{"title": "...", "description": "...", "path": "/features", "nav": "features"}-->
 *
 * This script wraps every fragment in the shared layout (head, navbar, footer)
 * and writes public/<name>.html. The generated files are committed, so the
 * host needs no build step: run `node site/build.mjs` after editing a page.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** The one place the app's sign-in address lives. Signed-out visitors to the
 *  app see the email sign-in screen, which also creates new accounts. */
const APP_URL = 'https://artifactry.app/'

/** Where this marketing site will be served from (canonical + Open Graph). */
const SITE_URL = 'https://www.artifactry.app'

const MCP_URL = 'https://artifactry.app/api/v1/mcp'

const DISCLAIMER =
  'These documents are provided for informational purposes only. Artifactry / the site operator assumes no legal responsibility for the accuracy, completeness, or suitability of this content. Consult a qualified attorney for legal advice.'

// The outlined wordmark, recoloured to follow the theme: ink parts use
// currentColor and the spark uses --spark (Volt on dark, Volt Deep on light).
const LOGO = readFileSync(join(here, 'public/assets/brand/artifactry-horizontal-reversed.svg'), 'utf8')
  .replace('<svg ', '<svg class="logo-svg" role="img" aria-label="Artifactry" ')
  .replace(/ width="909" height="256"/, '')
  .replace(/<title>[^<]*<\/title>/, '')
  .replaceAll('fill="#F5F6F2"', 'fill="currentColor"')
  .replace('fill="#B8F23A"', 'class="logo-spark"')

const NAV = [
  { id: 'home', href: '/', label: 'Home' },
  { id: 'features', href: '/features', label: 'Features' },
  { id: 'resources', href: '/resources', label: 'Resources' },
  { id: 'request', href: '/request-feature', label: 'Request a Feature' }
]

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function layout(meta, body) {
  const url = SITE_URL + (meta.path === '/' ? '/' : meta.path)
  const title = meta.path === '/' ? meta.title : `${meta.title} · Artifactry`
  const navLinks = NAV.map(
    (n) =>
      `<a href="${n.href}" class="nav-link"${meta.nav === n.id ? ' aria-current="page"' : ''}>${n.label}</a>`
  ).join('')

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
<meta property="og:image" content="${SITE_URL}/assets/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(meta.description)}">
<meta name="twitter:image" content="${SITE_URL}/assets/og.png">
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
    <a href="/" class="brand" aria-label="Artifactry home">${LOGO}</a>
    <nav class="nav-links" id="nav-links" aria-label="Main">${navLinks}</nav>
    <div class="nav-actions">
      <span class="beta-pill" title="Artifactry is free while in beta">Free beta</span>
      <button class="icon-btn theme-toggle" type="button" aria-label="Switch to light mode" data-theme-toggle>
        <svg class="i-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/></svg>
        <svg class="i-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></svg>
      </button>
      <a class="btn btn-primary btn-sm nav-cta" href="${APP_URL}" data-app-link>Log in / Sign up</a>
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
      <a href="/" class="brand" aria-label="Artifactry home">${LOGO}</a>
      <p>One governed library for everything you and your AI tools create.</p>
      <p class="muted small">Free during beta.</p>
    </div>
    <nav class="footer-col" aria-label="Product">
      <h2>Product</h2>
      <a href="/features">Features</a>
      <a href="/resources#guide">User Guide</a>
      <a href="/resources#mcp">MCP Integration</a>
      <a href="/request-feature">Request a Feature</a>
      <a href="${APP_URL}" data-app-link>Log in / Sign up</a>
    </nav>
    <nav class="footer-col" aria-label="Legal">
      <h2>Legal</h2>
      <a href="/terms">Terms of Use</a>
      <a href="/privacy">Privacy Policy</a>
      <a href="/cookies">Cookie Policy</a>
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

const pagesDir = join(here, 'pages')
const outDir = join(here, 'public')
const built = []

for (const file of readdirSync(pagesDir).filter((f) => f.endsWith('.html')).sort()) {
  const raw = readFileSync(join(pagesDir, file), 'utf8')
  const match = raw.match(/^<!--(\{[\s\S]*?\})-->\n?/)
  if (!match) throw new Error(`${file}: missing JSON header comment`)
  const meta = JSON.parse(match[1])
  const body = raw
    .slice(match[0].length)
    .replaceAll('{{APP_URL}}', APP_URL)
    .replaceAll('{{MCP_URL}}', MCP_URL)
    .replaceAll('{{DISCLAIMER}}', DISCLAIMER)
  writeFileSync(join(outDir, file), layout(meta, body))
  built.push(meta)
}

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${built
  .filter((m) => !m.noindex)
  .map((m) => `  <url><loc>${SITE_URL}${m.path}</loc></url>`)
  .join('\n')}
</urlset>
`
writeFileSync(join(outDir, 'sitemap.xml'), sitemap)
writeFileSync(join(outDir, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`)

console.log(`Built ${built.length} pages into ${outDir}`)
