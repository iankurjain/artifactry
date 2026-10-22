// Unit gate for private_key_jwt client assertions from CIMD clients (ChatGPT).
// Bundles src/lib/oauth.ts, fakes D1 and fetch, and signs assertions with
// fresh RS256 and ES256 keys. Run: node scripts/test-private-key-jwt.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const outfile = join(mkdtempSync(join(tmpdir(), 'pkjwt-')), 'oauth.mjs')
await build({ entryPoints: ['src/lib/oauth.ts'], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'error' })
const { authenticateClient, readMetadataDocument, authorizationServerMetadata } = await import(pathToFileURL(outfile).href)
const CID = 'https://chatgpt.com/oauth/client.json'
const EP = 'https://app.artifactry.app/oauth/token'
let pass = 0, failN = 0
const check = (n, c, d='') => { c ? pass++ : failN++; console.log((c?'ok  ':'FAIL'), n, c?'':d) }
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
async function mk(alg) {
  const kp = await crypto.subtle.generateKey(alg==='RS256'?{name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'}:{name:'ECDSA',namedCurve:'P-256'}, true, ['sign','verify'])
  const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', use: 'sig', alg }
  return { kp, jwk }
}
async function sign(kp, alg, claims, kid='k1') {
  const h = enc({ alg, kid, typ: 'JWT' }), p = enc(claims)
  const sig = await crypto.subtle.sign(alg==='RS256'?'RSASSA-PKCS1-v1_5':{name:'ECDSA',hash:'SHA-256'}, kp.privateKey, new TextEncoder().encode(`${h}.${p}`))
  return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`
}
const row = { id: CID, client_name: 'ChatGPT', redirect_uris: '["https://chatgpt.com/cb"]', secret_hash: null, token_endpoint_auth_method: 'private_key_jwt', integration_id: 'int_chatgpt', status: 'ACTIVE', created_at: 'x', metadata_fetched_at: new Date().toISOString() }
const db = { prepare: () => ({ bind() { return this }, first: async () => row, run: async () => ({}) }) }
for (const alg of ['RS256','ES256']) {
  const { kp, jwk } = await mk(alg)
  const other = await mk(alg)
  let docMode = 'uri'
  globalThis.fetch = async (u) => {
    const body = String(u) === CID
      ? { client_id: CID, client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/cb'], token_endpoint_auth_method: 'private_key_jwt', ...(docMode==='uri' ? { jwks_uri: 'https://chatgpt.com/jwks.json' } : { jwks: { keys: [jwk] } }) }
      : { keys: [jwk] }
    return new Response(JSON.stringify(body), { status: 200 })
  }
  const now = Math.floor(Date.now()/1000)
  const good = { iss: CID, sub: CID, aud: EP, exp: now + 120, jti: 'j' }
  const form = (a) => ({ grant_type: 'authorization_code', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: a })
  const tryAuth = async (f) => { try { await authenticateClient(db, f, undefined, EP); return 'ok' } catch (e) { return e.message } }
  check(`${alg} valid assertion via jwks_uri (no client_id in form)`, await tryAuth(form(await sign(kp, alg, good))) === 'ok')
  docMode = 'inline'
  check(`${alg} valid assertion via inline jwks`, await tryAuth({ ...form(await sign(kp, alg, good)), client_id: CID }) === 'ok')
  check(`${alg} issuer-origin audience accepted`, await tryAuth(form(await sign(kp, alg, { ...good, aud: 'https://app.artifactry.app' }))) === 'ok')
  check(`${alg} wrong key rejected`, (await tryAuth(form(await sign(other.kp, alg, good)))).includes('signature'))
  check(`${alg} wrong audience rejected`, (await tryAuth(form(await sign(kp, alg, { ...good, aud: 'https://evil.example/token' })))).includes('audience'))
  check(`${alg} expired rejected`, (await tryAuth(form(await sign(kp, alg, { ...good, exp: now - 600 })))).includes('expired'))
  check(`${alg} wrong sub rejected`, (await tryAuth(form(await sign(kp, alg, { ...good, sub: 'https://x.example/c.json' })))).length > 2)
  check(`${alg} missing assertion rejected`, (await tryAuth({ client_id: CID })).includes('missing'))
}
check('doc with private_key_jwt + jwks_uri accepted', readMetadataDocument(CID, { client_id: CID, redirect_uris: ['https://chatgpt.com/cb'], token_endpoint_auth_method: 'private_key_jwt', jwks_uri: 'https://chatgpt.com/j' }).authMethod === 'private_key_jwt')
let msg=''; try { readMetadataDocument(CID, { client_id: CID, redirect_uris: ['https://chatgpt.com/cb'], token_endpoint_auth_method: 'private_key_jwt' }) } catch (e) { msg = e.message }
check('private_key_jwt without keys rejected', msg.includes('jwks'))
msg=''; try { readMetadataDocument(CID, { client_id: CID, redirect_uris: ['https://chatgpt.com/cb'], token_endpoint_auth_method: 'client_secret_basic' }) } catch (e) { msg = e.message }
check('client_secret_basic doc still rejected', msg.length > 0)
check('none doc still accepted', readMetadataDocument(CID, { client_id: CID, redirect_uris: ['https://chatgpt.com/cb'] }).authMethod === 'none')
check('AS metadata advertises private_key_jwt + algs', authorizationServerMetadata('https://a.b').token_endpoint_auth_methods_supported.includes('private_key_jwt') && authorizationServerMetadata('https://a.b').token_endpoint_auth_signing_alg_values_supported.includes('ES256'))
console.log(`${pass} passed, ${failN} failed`); process.exit(failN?1:0)
