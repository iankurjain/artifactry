# Artifactry

**Artifactry** is a mobile-first, multi-tenant **AI-native artifact library SaaS** built entirely
on Cloudflare Pages + Workers. It gives a person or a team one governed library for the files they
and their AI tools create: permanent artifact links, versions, tags, collections, search, sharing,
usage analytics, an audit trail, and a scoped MCP endpoint that ChatGPT / Claude / Gemini can call.

Everything is edge-native: D1 for metadata and RBAC, R2 for binaries, FTS5 for lexical
search, and Vectorize + Workers AI for semantic search. There is no server process and
no filesystem.

---

## URLs

| | |
|---|---|
| **Application (Cloudflare Pages)** | https://artifact-library.pages.dev — live (BYOK, user's own account) |
| **Application custom domain** | https://app.artifactry.app (Pages custom domain on `artifact-library`, Cloudflare-managed TLS). Until the cutover in `site/README.md`, the app is still also served at https://artifactry.app |
| **Marketing site** | https://artifactry.app (Pages project `artifactry-site`, from `site/public`) |
| **Docs** | https://docs.artifactry.app (Pages project `artifactry-docs`, from `site/docs`) |
| **Isolated preview surface** | https://artifactry-preview.pages.dev — a **separate** Pages project that serves no app shell |
| **Preview custom domain** | https://preview.artifactry.app — **live** (Pages custom domain on `artifactry-preview`) |
| **Canonical artifact URL** | `/a/:artifactId` — permanent identity, survives renames, re-versioning and moves |
| **Share link** | `/s/:token` — external recipient surface |
| **Shared HTML viewer** | `/s/:token/artifact/:artifactId` — renders HTML shares as a page, not source |
| **Preview document (internal)** | `<PREVIEW_ORIGIN>/p/:token` — short-lived signed URL, inert on any other hostname |
| **Health** | `/api/health` (application) · `/api/health` (preview: liveness only) |
| **MCP endpoint** | `/api/v1/mcp` (JSON-RPC 2.0 over HTTP, protocol `2025-06-18`) — job-oriented: **Find → Save → Share** |

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

**Universal Artifact API + remote MCP — the Find → Save → Share surface**
- **Ten job-oriented tools**, not storage primitives:
  `search` · `get` · `save` · `create_version` · `share` · `revoke_share` ·
  `list_workspaces` · `list_teams` · `list_tags` · `update_tags`
  (`revoke_share` exists so a share can be withdrawn, and the three `list_*`
  lookups exist because no agent can name an audience it cannot see.)
- The end-to-end flow the surface is designed around: *find the Q3 finance deck →
  create a board Q&A → save the Word doc to Finance → share with Board prep for 7 days*.
  Low-level primitives stay behind the service layer; they remain reachable as REST
  but an agent is not invited to reason in them.
- `search` reuses the **existing hybrid lexical + semantic engine and the existing RBAC**,
  and takes natural language plus workspace, type, tags, owner, date range, collection/team,
  sort and limit. It returns id, title, type, **canonical URL**, workspace, tags, updated date,
  match type and an **authorized** excerpt — an excerpt is only ever read from rows that already
  passed the ACL, so it can never widen visibility.
- `save` accepts, in order of preference: an **HTML page as `content`** (stored byte-for-byte,
  never wrapped or escaped), a **ChatGPT file** via `file_ref` (declared as an
  `openai/fileParams` parameter, so ChatGPT hands over a download URL instead of the model
  base64-encoding bytes), a **public `source_url`** (https only, private/loopback hosts refused,
  size capped while streaming), `content_base64` for small binaries, plain text that
  Artifactry converts to PDF/HTML, or an **`upload_id`** from `upload_part`.
- `upload_part` (`src/lib/uploads.ts`) gets a file that is too big for one tool call into
  Artifactry: the model sends it in pieces (text as `content`, binaries as `content_base64`),
  then calls `save` or `create_version` with the `upload_id`. The same id is a one-time
  `PUT /api/v1/uploads/:id` link for clients that can run code. Pieces live in R2 under a hash
  of the id, expire after 24 hours and are deleted once saved; no D1 table is involved. It creates either a new artifact or a new version. It returns the artifact id,
  canonical URL, workspace, **indexing state** and **proposed tags**.
- `share` accepts an artifact id **or a canonical Artifactry URL**, and an audience of specific
  emails, an email domain, a **named team**, a workspace, or a public link, with expiry and
  view/download permission.
- **OAuth 2.1 sign-in for connectors** (migration 0007, `src/lib/oauth.ts`, `src/routes/oauth.ts`):
  protected-resource and authorization-server metadata, Dynamic Client Registration, a
  server-rendered sign-in + consent page, authorization code + PKCE S256, 1-hour access tokens
  and rotating 90-day refresh tokens. Every 401 from `/api/v1/mcp` carries
  `WWW-Authenticate: Bearer resource_metadata=…`, which is how ChatGPT, Claude, Copilot Studio
  and Gemini start sign-in. An OAuth access token **is an `integration_grants` row**, so scopes,
  provenance, analytics and Disconnect behave exactly as for a pasted token. Clients that must be
  given a client id + secret (Gemini Enterprise, Copilot Studio "Manual") get one from
  `POST /api/v1/integrations/oauth-clients`. Pasted tokens keep working and never expire.
- **Streamable HTTP details**: notifications get `202` with no body, `GET` asking for
  `text/event-stream` gets `405`, and the negotiated protocol version echoes any supported one
  (`2024-11-05` … `2025-11-25`). Tools carry `title` and `readOnlyHint`/`destructiveHint`
  annotations so clients skip the approval prompt on lookups.
- **Scoped OAuth-style grants**: `artifact.read`, `artifact.write`, `artifact.share`, `team.read`,
  `workspace.read`, `tags.read`, `analytics.read`; per-tool `requiredScope` enforced server-side,
  so capability is decoupled from what the provider UI offers
- Grants are hashed at rest and revocable; a connector can never exceed the granting user's own access
- AI provenance recorded on every AI-created artifact and version, including the **AI client name**
  ("Claude Desktop") reported in the `initialize` handshake, so "which AI did what, on whose
  behalf" is answerable rather than inferred

**Teams — reusable named audiences**
- A team is an organization- or workspace-scoped audience: name, members, owner/admin, active/inactive
- `artifactry.share(url, team="Board prep")` resolves the name to a reusable audience instead of
  repeating individual addresses
- **Ambiguous names are never guessed.** Two organizations may each have a "Board prep"; matching
  more than one team returns `AMBIGUOUS` **with the candidates** and requires disambiguation, because
  picking one would be a coin flip on a confidential document
- Membership is **live**: member addresses are materialised into the share at creation time, and a
  current active member of a linked team also passes `evaluateShareAccess`, so adding someone to
  "Board prep" grants them access without re-issuing the link
- A team cannot be used for an artifact in a personal workspace, or across organizations; a team with
  no active members refuses; the last admin cannot be removed

**AI-suggested, human-decided tags**
- **Every artifact is tagged automatically** on upload, save and reprocess: extract → suggest from the
  artifact's own content and metadata → attach as **SUGGESTED** → show the user
- Three states — **SUGGESTED / CONFIRMED / REJECTED** — and three provenances — **AI / USER / ADMIN**.
  The decision lives on the *association*, so the same tag can be confirmed on one artifact and
  rejected on another
- **Rejection is remembered.** A rejected tag is not re-offered against unchanged content; it may only
  be proposed again when a materially new version changes the basis for the judgement
- Guardrails: **3–7 tags**, preferring subject, customer/company, project, geography, document purpose
  and domain/topic; generic words (Document, File, PDF, Presentation, report, draft) are dropped
  **unless the user typed them deliberately**; sensitive personal attributes are refused even when
  entered manually, because the tag itself would be the leak. Whole-word matching, so "Gaylord"
  never trips the "gay" rule
- **Only CONFIRMED tags enter the search index.** A machine guess cannot silently change what the
  library can find, and a rejected tag leaves the index
- Names are de-duplicated case-insensitively: "AI", "ai" and "Ai" are one tag
- **Users may create tags** (this supersedes the earlier admin-only rule). An organization may keep an
  admin-managed canonical set and may disable user-created tags via `settings.allowUserTags === false`
  — but that blocks *invention*, never the use of existing tags, and never an org admin

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

| | **Safe Preview** (opt-out at upload, or per artifact) | **Interactive Preview** (default for new HTML uploads) |
|---|---|---|
| HTML + CSS render | yes | yes |
| JavaScript executes | **no** | yes |
| `frame` sandbox | (none granted) | `allow-scripts allow-forms` |
| `connect-src` | `'none'` | `'none'` |
| Allowed framer | the app origin | the app origin |

- **Fail-closed.** New HTML uploads ask for Interactive Preview (the uploader can untick it), but it requires **both** `PREVIEW_ORIGIN` and
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
| **Apex `MX` is a pre-existing record we preserved** | `artifactry.app` carries `MX → inbound-smtp.ap-northeast-1.amazonaws.com`, which predates this project. It was **left untouched** during the DNS change, so it is unrelated to Artifactry mail (which sends through Resend). Remove it only if you know it is stale — it does not affect the web surfaces. |
| **Interactive Preview is off by default** | Deliberate. `PREVIEW_TOKEN_SECRET` *is* now set on both projects, so the mode is available, but each artifact is Safe until its owner opts in. |
| **Sharing beyond the organization requires explicit human confirmation** | Deliberate, not a gap: a public link, raw email/domain audience or anything else that takes content outside the tenant returns a **confirmation request** and shares **nothing** until the user agrees. The confirmation is bound to a hash of the exact normalised request, so consent for one audience cannot execute a different one, and it is single-use with a 15-minute TTL. Internal audiences (a team or workspace in the same organization) proceed without a prompt. |
| **Auto-tagging needs the AI binding for content-derived tags** | Without the `AI` binding, or when a document has no recoverable text layer, the suggester reports honestly that it ran **metadata-only** (title, type, workspace) and says so in its note. It never fabricates subject matter it did not read. |
| **Email to arbitrary recipients** | Resend is configured (`EMAIL_API_KEY` set, dev-code mode off), but the Resend account has **no verified sending domain**. With the shared test sender, Resend delivers **only to the address that owns the Resend account**. Verify a domain and set `EMAIL_FROM` to an address on it to open delivery to all recipients. Non-deliverable addresses fail loudly (`400`) rather than silently. |

---

### Audio and video

- **Formats.** Audio: mp3, m4a, aac, wav, ogg/oga, flac. Video: mp4, m4v, mov, webm. Each is checked
  against its signature (ID3/MPEG frames, `ftyp`, RIFF/WAVE, OggS, fLaC, EBML) and served under its
  own type, never the one the browser declared.
- **Limits.** Audio up to **20 MB**, video up to **200 MB**, in every workspace (the 25 MB platform
  cap and the workspace cap do not apply to them).
- **Parted upload.** The web app sends audio and video in 8 MB parts straight into an R2 multipart
  upload at the artifact's final key (`POST /api/v1/artifacts/media-uploads`, `PUT …/:id/parts/:n`,
  `POST …/:id/complete`), so a 200 MB video never passes through one request or a Worker's memory.
  Each part must be exactly its size, so the joined file is exactly the declared size. Upload state
  lives in R2 under `staging/media/`, so there is no migration.
- **Playback.** The artifact page plays them inline with the browser's own player; `/content` (and
  the share `/content`) answer `Range` requests with `206`, so seeking works and Safari plays video.
  Only a play's first request counts as a view.
- **Not yet.** A new *version* of a video over 25 MB, and MCP `save` of media over 25 MB, still go
  through the one-request path and its 25 MB cap. No transcripts or thumbnails are made.

## Data architecture

**Storage services**
- **Cloudflare D1** — 31 tables: `users`, `auth_sessions`, `auth_otp`, `organizations`, `organization_members`, `workspaces`, `workspace_members`, `artifacts`, `artifact_versions`, `tags`, `artifact_tags`, `collections`, `collection_artifacts`, `shares`, `share_recipients`, `share_access_grants`, `share_teams`, `teams`, `team_members`, `mcp_confirmations`, `integrations`, `integration_grants`, `artifact_events`, `artifact_daily_metrics`, `artifact_viewer_keys`, `audit_events`, `processing_jobs`, `search_history`, `artifact_favorites`, `artifact_embeddings`, `app_kv` + the `artifact_search` FTS5 virtual table
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
- `artifact_tags` carries `state` (SUGGESTED / CONFIRMED / REJECTED), `provenance` (AI / USER / ADMIN) and `source_version_id` — the association is a **decision record**, which is why a rejection is a stored state rather than a deleted row. `UNIQUE(artifact_id, tag_id)` makes a decision an update, so accept-after-reject cannot accumulate duplicates.
- `teams` is scoped `ORGANIZATION` | `WORKSPACE` and `organization_id` is **NOT NULL** by design: a team with no tenant would be unscopeable. Membership is keyed by `email_normalized`, because a named audience must be expressible before every member has an account; `user_id` is filled in when one exists.
- `mcp_confirmations` stores a hash of the exact normalised request (`request_hash`) alongside `params_json`, plus `status` and `expires_at`. That binding is the whole point: without it a model could obtain consent for one audience and execute another.
- `integration_grants` records `client_name` / `client_version`, reported by the client during `initialize` and written onto every artifact the connection produces.
- Tag and team reads never widen access: search indexes **CONFIRMED tags only**, and a team share is bounded by its `organization_id` at evaluation time.

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
11. **Let the AI work in jobs, not primitives** — once connected, an agent can *find* (`search`), *save*
    (`save` / `create_version`) and *share* (`share`). A share that reaches outside your organization
    returns a **confirmation request** and shares nothing until you agree; an internal team or
    workspace share just happens. Every artifact it saves is auto-tagged, and you get to accept,
    reject or add tags yourself.
12. **Reusable audiences** — keep a team ("Board prep") instead of retyping addresses. If a name
    matches more than one team you will be asked which one, never guessed at.

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
| **Custom domain** | `artifactry.app` — active | `preview.artifactry.app` — active |
| **Live hostname** | https://artifact-library.pages.dev | https://artifactry-preview.pages.dev |
| **Build** | `vite build` → `dist/` (226.62 kB, gzip 65.34 kB) | `vite build -c vite.preview.config.ts` → `dist-preview/` (33.63 kB, gzip 12.83 kB) |
| **Bindings** | D1 `DB`, R2 `R2`, Vectorize, Workers AI | D1 `DB`, R2 `R2` (**no** Vectorize/AI) |
| **Origin vars** | `APP_ORIGIN`, `PREVIEW_ORIGIN`, `APP_NAME`, `EMAIL_FROM`, `MAX_UPLOAD_BYTES` | `APP_ORIGIN`, `PREVIEW_ORIGIN` |
| **Secrets** | `EMAIL_API_KEY`, `PREVIEW_TOKEN_SECRET` | `PREVIEW_TOKEN_SECRET` |

- **Platform**: Cloudflare Pages (BYOK — the user's own account via API token)
- **Compatibility date**: 2026-09-17
- **Status**: ✅ **Both surfaces live** on their `pages.dev` hostnames **and** on their custom domains

**Git-connected builds.** `artifact-library` is connected to this GitHub repo, so a push to `main`
builds and deploys automatically. The project was originally created with an **empty
`build_command`**, which made every push fail at the build stage — with no build step, Cloudflare
published `destination_dir: dist`, and `dist/` is gitignored build output that is not in the
repository. The setting is now `npm run build` / `dist`, and a GitHub-triggered build has been
verified end to end (build **and** deploy `success`). Direct `wrangler pages deploy` was unaffected
throughout, because it uploads an already-built `dist/` from the sandbox — which is why production
stayed healthy while the push builds failed.

`artifactry-preview` is **not** git-connected (it is deployed only by `npm run deploy:preview`).
That is deliberate: the preview surface is a purpose-built minimal Worker, and letting the default
build settings publish a repo root would risk serving the application shell from the isolated
hostname. A push therefore never deploys the preview surface.

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

### Custom domains — completed

Both custom domains are attached and **active**; no manual DNS step remains.

**What the `525` was.** `artifactry.app` was returning **`525` (SSL handshake failed)** because the
apex carried two **proxied `A` records pointing at GoDaddy parking IPs**
(`15.197.148.33`, `3.33.130.190`) — leftovers from domain registration. A Pages custom domain
validates against a **`CNAME`**, so the parking `A` records had to be **removed**, not joined to.
That was the whole blocker.

**What was done** (single scripted pass, via the Cloudflare REST API with **Zone → DNS → Edit** on
`artifactry.app` only):

1. Backed up **all 9** zone records to `.diag/dns-backup-artifactry.app.json` before touching anything.
2. Deleted the two apex `A` records (`15.197.148.33`, `3.33.130.190`).
3. Created both Pages `CNAME`s, **proxied**, TTL auto:

   | Type | Name | Content | Proxy |
   |---|---|---|---|
   | `CNAME` | `artifactry.app` (apex) | `artifact-library.pages.dev` | Proxied |
   | `CNAME` | `preview` | `artifactry-preview.pages.dev` | Proxied |

4. Polled Pages domain status until both reported `status: active`.

Cloudflare-managed TLS covers both hostnames; no certificate was issued by hand. An apex `CNAME` is
legal here — Cloudflare flattens it at the zone apex, and it coexists with the pre-existing apex `MX`.
The script that performed this is `.diag/point-domains.py`, which is **gitignored**: it is a one-shot
operator tool for a change that only ever needs to happen once, not part of the deploy path.

**Mail records preserved.** Nothing in the mail path was modified: apex `MX` (pre-existing AWS
inbound), `_dmarc`, `resend._domainkey`, `send`, `rsend`, `_domainconnect` and `www` all remain.
The apex `MX` is **not** Artifactry mail — Artifactry sends through Resend. It is flagged in
*Known limitations* in case it is a stale mailbox you no longer want.

**Verification.** After propagation, all four checks pass against the real domains:

```
https://artifactry.app/                 -> 200
https://artifactry.app/api/health       -> 200
https://preview.artifactry.app/api/health -> 200
https://preview.artifactry.app/         -> 404   (no app shell served)
```

The preview custom domain serves **no SPA shell on any path** — that is the design, not a fault.

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

> **Sender.** `EMAIL_FROM` is set in `wrangler.jsonc` to `Artifactry <no-reply@artifactry.app>`,
> and the code's own fallback uses the same address. Sending from `artifactry.app` requires the
> domain to be verified in Resend (DKIM at `resend._domainkey`, SPF via the `rsend`/`send`
> CNAMEs); production sign-in delivery was exercised during release validation. If the domain is
> ever *not* verified, Resend rejects the send with `403` and the API surfaces
> `400 Could not send email. Please try again shortly.` — an unverified-domain sender also
> restricts delivery to the account owner's address.
>
> **To change the sender:** verify the domain at https://resend.com/domains (add the DNS
> records), then set `EMAIL_FROM` in `wrangler.jsonc` and redeploy. It is a build-time var, not
> a runtime secret, so editing it alone does nothing. Separately, note that without an email key
> `DEV_LOGIN_MODE` is the only working sign-in path.

**Directory-review sign-in.** Connector directory reviewers can't read our inbox, so one
address can sign in with a fixed code and no email is sent: set `REVIEWER_EMAIL` (plain var) and
`REVIEWER_CODE` (secret, exactly 8 digits) on the Pages project and redeploy. Anything else, or
either one unset, leaves it off. The account is an ordinary user with only its own personal
workspace. Remove `REVIEWER_CODE` after the reviews to switch it off.

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

### Workspace management

The **Workspace** item at the bottom of the desktop rail (on phones: **Profile → Workspace settings**)
opens `/workspace/:id`, one screen per workspace. There are two kinds:

- **Personal**: one person, its owner. Identity, Regional and Invitation controls.
- **Shared**: a team. Everything below. Stored as `workspace_type = 'ORGANIZATION'` with an
  organization of its own (the UI calls these "shared").

The first invitation (email or link) from a personal workspace converts it to shared. The app asks its
owner to confirm first, warning that plans will be priced by number of workspaces; the server refuses with
`409 CONVERT_TO_SHARED` unless the request carries `convertToShared: true`. Conversion creates an
organization named after the workspace with the owner as `ORG_OWNER`, and moves the workspace's artifacts,
collections, shares and embedding rows into it. Members can't be added to a personal workspace directly.


- **Identity**: name, description and a logo.
- **Custom URL**: the share-link domain for every artifact in this workspace (below).
- **Regional**: time zone and date format; every date in the app follows the workspace being viewed.
- **Team directory**: active members, people awaiting approval, open invitations, deactivated people.
  Deactivating someone also removes the read-only view plain organization members otherwise get.
- **Roles & permissions**: built-in tiers Owner, Admin, Member, Guest (stored as `WORKSPACE_ADMIN`,
  `CONTRIBUTOR`, `VIEWER`) plus custom tiers that pick from the artifact, share, analytics and team
  permissions. Managing settings and people always stays with Admins.
- **Invitation controls**: email invitations (sent through Resend when `EMAIL_API_KEY` is set; otherwise
  the link is shown to copy), invite links with a use limit and expiry (never Admin), allowed email
  domains, admin approval for new joiners, and the default tier. Links open `/join/:token`; only a hash of
  each token is stored.

Profile pictures (Profile → tap the picture) and workspace logos accept any PNG, JPEG, WebP or GIF up to
1 MB, whatever the shape; the app crops them to a circle.
Code: `src/routes/workspacemanage.ts`, `src/lib/workspacesettings.ts`, `src/lib/images.ts`,
`public/static/workspace.js`; schema in `migrations/0009_workspace_management.sql`; tests in
`scripts/test-workspace-manage.mjs`.

### Custom share domains — built, needs one-time setup

An admin of a shared workspace can put that workspace's share links on their own hostname
(**Workspace → Custom URL**), e.g. `share.acme.com` instead of `artifactry.app`. It applies to every
artifact in that workspace; artifacts that should keep standard links go in another workspace. The
customer adds a `CNAME` to `shares.artifactry.app` and a `TXT` at `_artifactry-challenge.<host>`;
**Check now** verifies the TXT, registers the hostname with Cloudflare for SaaS, and switches new
links over once the certificate is active. Old links keep working on `artifactry.app`.

Only the recipient surface exists on a customer hostname (`/s/*`, the recipient share APIs, `/guide`);
sign-in, the library and every other API are `404` there, no session is ever resolved, and only that
workspace's shares open. Code: `src/lib/sharedomains.ts`, `src/routes/sharedomains.ts`,
`shareDomainGate` in `src/middleware.ts`, `src/share-edge-worker.ts`.

The feature stays **off** until all of this is done (the Custom URL card says so until then):

1. Apply migrations `0008` and `0009` (`npm run db:migrate:prod`).
2. On the `artifactry.app` zone: enable **SSL/TLS → Custom Hostnames** (Cloudflare for SaaS), add an
   originless proxied record `shares.artifactry.app AAAA 100::`, and set it as the **Fallback Origin**.
3. Secrets on the Pages project `artifact-library`: `SHARE_EDGE_SECRET` (random, 32+ chars),
   `CF_API_TOKEN` (Zone → SSL and Certificates → Edit, this zone only), `CF_ZONE_ID`.
4. Deploy the share-edge Worker: `npx wrangler secret put SHARE_EDGE_SECRET -c wrangler.share-edge.jsonc`
   (same value), then `npm run deploy:share-edge`. Pages cannot be the origin of a custom hostname,
   so this Worker (route `*/*` on the zone, passing `artifactry.app` and `preview.artifactry.app`
   straight through) forwards customer traffic to the app with the hostname, visitor IP and secret.

Not included: the workspace logo on the recipient page (it still shows the Artifactry lockup), apex
domains (customers need a subdomain they can `CNAME`), and a background job to re-check pending
domains (an admin presses **Check now**).

---

## Brand

Identity is the official Artifactry **"Spark Fold"** kit (v1.0): an Ink document tile with a URL
slash cut through it, whose folded corner lifts off as a Volt spark — the tile is the artifact,
the slash is the permalink, the spark is the AI moment. Assets are vendored under
`public/static/brand/` and served at `/static/brand/*`, an ordinary static-asset path that
`_routes.json` already excludes, so icons are served by Pages and never reach the Worker.

| Token | HEX | Use |
|---|---|---|
| Ink | `#12151C` | tile, wordmark, body text |
| Volt Deep | `#4E7A00` | **primary interactive accent** — buttons, links, focus rings, selected controls |
| Volt | `#B8F23A` | brand highlight only; 1.33:1 on white, so never text on a light surface |
| Paper | `#F5F6F2` | light background |

`--accent` is **Volt Deep**, not Volt: Volt cannot carry text or primary UI meaning on white
(1.33:1), while Volt Deep reaches 5.11:1 on white and 4.71:1 on Paper. Volt survives only as a
highlight and inside the mark itself. The logo is never redrawn — `brandMark(size)` in
`public/static/ui.js` inlines the kit's two official cuts and switches to the small-size cut
below 32 px as the kit mandates; the sign-in screen uses the kit's outlined horizontal lockup.
Palette values are mirrored in the Tailwind `extend` block in `renderer.tsx`, while the CSS
custom properties on `:root` remain the single source of truth.

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

All eleven must pass before a deploy. `scripts/run-gates.sh` runs them strictly sequentially under a
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
| `test-mcp-jobs` | 89 assertions over the MCP job surface, teams, tag states and the confirmation gate |
| `test-tag-decisions` | 41 assertions over tag decisions on both the REST and MCP surfaces |
| `test-oauth` | 83 assertions: the full connector OAuth flow through the real app bundle, the MCP transport, and every `save` source |
| `test-share-domains` | 93 assertions: custom share domain admin flow, link issuing, what a customer hostname may serve, preview framing, and the share-edge Worker |
| `test-media` | 39 assertions: audio (20 MB) and video (200 MB) limits, parted uploads into R2 multipart, signature checks, ranged playback delivery |

`scripts/check-undefined.mjs` exists because a bundle that builds clean can still reference a symbol
that was never imported — that caused three separate `500`s in the preview path, and the gate caught
a fourth the moment it was introduced.

`test-mcp-jobs` is headless (no browser, so it needs no probe account) and builds its schema by
**replaying the real migration files** into `node:sqlite`. A hand-written fixture schema would be a
second source of truth, and the first thing to drift would be exactly the columns these features
depend on. It is the gate that caught both tag-policy defects described above.

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

---

## Known issues & follow-ups

Recorded during production validation of release `7eb4eaa` (2026-09-30). None of
these block the release.

### Operational

1. **`scripts/run-gates.sh` is not self-contained.** The browser suites
   (`test-preview-security`, `test-preview-ui`) require the app on :3000 and the
   isolated preview worker on :3001 to be already running, and the runner never
   starts or verifies them. A cold run therefore reports two failures that look
   exactly like product regressions (`ECONNREFUSED ::1:3000`). It should start
   both surfaces itself, wait for readiness, and tear them down.

2. **GitHub auth setup reports success without verifying credentials.**
   `setup_github_environment` reported success while `~/.git-credentials` was
   empty (0 lines), so `git push` failed with "Invalid username or token".
   Running `gh auth setup-git` was the actual fix. Setup should assert that a
   resolvable credential exists before claiming success.

3. **`artifact-library` auto-deploys production on every push to `main`.**
   The project has a GitHub source connected
   (`source.type = "github"`, `production_branch = "main"`,
   `production_deployments_enabled = true`, `path_includes = ["*"]`), read back
   from the Pages project API. `artifactry-preview` has `source: null` and does
   **not** auto-deploy.

   Consequence: a docs-only commit re-deploys production. Pushing the release
   notes produced a new production deployment with no `wrangler pages deploy`
   command. It was verified harmless in this case — `README.md` is not a build
   input, and the rebuilt worker at the new commit hashes byte-identically to
   the previously validated build (`sha256 b9002824…`), as does the shipped
   `static/app.js` (`sha256 c1405baf…`) across both deployments. But the same
   path would silently ship an unreviewed code change, and would also fire
   during a window when the working tree is mid-edit.

   If deliberate control is wanted, either narrow `path_includes` so docs
   changes cannot trigger a build, or set
   `production_deployments_enabled = false` and deploy explicitly.

### Product

4. **Fixed (OAuth connector PR):** ~~MCP `search` and `get` emit a `null` origin in canonical URLs.~~
   The dispatcher now passes its `origin` to `search`, `get` and `create_version`;
   `test-oauth` asserts the absolute URL on all three.
   Original report:
   `toolSearch` and `toolGet` (src/lib/mcp-jobs.ts) interpolate a bare `origin`
   that is neither a parameter nor a local in those functions; the dispatcher
   passes `origin` only to `save` and `share`. Production output is
   `null/a/art_…` instead of `https://artifactry.app/a/art_…`.
   Present at baseline `49cbeb5` (same interpolations, same dispatcher), so it
   is **not** a regression from this release. Cosmetic for clients:
   `structuredContent.artifact_id` is correct.

   Mechanism, established by direct experiment rather than inference: under
   Node a bare `origin` throws `ReferenceError`, but under workerd — the runtime
   that actually serves the app — `origin` exists on `globalThis` as a
   non-writable string whose value is literally `'null'` (measured in a scratch
   Worker: `Object.getOwnPropertyDescriptor(globalThis, 'origin')` →
   `{ value: 'null', writable: false, configurable: true, no getter }`). It does
   not vary with the request's `Origin` header, and `${null}` stringifies to
   `'null'`. That is why the defect renders silently instead of throwing.

   Why each guard missed it:
   - `scripts/check-undefined.mjs` structurally cannot flag it: its loop
     iterates only `projectSymbols` — names exported by some file in `src/` or
     `public/` — and no module exports `origin`, so the name is never examined.
   - The Node test suites never reach it: no test calls `tools/call` with
     `search` or `get`, and no test asserts `canonical_url`.
   - No typecheck runs (TypeScript is not installed here), so whether one would
     have caught it is **not established**.

   Fix: thread the dispatcher's own `origin` argument into `toolSearch` /
   `toolGet`, as it already is for `save` / `share`. Do *not* copy
   `toolCreateVersion`'s `originOf(args) ?? ''` — that helper derives the origin
   from the caller-supplied `artifact` / `artifact_url` argument, which `search`
   does not take, so it would yield nothing there.

5. **`TAG_ACCEPT` / `TAG_REJECT` audit rows lack workspace/organization context.**
   `decideTag` writes those events without `workspace_id` / `organization_id`,
   while `TAG_ADD` / `TAG_REMOVE` (written by `applyTagDecisions`) include them.
   The events are written and correct in actor and target, but an audit query
   scoped by workspace will not surface tag decisions.
