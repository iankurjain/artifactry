/**
 * Application entry point.
 *
 * Route order matters and is deliberate:
 *   1. security headers on everything
 *   2. surface gate: keep the app origin and the isolated preview origin disjoint
 *   3. principal resolution once per request
 *   4. the isolated preview document surface (/p/:token)
 *   5. JSON API surface under /api/v1
 *   6. the external recipient surface under /s/:token
 *   7. the /a/:id canonical artifact URL
 *   8. the SPA shell for everything else
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppEnv } from './middleware'
import { securityHeaders, withPrincipal, previewSurfaceGate, guarded } from './middleware'
import { ok, fail, HttpError, notFound } from './lib/http'

import authRoutes from './routes/auth'
import artifactRoutes from './routes/artifacts'
import searchRoutes from './routes/search'
import shareRoutes from './routes/shares'
import taxonomyRoutes from './routes/taxonomy'
import teamRoutes from './routes/teams'
import workspaceRoutes from './routes/workspaces'
import integrationRoutes from './routes/integrations'
import previewRoutes from './routes/preview'
import oauthRoutes from './routes/oauth'
import { wwwAuthenticate } from './lib/oauth'

import { renderShell } from './renderer'
import { first } from './lib/db'
import {
  evaluateShareAccess,
  findShareByToken,
  shareCoversArtifact,
  shareEffectiveStatus
} from './lib/sharing'
import { loadArtifact } from './lib/artifacts'
import { buildPreviewDescriptor } from './lib/preview'
import { classifyRequest, previewOrigin, previewSandbox } from './lib/htmlpreview'
import { verifiedEmailFor, verifiedGrantFor } from './routes/shares'
import { recordEvent } from './lib/analytics'

const app = new Hono<AppEnv>()

// ---------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------

app.use('*', securityHeaders)
// After securityHeaders so a gated 404 still carries them, before withPrincipal
// so the preview origin never resolves a session.
app.use('*', previewSurfaceGate)
// Every 401 from the MCP endpoint must point at the OAuth metadata, or a
// connector has no way to start sign-in. Registered before withPrincipal
// because an invalid/expired token is rejected there, before any route runs.
app.use('/api/v1/mcp', async (c, next) => {
  await next()
  if (c.res.status === 401) {
    const origin = new URL(c.req.url).origin
    const presented = /^bearer\s+/i.test(c.req.header('Authorization') ?? '')
    c.res.headers.set('WWW-Authenticate', wwwAuthenticate(origin, presented ? 'invalid_token' : undefined))
  }
})
app.use('*', withPrincipal)

// The API is same-origin only. CORS is opened narrowly so an AI connector or
// a self-hosted client can call it, but credentials are never sent cross-origin.
app.use(
  '/api/*',
  cors({
    origin: (origin) => origin ?? '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-AI-Provider', 'MCP-Protocol-Version', 'Mcp-Session-Id'],
    exposeHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'],
    credentials: false,
    maxAge: 600
  })
)

// ---------------------------------------------------------------
// Health
// ---------------------------------------------------------------

app.get('/api/health', (c) =>
  ok(c, {
    service: 'artifact-library',
    status: 'ok',
    time: new Date().toISOString()
  })
)

// ---------------------------------------------------------------
// Isolated preview origin (§67, §68)
//
// Only reachable on the configured preview origin — previewSurfaceGate serves
// the /p/ prefix exclusively there and 404s it everywhere else.
// ---------------------------------------------------------------

app.route('/', previewRoutes)

// ---------------------------------------------------------------
// OAuth for AI connectors: /.well-known/* discovery and /oauth/*
// ---------------------------------------------------------------

app.route('/', oauthRoutes)

// ---------------------------------------------------------------
// API surface
// ---------------------------------------------------------------

app.route('/api/v1/auth', authRoutes)
app.route('/api/v1/artifacts', artifactRoutes)
app.route('/api/v1/search', searchRoutes)
app.route('/api/v1/shares', shareRoutes)
app.route('/api/v1', taxonomyRoutes)
app.route('/api/v1', workspaceRoutes)
app.route('/api/v1', integrationRoutes)
app.route('/api/v1', teamRoutes)

// ---------------------------------------------------------------
// Canonical artifact URL (§12)
//
// Permanent identity: /a/:id survives renames, re-versioning, moves and tag
// changes. The path never discloses the storage location, and a visitor
// without access is sent to the login/sign-in surface rather than told the
// artifact exists.
// ---------------------------------------------------------------

app.get(
  '/a/:artifactId',
  guarded(async (c) => {
    const principal = c.get('principal')
    const artifactId = c.req.param('artifactId')

    const shell = await renderShell(c, {
      route: 'artifact',
      artifactId,
      initialData: null
    })

    if (!principal?.userId) return shell

    const artifact = await loadArtifact(c.env.DB, artifactId)
    if (!artifact) return shell

    return shell
  })
)

// ---------------------------------------------------------------
// External recipient surface (§42, §108)
// ---------------------------------------------------------------

app.get(
  '/s/:token',
  guarded(async (c) => {
    const token = c.req.param('token')
    const share = await findShareByToken(c.env.DB, token)

    // An unknown token gets the same shell, which then renders a neutral
    // "link not valid" state — no hint about what might have existed.
    if (!share) {
      return renderShell(c, { route: 'share', shareToken: token, initialData: null })
    }

    const verifiedEmail = await verifiedEmailFor(c, share)
    const evaluation = await evaluateShareAccess(c.env.DB, share, verifiedEmail)

    return renderShell(c, {
      route: 'share',
      shareToken: token,
      initialData: {
        accessible: evaluation.allowed,
        reason: evaluation.reason ?? null,
        accessType: share.access_type,
        effectiveStatus: shareEffectiveStatus(share)
      }
    })
  })
)

// ---------------------------------------------------------------
// Secure viewer for a shared HTML artifact (§42, §68)
//
// The raw delivery endpoint (/content) forces text/plain for HTML so an
// artifact can never execute on the application origin — correct, but it means
// a recipient who opens an HTML share sees source code. This route is the
// user-facing "open the artifact" URL instead:
//
//   * it serves our own trusted wrapper document, so the URL is a normal,
//     bookmarkable page that renders in any browser;
//   * the artifact itself is loaded into an iframe with `sandbox="allow-scripts"`
//     and NO `allow-same-origin`, giving it an opaque origin — it cannot read
//     cookies, call authenticated APIs or touch app storage;
//   * previewCsp() keeps the artifact's own document locked to
//     default-src 'none' with no connect/frame/object sources.
//
// The security model is unchanged: the artifact never executes on the
// application origin. Only the framing target differs.
// ---------------------------------------------------------------

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function viewerMessage(title: string, message: string): Response {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title></head>
<body style="font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:48px 20px;background:#f5f6f2;color:#12151c">
<div style="max-width:420px;margin:0 auto;background:#fff;border:1px solid #e2e4da;border-radius:14px;padding:22px">
<h1 style="font-size:19px;margin:0 0 8px">${escapeHtml(title)}</h1>
<p style="font-size:14px;color:#5a6066;margin:0;line-height:1.55">${escapeHtml(message)}</p>
</div></body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  )
}

app.get(
  '/s/:token/artifact/:artifactId',
  guarded(async (c) => {
    const token = c.req.param('token')
    const artifactId = c.req.param('artifactId')

    const share = await findShareByToken(c.env.DB, token)
    if (!share) return viewerMessage('Link not valid', 'This share link does not exist or has been removed.')

    const grant = await verifiedGrantFor(c, share)
    const verifiedEmail = grant?.email ?? null
    const evaluation = await evaluateShareAccess(c.env.DB, share, verifiedEmail)
    if (!evaluation.allowed) {
      return viewerMessage('This share is not available', 'It may have expired, been revoked, or not be addressed to you.')
    }
    if (!share.allow_view) {
      return viewerMessage('Viewing is not permitted', 'The sender has disabled viewing for this share.')
    }

    const covered =
      share.target_type === 'ARTIFACT'
        ? share.target_id === artifactId
        : await shareCoversArtifact(c.env.DB, share, artifactId)
    if (!covered) return viewerMessage('Item unavailable', 'That item is not part of this share.')

    const artifact = await loadArtifact(c.env.DB, artifactId)
    if (!artifact?.current_version_id) {
      return viewerMessage('Item unavailable', 'The shared item is no longer available.')
    }

    // Only HTML needs the wrapper. Everything else renders or downloads
    // correctly from the delivery endpoint, so send the visitor there.
    if (artifact.mime_type !== 'text/html') {
      return c.redirect(
        `/api/v1/shares/${encodeURIComponent(token)}/content?artifactId=${encodeURIComponent(artifactId)}`
      )
    }

    const channel =
      share.access_type === 'PUBLIC_LINK' ? 'PUBLIC_LINK' : share.access_type === 'EMAIL' ? 'EMAIL' : 'DOMAIN'

    await recordEvent(c.env.DB, {
      artifactId: artifact.id,
      workspaceId: artifact.workspace_id,
      organizationId: artifact.organization_id,
      shareId: share.id,
      eventType: 'artifact_viewed',
      actorType: 'ANONYMOUS',
      actorLabel: verifiedEmail,
      accessChannel: channel,
      sessionSeed: c.req.header('CF-Connecting-IP') ?? null
    })

    const title = artifact.title || artifact.filename || 'Shared artifact'
    const origin = new URL(c.req.url).origin

    /**
     * How this share should render, decided server-side.
     *
     * A recipient never chooses the mode: an Interactive artifact gets a
     * short-lived signed document URL on the isolated preview origin, and a Safe
     * artifact gets the same-origin Safe path. The token binds the share and the
     * recipient grant, so it expires with both.
     */
    const preview = await buildPreviewDescriptor(c.env.DB, c.env, artifact, {
      shareId: share.id,
      grantId: grant?.grantId ?? null,
      appOrigin: origin,
      shareToken: token
    })

    const frameSrc = preview.url ?? preview.fallbackUrl ?? ''
    const interactive = preview.mode === 'INTERACTIVE'

    /**
     * The wrapper must be permitted to frame the isolated origin when that is
     * where the document lives. `frame-src 'self'` alone would silently block
     * the frame and leave the recipient looking at an empty box, so the preview
     * origin is added only when the document actually resolves there.
     */
    const isolatedOrigin = previewOrigin(c.env)
    const frameSrcDirective = ["'self'", ...(interactive && isolatedOrigin ? [isolatedOrigin] : [])].join(' ')

    const modeLabel = interactive ? 'Interactive Preview' : 'Safe Preview'
    const modeDetail = interactive
      ? 'JavaScript runs in an isolated sandbox'
      : 'HTML and CSS render; JavaScript does not run'

    const downloadSrc = `/api/v1/shares/${encodeURIComponent(token)}/content?artifactId=${encodeURIComponent(artifactId)}&download=1`

    const body = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #f5f6f2;
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; }
  .wrap { display: flex; flex-direction: column; height: 100dvh; }
  .bar { display: flex; align-items: center; gap: 12px; padding: 10px 16px;
    background: #fff; border-bottom: 1px solid #e2e4da; flex: none; }
  .bar h1 { font-size: 15px; font-weight: 640; margin: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .meta { font-size: 12px; color: #5a6066; margin-top: 2px; }
  .spacer { flex: 1; min-width: 0; }
  .btn { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 16px;
    border-radius: 10px; border: 1px solid #e2e4da; background: #fff; color: #12151c;
    font-size: 13.5px; font-weight: 560; text-decoration: none; white-space: nowrap; }
  .btn-primary { background: #12151c; color: #fff; border-color: #12151c; }
  .stage { flex: 1; min-height: 0; padding: 14px; }
  iframe { width: 100%; height: 100%; border: 1px solid #e2e4da; border-radius: 12px;
    background: #fff; display: block; }
  @media (max-width: 560px) { .bar { padding: 10px 12px; } .stage { padding: 10px; } }
</style>
</head>
<body>
<div class="wrap">
  <header class="bar">
    <div class="spacer">
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">Shared with you · ${escapeHtml(modeLabel)} — ${escapeHtml(modeDetail)}</div>
    </div>
    ${
      share.allow_download
        ? `<a class="btn btn-primary" href="${downloadSrc}" download>Download</a>`
        : ''
    }
  </header>
  <div class="stage">
    <iframe
      title="${escapeHtml(title)}"
      src="${escapeHtml(frameSrc)}"
      sandbox="${escapeHtml(preview.sandbox)}"
      referrerpolicy="no-referrer"
      loading="eager"></iframe>
  </div>
</div>
</body>
</html>`

    return new Response(body, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // The wrapper itself is locked down; it only needs to frame the
        // sandboxed preview document — same-origin in Safe mode, the isolated
        // preview origin in Interactive mode.
        'Content-Security-Policy':
          `default-src 'none'; frame-src ${frameSrcDirective}; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        'Cache-Control': 'private, no-store, max-age=0',
        'Referrer-Policy': 'no-referrer'
      }
    })
  })
)

// ---------------------------------------------------------------
// SPA shell for all application routes
// ---------------------------------------------------------------

const SPA_ROUTES = [
  '/',
  '/library',
  '/search',
  '/add',
  '/profile',
  '/admin',
  '/settings',
  '/guide'
]

for (const route of SPA_ROUTES) {
  app.get(route, (c) => {
    const name = route.replace(/^\//, '') || 'home'
    // The guide is a public reference surface, reachable from the footer of
    // every screen as well as from a shared link. It reads no user data, so a
    // signed-out visitor sees the same content rather than a sign-in wall.
    if (name === 'guide') {
      return renderShell(c, { route: 'guide', initialData: { publicSurface: true } })
    }
    return renderShell(c, { route: name })
  })
}

// ---------------------------------------------------------------
// Errors
// ---------------------------------------------------------------

app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) {
    return fail(c, notFound('Endpoint not found'))
  }

  /**
   * The application shell is served ONLY on the application surface.
   *
   * This runtime is now deployed as its own Pages project bound only to
   * artifactry.app; the isolated preview origin is a different project
   * (src/preview-worker.ts). The guard remains because the failure mode if the
   * two hostnames were ever bound to the same project is severe and silent:
   * before the split, `GET <preview-origin>/p/` returned 200 and 22056 bytes of
   * shell — markup, `/static/app.js` and the boot payload — i.e. the whole
   * application served from the hostname that exists solely to be untrusted.
   *
   * So the shell is refused on the preview surface even though, correctly
   * deployed, this Worker never sees that surface at all.
   */
  if (classifyRequest(c.env, c.req.url, c.req.header('Host')) === 'PREVIEW') {
    return new Response('Not Found', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff'
      }
    })
  }

  // Client-side routes fall through to the shell so deep links work
  return renderShell(c, { route: 'home' })
})

app.onError((err, c) => {
  if (err instanceof HttpError) return fail(c, err)
  console.error('[error]', c.req.method, c.req.path, err)
  if (c.req.path.startsWith('/api/')) {
    return fail(c, new HttpError(500, 'SERVER_ERROR', 'Something went wrong'))
  }
  return c.html(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Error</title></head>
     <body style="font-family:Inter,system-ui,sans-serif;padding:40px;max-width:430px;margin:0 auto;background:#f5f6f2;color:#12151c">
     <h1 style="font-size:22px">Something went wrong</h1>
     <p style="color:#5a6066">Please reload and try again.</p>
     <a href="/" style="color:#4e7a00">Back to library</a></body></html>`,
    500
  )
})

export default app
