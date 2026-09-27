/**
 * Application entry point.
 *
 * Route order matters and is deliberate:
 *   1. security headers on everything
 *   2. principal resolution once per request
 *   3. JSON API surface under /api/v1
 *   4. the external recipient surface under /s/:token
 *   5. the /a/:id canonical artifact URL
 *   6. the SPA shell for everything else
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppEnv } from './middleware'
import { securityHeaders, withPrincipal, guarded } from './middleware'
import { ok, fail, HttpError, notFound } from './lib/http'

import authRoutes from './routes/auth'
import artifactRoutes from './routes/artifacts'
import searchRoutes from './routes/search'
import shareRoutes from './routes/shares'
import taxonomyRoutes from './routes/taxonomy'
import workspaceRoutes from './routes/workspaces'
import integrationRoutes from './routes/integrations'

import { renderShell } from './renderer'
import { first } from './lib/db'
import { evaluateShareAccess, findShareByToken, shareEffectiveStatus } from './lib/sharing'
import { loadArtifact } from './lib/artifacts'
import { verifiedEmailFor } from './routes/shares'

const app = new Hono<AppEnv>()

// ---------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------

app.use('*', securityHeaders)
app.use('*', withPrincipal)

// The API is same-origin only. CORS is opened narrowly so an AI connector or
// a self-hosted client can call it, but credentials are never sent cross-origin.
app.use(
  '/api/*',
  cors({
    origin: (origin) => origin ?? '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-AI-Provider'],
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
// API surface
// ---------------------------------------------------------------

app.route('/api/v1/auth', authRoutes)
app.route('/api/v1/artifacts', artifactRoutes)
app.route('/api/v1/search', searchRoutes)
app.route('/api/v1/shares', shareRoutes)
app.route('/api/v1', taxonomyRoutes)
app.route('/api/v1', workspaceRoutes)
app.route('/api/v1', integrationRoutes)

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
     <body style="font-family:system-ui;padding:40px;max-width:430px;margin:0 auto">
     <h1 style="font-size:22px">Something went wrong</h1>
     <p style="color:#666">Please reload and try again.</p>
     <a href="/" style="color:#111">Back to library</a></body></html>`,
    500
  )
})

export default app
