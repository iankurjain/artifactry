# Artifact Library

A mobile-first, multi-tenant **AI-Native Artifact Library SaaS** built entirely on Cloudflare
Pages + Workers. It gives a person or a team one governed library for the files they and their
AI tools create: permanent artifact links, versions, tags, collections, search, sharing, usage
analytics, an audit trail, and a scoped MCP endpoint that ChatGPT / Claude / Gemini can call.

Everything is edge-native: D1 for metadata and RBAC, R2 for binaries, FTS5 for lexical
search, and Vectorize + Workers AI for semantic search. There is no server process and
no filesystem.

---

## URLs

| | |
|---|---|
| **Application (Cloudflare Pages)** | https://artifact-library.pages.dev — live (BYOK, user's own account) |
| **Application custom domain** | `artifactry.app` — custom domain added to `artifact-library`; **pending DNS** (see *Outstanding setup*) |
| **Isolated preview surface** | https://artifactry-preview.pages.dev — a **separate** Pages project that serves no app shell |
| **Preview custom domain** | `preview.artifactry.app` — custom domain added to `artifactry-preview`; **pending DNS** |
| **Canonical artifact URL** | `/a/:artifactId` — permanent identity, survives renames, re-versioning and moves |
| **Share link** | `/s/:token` — external recipient surface |
| **Shared HTML viewer** | `/s/:token/artifact/:artifactId` — renders HTML shares as a page, not source |
| **Preview document (internal)** | `<PREVIEW_ORIGIN>/p/:token` — short-lived signed URL, inert on any other hostname |
| **Health** | `/api/health` (application) · `/api/health` (preview: liveness only) |
| **MCP endpoint** | `/api/v1/mcp` (JSON-RPC 2.0 over HTTP, protocol `2025-06-18`, 17 tools) |

---

## Feature status

### Completed

**Identity & tenancy**
- Passwordless **email OTP** sign-in; codes hashed and bound to `otp:v1:{purpose}:{email}:{code}` to defeat offline brute force, 30s resend cooldown, attempt counting
- **Dev-code mode**: when no email provider is configured the code is returned in the API response and logged, so the whole product is testable end to end. Setting `EMAIL_API_KEY` disables it automatically.
- Sessions stored hashed (raw token never persisted), 30-day expiry, opportunistic pruning on the login path (Pages has no cron)
- **Personal workspace auto-created** on first sign-in together with the membership row

**Organizations, workspaces, RBAC**
- Organizations → workspaces → members, with 5 roles (`ORG_OWNER`, `ORG_ADMIN`, `WORKSPACE_ADMIN`, `CONTRIBUTOR`, `VIEWER`) in a single `ROLE_PERMISSIONS` map
- ACL scope is derived server-side into every query (`WHERE workspace_id IN (...)`), never post-filtered
- Adding a member requires an existing account — the API refuses to provision accounts on someone else's behalf, which blocks account-takeover via invite

**Artifacts**
- Permanent identity (ULID), canonical slug, immutable object keys `org/{org}/workspace/{ws}/artifact/{id}/version/{n}/original`
- **Versions**: append, list, restore; URL and identity never change
- Validation: extension allow-list, per-type size limits, magic-byte sniffing, suspicious-content scan
- **Two-mode R2 access**: the `r2_buckets` binding with worker-proxied upload (presigned S3 URLs need separate credentials the BYOK token does not carry)
- Soft delete; deleting an artifact also revokes its shares

**Tags & collections**
- **Admin-governed tags** enforced server-side: a personal-scope tag requires an admin role in some org, an org-scope tag requires `ORG_OWNER`/`ORG_ADMIN`
- Deleting a tag in use is refused with an actionable "deactivate instead" conflict rather than silently orphaning join rows
- Collections with membership management and collection-level analytics

**Search — hybrid lexical + semantic**
- **D1 FTS5** index (`artifact_search`, `porter unicode61`) with `rowid` bound to `artifacts.seq`, ranked by `bm25(...)`
- Query building strips FTS5 syntax characters and prefix-matches; a safe OR fallback
- ACL-bounded filters and facets, recent searches, typeahead suggestions
- **Semantic search over Vectorize + Workers AI**: documents are chunked (target 1200
  chars, 200 overlap, ≤60 chunks), embedded with `@cf/baai/bge-base-en-v1.5` (768d) and
  upserted into the `artifact-library-embeddings` index (cosine). Lexical search is
  **kept**, not replaced — results are merged and each hit reports how it matched.
- **`semantic: true` only when the semantic query genuinely ran.** It is set from a
  `SemanticRun.ran` flag that requires *both* the query embedding and the Vectorize
  query to complete. An index outage, a failed embedding or an empty scope reports
  `semantic: false` with a reason and falls back to lexical-only results.
- **Two-layer tenant isolation.** Every vector carries `workspaceId`; `filterByScope()`
  drops any match whose workspace is not in the caller's readable set (failing closed on
  missing or empty metadata), and every semantic-only candidate is then re-loaded through
  SQL bounded by the same workspace ids. Semantic search can never surface an artifact
  outside the caller's authorization.

**Sharing**
- `PUBLIC_LINK` / `EMAIL` / `DOMAIN` access, optional expiry, view/download permissions
- Tokens stored **only as SHA-256 hashes**; the raw link is shown exactly once at creation
- Domain and email shares require a **verified** address — entitlement is decided at `/verify`, not by typing an address
- `/request-code` emails regardless of whether the address matches a recipient, so the endpoint cannot be used to enumerate recipients
- External recipient UI renders a strict `externalShareView` projection that strips internal fields

**Analytics** (PRD §46, §88, §111)
- Raw `artifact_events` + incremental `artifact_daily_metrics` rollups
- **Genuine distinct viewers** via `artifact_viewer_keys` and `COUNT(DISTINCT viewer_key)` using a daily-rotating privacy-safe key — no fingerprinting, and no per-day-unique double counting
- Views / unique viewers / downloads / AI references, daily series, channel breakdown (internal, public link, email, domain, AI), recent activity
- Owner and workspace admins only; viewers and external recipients get none
- Anonymous viewers are never guessed at

**Audit trail** — append-only `audit_events` for auth, artifact, share, taxonomy, member and AI actions

**Universal Artifact API + remote MCP**
- 17 MCP tools over JSON-RPC 2.0 (initialize, tools/list, tools/call, ping, batch support)
- **Scoped OAuth-style grants**: `artifact.read`, `artifact.write`, `artifact.share`, `analytics.read`; per-tool `requiredScope` enforced server-side, so capability is decoupled from what the provider UI offers
- Grants are hashed at rest and revocable; a connector can never exceed the granting user's own access
- AI provenance recorded on every AI-created artifact and version

**Responsive UI — mobile-first, not mobile-only** (supersedes the old PRD §71 hard 430px lock)
- **Mobile (<768px)**: bottom navigation, stacked cards, no horizontal scrolling, 44–48px
  touch targets, centre Add button, safe-area padding. Usable from 320px.
- **Tablet (≥768px)**: wider centred column (720px), 3-column artifact grid, 4-column stat
  rows, docking bottom bar
- **Desktop (≥1024px)**: the bottom bar becomes a **fixed left navigation rail** (232px) and
  content widens to 1040px; 2-column artifact detail (`minmax(0,1.35fr) minmax(0,1fr)`), wider
  analytics and search/filter layouts
- **Wide (≥1440px)**: content caps at 1200px with a 4-column grid
- Width is driven by `--nav-w` / `--content-max` / `--content-pad`, so cards grow into real
  multi-column layouts instead of being stretched to full-screen width
- **Bottom sheets instead of modals**, with focus move/restore, Escape dismissal, and reduced-motion respect
- Cards, never wide tables; `text-2xl` maximum screen title on mobile
- Every dynamic value passes through `esc()`; `safeUrl()` gates href/src

**HTML artifacts — two preview modes on two origins**

An HTML artifact is rendered in one of two explicit modes. The mode is enforced by a
`Content-Security-Policy` that **travels with the bytes**, so the restriction holds even if a caller
embeds the URL without a sandbox attribute of its own.

| | **Safe Preview** (default) | **Interactive Preview** (owner opt-in, per artifact) |
|---|---|---|
| HTML + CSS render | yes | yes |
| JavaScript executes | **no** | yes |
| `frame` sandbox | (none granted) | `allow-scripts allow-forms` |
| `connect-src` | `'none'` | `'none'` |
| Allowed framer | the app origin | the app origin |

- **Default is OFF and fail-closed.** Interactive Preview requires **both** `PREVIEW_ORIGIN` and
  `PREVIEW_TOKEN_SECRET`. Missing either one means the mode is unavailable and every artifact falls
  back to Safe Preview. An artifact may *lower* its own mode; a token can never *raise* it.
- **The document-level CSP carries a `sandbox` directive.** `allow-same-origin` is never emitted, by
  either the iframe attribute or the document policy, which is what makes the framed document's
  origin **opaque** — no cookies, no `localStorage`, no `sessionStorage`, no parent DOM.
- **Top navigation and popups cannot escape.** Neither `allow-top-navigation` nor `allow-popups` is
  granted, and the probe suite asserts the top-level URL never changes and no extra tab opens.
- **No network egress by default.** `connect-src 'none'` blocks `fetch`, `XMLHttpRequest`,
  WebSocket and beacon. This is asserted by a **real HTTP sink receiving nothing** (a rejected
  promise would be ambiguous, and `sendBeacon` resolves `true` even when CSP then blocks the send).
- **Short-lived signed tokens.** HMAC-SHA256 `v1.<payload>.<sig>`, 600 s TTL clamped to a 900 s
  ceiling, constant-time compare. The payload carries the artifact, version, mode, share and grant
  ids — the **recipient's email is never in the token**. `share_access_grants.id` is an opaque
  reference re-checked against live state on every load, so **share expiry, revocation and
  recipient authorization are all preserved** (a revoked share's live token stops working).
- **The token is pinned to one hostname.** It signs the framing origin; the preview surface refuses
  a token whose signed origin is not `APP_ORIGIN`, and refuses any request whose hostname is not
  `PREVIEW_ORIGIN`. A signed URL is therefore **inert on `artifactry-preview.pages.dev`**.
- **The preview surface is a separate Worker.** `artifactry-preview` routes only `/p/:token` and
  `/api/health`; everything else is a plain-text 404. The reason is measured, not theoretical: on a
  shared runtime the preview hostname answered `/p/` with the **22,056-byte SPA shell** (containing
  `id="app"` and `boot-data`). A hostname that exists to be isolated must never serve the app, so it
  is its own Worker with no shell, no static assets and no API.
- **The main origin is unchanged.** The app still sends `X-Frame-Options: DENY` on every route.

### Not implemented (and why)

These are honest capability gaps, not omissions:

| Gap | Reason |
|---|---|
| **PDF extraction is BEST-EFFORT — not complete PDF support** | The hand-written parser decodes Flate/ASCII85/ASCIIHex filter chains and resolves per-font **ToUnicode CMaps**, which is what makes Word/LibreOffice output readable. It does **not** decode **object streams (`/ObjStm`)**, **encrypted** content, or fonts with **no ToUnicode map**, and it does not do full **CID/CMap or embedded-font-program** reconstruction. Those PDFs correctly report *no text layer* rather than guessed text. Title, filename, description and tags remain searchable. |
| **Searchable document text** | PDF, DOCX, PPTX and HTML are parsed in-Worker (`DecompressionStream` + hand-rolled OOXML/PDF readers), stored on `artifact_versions.extracted_text` and indexed into FTS5. Per-format job status is `DONE` / `PARTIAL` / `SKIPPED` / `FAILED` with a human-readable note and a `via` provenance string. |
| **Semantic / vector search** | **Implemented** for Documents that yield text. Requires the `VECTORIZE` and `AI` bindings; with them absent the code reports `semantic: false` and a reason rather than pretending. |
| **Extraction is best-effort by design** | PDF, DOCX, PPTX and HTML text **are** extracted (pure web-platform parsers, no Node deps). Formats we have no parser for (images, archives) and documents with no recoverable text (scanned/image-only PDFs) report `SKIPPED` / `PARTIAL` respectively with an explicit note — never a silent failure or a fake success. Validated against a 9-document set from 6 distinct generators (see below). |
| **DOCX / PPTX generation** | Refused with `ConversionUnsupported` and an actionable message. Content can be rendered to **PDF and HTML** only. |
| **Presigned R2 uploads** | Need dedicated S3 credentials. Uploads are worker-proxied instead. |
| **Cron / scheduled jobs** | Not available on Pages. Expired sessions and OTPs are pruned opportunistically on the login path. |
| **Custom domains not yet resolving** | Both Pages custom domains are registered (`artifactry.app` → `artifact-library`, `preview.artifactry.app` → `artifactry-preview`) but sit at `verification_data: "CNAME record not set"`. The two CNAME records are **not yet created** — the deploy token has Zone:Read but not DNS:Edit, so this is a manual step (exact records in *Outstanding setup*). The `pages.dev` hostnames are fully live and already enforce the whole isolation model. |
| **Interactive Preview is off by default** | Deliberate. `PREVIEW_TOKEN_SECRET` *is* now set on both projects, so the mode is available, but each artifact is Safe until its owner opts in. |
| **Email to arbitrary recipients** | Resend is configured (`EMAIL_API_KEY` set, dev-code mode off), but the Resend account has **no verified sending domain**. With the shared test sender, Resend delivers **only to the address that owns the Resend account**. Verify a domain and set `EMAIL_FROM` to an address on it to open delivery to all recipients. Non-deliverable addresses fail loudly (`400`) rather than silently. |

---

## Data architecture

**Storage services**
- **Cloudflare D1** — 27 tables: `users`, `auth_sessions`, `auth_otp`, `organizations`, `organization_members`, `workspaces`, `workspace_members`, `artifacts`, `artifact_versions`, `tags`, `artifact_tags`, `collections`, `collection_artifacts`, `shares`, `share_recipients`, `share_access_grants`, `integrations`, `integration_grants`, `artifact_events`, `artifact_daily_metrics`, `artifact_viewer_keys`, `audit_events`, `processing_jobs`, `search_history`, `artifact_favorites`, `artifact_embeddings`, `app_kv` + the `artifact_search` FTS5 virtual table
- **Cloudflare R2** — artifact binaries under immutable per-version keys
- **Cloudflare Vectorize** — `artifact-library-embeddings`, **768 dimensions, cosine**
- **Workers AI** — `@cf/baai/bge-base-en-v1.5` embeddings

**Vector index contract**

The dimension count in `wrangler.jsonc`, `EMBEDDING_DIMENSIONS` in `src/lib/embeddings.ts` and
the live index must all agree, or every upsert is rejected at runtime.

- Vector id: `{artifactId}__{versionId}__{chunkIndex}`
- Metadata per vector: `artifactId`, `versionId`, `workspaceId`, `organizationId`,
  `ownerUserId`, `chunkIndex`, `chunkTotal` (`organizationId` is `''` and never null —
  Vectorize metadata cannot hold null)
- **Vectorize has no delete-by-metadata**, so D1's `artifact_embeddings` is the authoritative
  mirror of every written vector id; stale vectors are deleted by id looked up from it
- Indexing state per artifact: `PENDING` | `INDEXED` | `PARTIAL` | `FAILED` | `SKIPPED`,
  exposed at `GET /api/v1/artifacts/:artifactId/index-state`. `PARTIAL` means the document was
  understood but held nothing embeddable (an empty or scanned file).
- **`app_kv` table** — used for rate-limit counters via `INSERT … ON CONFLICT … RETURNING` (no KV namespace, deliberately: `kv_namespaces` is rejected by hosted deploy, and this table works on both deployment paths)

**Core models**
- `artifacts` carries `seq INTEGER PRIMARY KEY AUTOINCREMENT` for FTS rowid binding, plus `id TEXT UNIQUE` as the permanent public identity
- `artifact_versions` is append-only; `artifacts.current_version_id` points at the live one
- `shares` stores `token_hash` + `token_prefix`; the prefix is what the management UI displays
- `artifact_daily_metrics` is a rollup maintained incrementally by `applyDelta`, so analytics reads never scan the raw event table

**Authorization**
`ROLE_PERMISSIONS` → `can()` → assert helpers. Every read path starts from `readableWorkspaces()`; an artifact the caller may not read returns **404, not 403**, so artifact ids cannot be probed.

---

## User guide

1. **Sign in** — enter your email, receive a 6-digit code (in dev mode the code is shown on screen).
2. **Add something** — the centre **Add** button offers a file upload, saving HTML/text, creating a collection, or connecting an AI app. Supported uploads: `pptx`, `pdf`, `docx`, `html`, `png`, `jpg`, `jpeg`, `bmp`, `gif`.
3. **Library** — filter by type, sort, search within your library. Tap any card to open the artifact.
4. **Artifact detail** — preview HTML inline, **Share** and **Download** live in the thumb zone; secondary actions (rename, tag, new version, copy canonical link, analytics, delete) are in the ••• sheet.
5. **Versions** — "upload a new version" keeps every previous one; the link never changes. Any version can be restored.
6. **Share** — choose link / specific people / email domain, set an expiry and whether downloading is allowed. **The link is shown once**; copy it then. Recipients verify their email before they see anything.
7. **Search** — full-text across title, filename, description, tags and the **extracted text of your documents**, limited to what you can read.
8. **Profile** — usage totals, workspaces, organizations, connected AI apps, active shares, tag management, activity feed, and a **Help** card linking to the user guide.
9. **Admin** — organization totals, members, workspaces and AI-created breakdown, as cards.
10. **Connect an AI app** — connect from Profile/Add, pick the least privilege you need, then paste the **MCP endpoint** and **access token** into the AI app. The token is shown once.

### The in-app user guide

There is a searchable guide at **`/guide`** (`public/static/guide.js`). It is a
**public** surface — it reads no user data, so it renders with or without a
session — and it is linked from:

- the **footer** rendered at the bottom of every screen (`ctx.appFooter()`), and
- the **Profile → Help** card, alongside "Keyboard & tips" (`ctx.openShortcutsSheet()`).

It has 16 sections (getting started, uploading, library, search, extraction,
tags, collections, sharing, versions, analytics, AI apps, roles, security,
accessibility, limits, troubleshooting) with an in-page filter that searches
titles, tags and body text and highlights matches. Its **limits** section is
deliberately explicit: semantic search is reported as unavailable until the
vector index exists on the account, and the app never presents keyword results
as though they were semantic.

---

## Local development

```bash
npm run build                                     # vite build → dist/
npm run db:migrate:local                          # apply migrations to the local SQLite
npm run db:seed                                   # optional demo data
pm2 start ecosystem.config.cjs                    # wrangler pages dev on :3000 (R2/D1 emulated)
curl http://localhost:3000/api/health
node scripts/check-imports.mjs                    # verifies every relative import resolves
```

The D1 binding, R2 bucket and local emulation are configured in `wrangler.jsonc`. `npm run db:reset`
rebuilds the local database from scratch.

---

## Deployment

Two **separate** Cloudflare Pages projects. The preview hostname is deliberately *not* a second
domain on the app project, because a shared runtime answers unmatched paths with the app shell.

| | Application | Preview surface |
|---|---|---|
| **Pages project** | `artifact-library` | `artifactry-preview` |
| **Custom domain** | `artifactry.app` (pending DNS) | `preview.artifactry.app` (pending DNS) |
| **Live hostname** | https://artifact-library.pages.dev | https://artifactry-preview.pages.dev |
| **Build** | `vite build` → `dist/` (226.62 kB, gzip 65.34 kB) | `vite build -c vite.preview.config.ts` → `dist-preview/` (33.63 kB, gzip 12.83 kB) |
| **Bindings** | D1 `DB`, R2 `R2`, Vectorize, Workers AI | D1 `DB`, R2 `R2` (**no** Vectorize/AI) |
| **Origin vars** | `APP_ORIGIN`, `PREVIEW_ORIGIN`, `APP_NAME`, `EMAIL_FROM`, `MAX_UPLOAD_BYTES` | `APP_ORIGIN`, `PREVIEW_ORIGIN` |
| **Secrets** | `EMAIL_API_KEY`, `PREVIEW_TOKEN_SECRET` | `PREVIEW_TOKEN_SECRET` |

- **Platform**: Cloudflare Pages (BYOK — the user's own account via API token)
- **Compatibility date**: 2026-09-17
- **Status**: ✅ **Both surfaces live** on their `pages.dev` hostnames; custom domains pending DNS

Redeploy with:

```bash
npx wrangler d1 migrations apply artifact-library-production --remote  # if new migrations
npm run deploy:prod        # application  → artifact-library
npm run deploy:preview     # preview      → artifactry-preview (scripts/deploy-preview.sh)
```

**Why the preview deploy has its own directory.** `wrangler pages deploy` has **no `--config`**
flag: it always reads `wrangler.jsonc` from the *current working directory*. Deploying the preview
worker from the repo root would read the **application's** config and target `artifact-library`.
The preview deploy therefore runs with `deploy/preview/` as cwd, and `scripts/deploy-preview.sh`
asserts the bundle is the minimal preview surface (size ceiling + no SPA-shell marker) before it
uploads. No secrets live in that directory.

**`PREVIEW_TOKEN_SECRET` must be byte-identical on both projects**, or every token the app mints is
rejected by the preview surface. It is set out-of-band and never committed:

```bash
printf '%s' "$VALUE" | npx wrangler pages secret put PREVIEW_TOKEN_SECRET --project-name artifact-library
printf '%s' "$VALUE" | npx wrangler pages secret put PREVIEW_TOKEN_SECRET --project-name artifactry-preview
```

### Outstanding setup (manual — needs DNS permission)

The token used for this deploy has **Zone:Read** but **not DNS:Edit**
(`GET /zones/{id}/dns_records` → `10000 Authentication error`), so the two records below could not
be created and both custom domains remain unverified. Create them in **DNS → Records**:

| Type | Name | Content | Proxy |
|---|---|---|---|
| `CNAME` | `artifactry.app` (apex) | `artifact-library.pages.dev` | **Proxied (orange cloud)** |
| `CNAME` | `preview` | `artifactry-preview.pages.dev` | **Proxied (orange cloud)** |

Both use Cloudflare-managed TLS; no certificate needs to be issued by hand. To let the token do this
itself next time, add the narrow scope **Zone → DNS → Edit** for `artifactry.app` only — no broader
account permission is required.

> **Note on the apex.** `artifactry.app` and `www.artifactry.app` already resolve to Cloudflare
> proxied addresses and return **`525` (SSL handshake failed)**, and the apex carries an
> `MX → inbound-smtp.ap-northeast-1.amazonaws.com`. That means something other than this Pages
> project is already bound to those hostnames. Adding the apex CNAME above **requires removing
> whatever currently serves them** (a Worker route, or an existing record), or the Pages custom
> domain will never validate. `preview.artifactry.app` has no record at all and is the clean half.

**Resource bindings** (must exist on the account before deploying):

| Binding | Type | Name |
|---|---|---|
| `DB` | D1 | `artifact-library-production` |
| `R2` | R2 bucket | `artifact-library-bucket` |
| `VECTORIZE` | Vectorize index | `artifact-library-embeddings` (768d, cosine) |
| `AI` | Workers AI | — |

The Vectorize index must exist before deploying:

```bash
npx wrangler vectorize create artifact-library-embeddings --dimensions=768 --metric=cosine
```

`wrangler pages deploy` fails with `Failed to publish your Function. Got error: R2 bucket
'artifact-library-bucket' not found.` whenever the bucket is missing — this is a downstream
symptom of the bucket not existing, not a code problem.

**On first-time R2 setup** the account must have R2 *enabled* once in the dashboard (R2 →
Enable R2, payment method on file even for the free tier). Until then the R2 API answers
`403 {"code":10042,"message":"Please enable R2 through the Cloudflare Dashboard."}` — this is
**activation**, not authorization, so adding `Workers R2 Storage Write` alone will not clear it.
Note that `10042` is distinct from `10000 Authentication error`: if R2 is enabled but the token
lacks an R2 scope, the API answers `10000` instead. `wrangler whoami` reports the account either
way, so a successful `whoami` does **not** imply R2 access — test `/accounts/:id/r2/buckets`.

Also required: the token needs **Workers R2 Storage Write** (account-level, all accounts) to
create/read buckets; D1 and Pages scopes are separate and will not cover it.

**Email**: `EMAIL_API_KEY` (Resend) **is set**, so dev-code mode is off and codes are emailed.

> **Sender-domain limitation.** Resend refuses to send from an unverified domain, and this
> account has **no verified domain** (`GET https://api.resend.com/domains` → empty). The code's
> built-in fallback sender is `noreply@artifactlibrary.dev`, which Resend rejects with `403` —
> so `EMAIL_FROM` is pinned in `wrangler.jsonc` to `onboarding@resend.dev`, the one identity
> this account can currently send as. With that sender Resend delivers **only to the Resend
> account owner's address**; every other recipient is rejected `403` and the API fails with
> `400 Could not send email. Please try again shortly.`
>
> **To fix properly:** verify a domain at https://resend.com/domains (add DNS records), then
> change `EMAIL_FROM` in `wrangler.jsonc` to an address on it and redeploy. Alternatively, set
> `DEV_LOGIN_MODE=false` *and* revert to dev-code mode to restore demo sign-in — but note that
> without an email key dev-code mode is the only working path.

**Alternative path.** `gsk-hosted-deploy` provisions D1/R2 on a Genspark-managed Cloudflare
account with no billing step. The source works unmodified on that path (see note 1 below), but
`kv_namespaces` and `triggers` must stay absent, which they are.

Other operational notes for this deployment path:

1. **`kv_namespaces` and `triggers` are deliberately absent** from `wrangler.jsonc`, so the same
   source also works unmodified on the platform-hosted deploy path.
2. **No hosted access rules are set** — this is a Pages deployment, which cannot enforce them, and
   such rules are rejected while present. The application performs its own authentication.
3. **Email delivery** uses Resend (`EMAIL_API_KEY` set). Because the account has no verified
   sending domain, `EMAIL_FROM` must stay on the shared test sender — see the sender-domain
   limitation above. A failed send writes **no** `auth_otp` row and burns **no** cooldown, so a
   delivery failure never locks a recipient out or leaves a false audit record.

---

## Tech stack

Hono 4 · TypeScript · Vite 8 · Wrangler 4 · Cloudflare Pages / Workers · D1 (SQLite + FTS5) · R2 ·
Web Crypto · vanilla ES-module frontend (no framework) · Tailwind CDN for layout utilities only,
with the palette owned by CSS custom properties so the preview iframe and share page match.

## Extraction validation set

`scripts/gen-extraction-fixtures.py` builds 9 real documents from 6 distinct generators;
`scripts/validate-extraction.mjs` runs the **shipped** extractor against them and reports what was
actually recovered, including failures. It exits non-zero only when a document that must yield text
yields none, or a scan invents text. `expect: "maybe"` cases are reported but never fail the run.

| Fixture | Generator | Result |
|---|---|---|
| `finance-reportlab.pdf` | reportlab (base-14) | PASS 317 chars |
| `legal-pymupdf.pdf` | PyMuPDF | PASS 256 chars |
| `onboarding-libreoffice.pdf` | LibreOffice | PASS 331 chars (via ToUnicode CMaps) |
| `unicode-embedded-ttf.pdf` | reportlab (embedded TTF / CID) | RECOVERED 270 chars (best-effort) |
| `onboarding-python-docx.docx` | python-docx | PASS 311 chars |
| `spec-raw-ooxml.docx` | hand-built OOXML zip | PASS 313 chars |
| `roadmap-python-pptx.pptx` | python-pptx (slides + notes) | PASS 552 chars |
| `sales-table-pptx.pptx` | python-pptx (table) | PASS 103 chars |
| `scanned-finance.pdf` | PIL image-only | PASS — correctly reports **0 chars**, no invented text |

```bash
python3 scripts/gen-extraction-fixtures.py /tmp/val
node scripts/validate-extraction.mjs /tmp/val
node scripts/test-semantic.mjs      # 90 assertions over chunking, isolation, stale vectors, outages
node scripts/test-extract.mjs
node scripts/check-imports.mjs
```

---

---

## Release gates

All ten must pass before a deploy. `scripts/run-gates.sh` runs them strictly sequentially under a
lock file — the browser suites share a probe account, and running two at once consumes each other's
one-time code.

```bash
bash scripts/run-gates.sh
```

| Gate | What it proves |
|---|---|
| `build` (+ `build:preview`) | Both bundles compile |
| `check-imports` | Every relative import resolves against a real export |
| `check-undefined` | No project symbol is referenced without an import or local declaration |
| `test-preview` | 101 assertions over mode resolution, CSP construction... |
| `test-preview-security` | 89 real-browser, two-origin isolation assertions |
| `test-preview-ui` | 32 real-DOM assertions over the owner-only toggle |
| `test-authz` | 45 authorization assertions |
| `test-index-sync` | 20 index reconciliation assertions |
| `test-semantic` | 102 semantic-search and isolation assertions |
| `test-extract` | Extraction against 9 real documents from 6 generators |

`scripts/check-undefined.mjs` exists because a bundle that builds clean can still reference a symbol
that was never imported — that caused three separate `500`s in the preview path, and the gate caught
a fourth the moment it was introduced.

**Production validation** (`node scripts/test-production.mjs`) runs against the deployed domains.
It currently reports **32 passed, 0 failed, 11 blocked**.

The blocked items are the *session-dependent* half of the checklist (Safe/Interactive render
behaviour, storage and parent-DOM reachability, egress, token expiry/revocation, the owner toggle):
a production OTP is **emailed**, so an unattended script cannot sign in. Those are reported as
**BLOCKED, never as passing** — a skipped security assertion must not read as a verified one.

The 32 that do run cover, on the live deployment: which hostname serves the shell and which refuses
to (five paths on the preview surface, each asserted to carry **no** `id="app"` / `boot-data` / `/static/app.js`
bytes), that the preview surface **never** sets a cookie on any path, that a malformed token is
refused with a locked-down non-cacheable page, that a signed URL is **inert on the default
`pages.dev` hostname** (the hostname pin), that a real browser holds **no cookie and no
`localStorage`/`sessionStorage`** on the preview origin, and that the **minting surface is
session-gated** — the artifact list, artifact detail, `preview-settings` (GET *and* PUT) and the
app-origin Safe fallback all return `401` without a session.

---

**Last updated**: 2026-09-29
