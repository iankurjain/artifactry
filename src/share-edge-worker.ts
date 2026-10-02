/**
 * Share-edge Worker: carries customer share-domain traffic to the app.
 *
 * Customers point a CNAME (share.acme.com) at SHARE_DOMAIN_CNAME_TARGET on the
 * app's Cloudflare zone, which runs Cloudflare for SaaS. Pages cannot be the
 * origin of a custom hostname, so this Worker, on a `*\/*` route of that zone,
 * receives the request and forwards it to APP_ORIGIN with:
 *
 *   X-Artifactry-Share-Host  the hostname the visitor used
 *   X-Artifactry-Client-IP   the visitor's address (rate limits, analytics)
 *   X-Artifactry-Edge-Auth   SHARE_EDGE_SECRET, so the app can trust the two above
 *
 * The app decides whether that hostname is an ACTIVE share domain and which
 * paths exist there (middleware.ts `shareDomainGate`). This Worker only drops
 * paths that can never be valid, so the app is not asked about them.
 *
 * Requests for the app's own hostnames are passed straight through, so a
 * catch-all route can never put this Worker in front of artifactry.app or the
 * preview origin. Certificate validation paths are passed through untouched,
 * as Cloudflare for SaaS requires.
 *
 * Deploy: npm run deploy:share-edge (wrangler.share-edge.jsonc).
 */

interface EdgeEnv {
  APP_ORIGIN: string
  /** Comma-separated hostnames this Worker must never handle. */
  PASSTHROUGH_HOSTS?: string
  SHARE_EDGE_SECRET: string
}

const FORWARDED = ['/s/', '/api/v1/shares/', '/api/health', '/guide', '/static/']
const STRIP = ['x-artifactry-share-host', 'x-artifactry-client-ip', 'x-artifactry-edge-auth']

function notFound(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff'
    }
  })
}

export default {
  async fetch(request: Request, env: EdgeEnv): Promise<Response> {
    const url = new URL(request.url)
    const host = url.hostname.toLowerCase()
    const appUrl = new URL(env.APP_ORIGIN)

    const passthrough = new Set(
      [appUrl.hostname, ...(env.PASSTHROUGH_HOSTS ?? '').split(',')]
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean)
    )
    if (passthrough.has(host)) return fetch(request)
    if (url.pathname.startsWith('/.well-known/pki-validation/') || url.pathname.startsWith('/.well-known/acme-challenge/')) {
      return fetch(request)
    }

    // Plain HTTP on a customer hostname goes to HTTPS before anything else.
    if (url.protocol === 'http:') {
      url.protocol = 'https:'
      return Response.redirect(url.toString(), 301)
    }

    const path = url.pathname
    const forwardable = FORWARDED.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p))
    if (!forwardable) return notFound()

    const upstream = new URL(path + url.search, appUrl)
    const headers = new Headers(request.headers)
    for (const name of STRIP) headers.delete(name)
    headers.set('X-Artifactry-Share-Host', host)
    headers.set('X-Artifactry-Client-IP', request.headers.get('CF-Connecting-IP') ?? '')
    headers.set('X-Artifactry-Edge-Auth', env.SHARE_EDGE_SECRET)
    headers.delete('Host')

    return fetch(upstream.toString(), {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual'
    })
  }
}
