# Artifact Library

A mobile-first, multi-tenant **AI-Native Artifact Library SaaS** built entirely on Cloudflare
Pages + Workers. It gives a person or a team one governed library for the files they and their
AI tools create: permanent artifact links, versions, tags, collections, search, sharing, usage
analytics, an audit trail, and a scoped MCP endpoint that ChatGPT / Claude / Gemini can call.

Everything is edge-native: D1 for metadata and RBAC, R2 for binaries, FTS5 for lexical search.
There is no server process and no filesystem.

---

## URLs

| | |
|---|---|
| **Production (Cloudflare Pages)** | https://artifact-library.pages.dev — live (BYOK, user's own account) |
| **Canonical artifact URL** | `/a/:artifactId` — permanent identity, survives renames, re-versioning and moves |
| **Share link** | `/s/:token` — external recipient surface |
| **Health** | `/api/health` |
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

**Search**
- **D1 FTS5** index (`artifact_search`, `porter unicode61`) with `rowid` bound to `artifacts.seq`, ranked by `bm25(...)`
- Query building strips FTS5 syntax characters and prefix-matches; a safe OR fallback
- ACL-bounded filters and facets, recent searches, typeahead suggestions
- **`SemanticProvider` seam** — semantic ranking is a pluggable interface with an `unavailableSemantic` default; see the gap note below

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

**Mobile-first UI** (PRD §71–§93)
- Locked **430px** shell even on desktop, global `overflow-x-hidden`, safe-area padding
- 44–48px touch targets, thumb-zone sticky actions, 5-slot bottom navigation with an emphasised centre Add
- **Bottom sheets instead of modals**, with focus move/restore, Escape dismissal, and reduced-motion respect
- Cards, never wide tables; `text-2xl` maximum screen title; usable from 320px
- Every dynamic value passes through `esc()`; `safeUrl()` gates href/src

### Not implemented (and why)

These are honest capability gaps, not omissions:

| Gap | Reason |
|---|---|
| **Searchable document text** | PDF, DOCX, PPTX and HTML are parsed in-Worker (`DecompressionStream` + hand-rolled OOXML/PDF readers), stored on `artifact_versions.extracted_text` and indexed into FTS5. Per-format job status is `DONE` / `PARTIAL` / `SKIPPED` / `FAILED` with a human-readable note and a `via` provenance string. |
| **Semantic / vector search** | Requires Vectorize + Workers AI bindings. The `SemanticProvider` interface is in place; `unavailableSemantic` is the default and search reports `semantic: false` with a reason instead of pretending. |
| **Extraction is best-effort by design** | PDF, DOCX, PPTX and HTML text **are** extracted (pure web-platform parsers, no Node deps). Formats we have no parser for (images, archives) and documents with no recoverable text (scanned/image-only PDFs) report `SKIPPED` / `PARTIAL` respectively with an explicit note — never a silent failure or a fake success. |
| **DOCX / PPTX generation** | Refused with `ConversionUnsupported` and an actionable message. Content can be rendered to **PDF and HTML** only. |
| **Presigned R2 uploads** | Need dedicated S3 credentials. Uploads are worker-proxied instead. |
| **Cron / scheduled jobs** | Not available on Pages. Expired sessions and OTPs are pruned opportunistically on the login path. |
| **Custom domain for HTML preview** | The account has no zones. HTML preview isolation is instead an **opaque-origin sandboxed iframe** (`sandbox="allow-scripts"`, no `allow-same-origin`) plus a nonce CSP with `default-src 'none'`, `connect-src 'none'`, `frame-src 'none'`, `frame-ancestors 'self'`. |
| **Email to arbitrary recipients** | Resend is configured (`EMAIL_API_KEY` set, dev-code mode off), but the Resend account has **no verified sending domain**. With the shared test sender, Resend delivers **only to the address that owns the Resend account**. Verify a domain and set `EMAIL_FROM` to an address on it to open delivery to all recipients. Non-deliverable addresses fail loudly (`400`) rather than silently. |

---

## Data architecture

**Storage services**
- **Cloudflare D1** — 27 tables: `users`, `auth_sessions`, `auth_otp`, `organizations`, `organization_members`, `workspaces`, `workspace_members`, `artifacts`, `artifact_versions`, `tags`, `artifact_tags`, `collections`, `collection_artifacts`, `shares`, `share_recipients`, `share_access_grants`, `integrations`, `integration_grants`, `artifact_events`, `artifact_daily_metrics`, `artifact_viewer_keys`, `audit_events`, `processing_jobs`, `search_history`, `artifact_favorites`, `artifact_embeddings`, `app_kv` + the `artifact_search` FTS5 virtual table
- **Cloudflare R2** — artifact binaries under immutable per-version keys
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

- **Platform**: Cloudflare Pages (BYOK — the user's own account via API token)
- **Build**: `vite build` → `dist/` (Worker ~176 kB, ~50 kB gzip)
- **Compatibility date**: 2026-09-17
- **Pages project**: `artifact-library` (production branch `main`)
- **Status**: ✅ **Live** at https://artifact-library.pages.dev

Redeploy with:

```bash
npx wrangler d1 migrations apply artifact-library-production --remote  # if new migrations
npm run deploy:prod
```

**Resource bindings** (must exist on the account before deploying):

| Binding | Type | Name |
|---|---|---|
| `DB` | D1 | `artifact-library-production` |
| `R2` | R2 bucket | `artifact-library-bucket` |

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

**Last updated**: 2026-09-27
