/**
 * Egress sink for the Interactive Preview security suite.
 *
 * A minimal HTTP server on its own hostname. The previewed artifact tries every
 * outbound vector against it (fetch, XHR, WebSocket, EventSource, sendBeacon,
 * image, injected script/stylesheet, iframe, form POST, popup). Any request that
 * actually arrives here is recorded.
 *
 * This exists because a rejected promise is NOT proof that nothing was sent:
 *
 *   - `navigator.sendBeacon()` returns `true` whenever the payload was queued,
 *     even when the CSP then blocks the request. Only the sink can tell us
 *     whether bytes left the browser.
 *   - The browser's own request log records that a request was *attempted*,
 *     which is also not the same as delivered.
 *
 * So the assertion becomes: if the sink recorded nothing, no egress happened.
 * The reverse — a request in the sink log — is a real, demonstrated leak.
 */

import http from 'node:http'

export function startSink({ port = 9999, host = '127.0.0.1' } = {}) {
  const hits = []

  const record = (req, extra = {}) => {
    hits.push({
      method: req.method,
      url: req.url,
      host: req.headers.host ?? null,
      origin: req.headers.origin ?? null,
      ...extra
    })
  }

  const server = http.createServer((req, res) => {
    // A WebSocket/EventSource handshake is an HTTP request; record the intent
    // then leave it hanging or end it.
    record(req)

    if (req.url?.startsWith('/sse')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
      res.write('data: hello\n\n')
      return res.end()
    }

    // CORS-open so the browser is not the thing refusing us. Any egress counted
    // here is therefore attributable to CSP, not to a same-origin policy.
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Content-Type': req.url?.endsWith('.css')
        ? 'text/css'
        : req.url?.endsWith('.js')
          ? 'application/javascript'
          : req.url?.endsWith('.gif')
            ? 'image/gif'
            : 'text/html',
      'Cache-Control': 'no-store'
    })
    res.end('/* sink */')
  })

  // Accept WebSocket upgrades too, so a successful ws:// handshake is recorded
  // instead of failing for lack of a listener.
  server.on('upgrade', (req, socket) => {
    record(req, { upgrade: true })
    socket.destroy()
  })

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({
        hits,
        reset: () => {
          hits.length = 0
        },
        close: () => new Promise((r) => server.close(() => r()))
      })
    })
  })
}
