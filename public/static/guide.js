/**
 * User guide.
 *
 * A self-contained, searchable reference for the whole application. Content is
 * authored here as static trusted markup (never interpolated with user data),
 * and a plain-text projection of the same content powers the in-page search, so
 * the index can never drift from what is displayed.
 *
 * Reachable from the footer on every screen, and from Profile → Help & guide.
 */

import { esc, icon, screenHeader } from './ui.js'

// ---------------------------------------------------------------
// Content
// ---------------------------------------------------------------

const S = (id, title, tags, html) => ({ id, title, tags, html })

export const GUIDE_SECTIONS = [
  S(
    'getting-started',
    'Getting started',
    'sign in login email code otp passwordless account first time workspace personal',
    `
    <p>Artifactry is a private library for everything you and your AI tools create. There are no passwords — you sign in with a short code sent to your email.</p>
    <ol>
      <li>Enter your email address and choose <strong>Send code</strong>.</li>
      <li>Open the email and type the 6-digit code on the next screen.</li>
      <li>You are signed in. A personal workspace is created automatically the first time.</li>
    </ol>
    <p>Codes expire after 10 minutes and can only be used once. If you did not get one, you can request a new code after a short cooldown.</p>
    <div class="guide-note">
      <strong>Sessions last 30 days.</strong> Signing out ends your session on this device immediately.
    </div>`
  ),

  S(
    'uploading',
    'Uploading artifacts',
    'upload add file formats pdf docx pptx html png jpg markdown md txt csv json code size limit 25mb checksum scan',
    `
    <p>An artifact is a single file plus everything the library knows about it: who owns it, its tags, its versions, and its usage history.</p>
    <p><strong>Supported types:</strong> PDF, DOCX, PPTX, HTML, PNG, JPG, JPEG, BMP, GIF and WEBP, plus notes, data and code as plain text: Markdown, TXT, CSV, JSON, YAML and common source files (JS, TS, Python, Go, Rust, Java, SQL and more).</p>
    <p><strong>Size limit:</strong> 25 MB per file (10 MB for text and code files).</p>
    <div class="guide-note">
      <strong>New HTML artifacts start with Interactive Preview on: JavaScript runs in an isolated, credential-free sandbox with network access blocked by default. You can turn it off when you upload, or later on the artifact page, to use Safe Preview, where HTML and CSS render but JavaScript does not execute.</strong>
      Safe Preview is served from the library's own address, and the page cannot read your session or reach the library's APIs. Interactive Preview is opt-in per artifact, runs on a separate origin so it holds no cookies and cannot touch library storage, and every change to the setting is recorded in the audit trail.
    </div>
    <p>When you upload, the library:</p>
    <ul>
      <li>verifies the file's real type against its contents, not just its name;</li>
      <li>computes a checksum so you can prove the file never changed;</li>
      <li>scans it and records a verdict;</li>
      <li>extracts the text it can read, so the file becomes searchable by its contents;</li>
      <li>adds it to the search index.</li>
    </ul>
    <p>Each of those steps is recorded on the artifact, so you can always see what happened. If a step was skipped, the reason is shown rather than hidden.</p>`
  ),

  S(
    'library',
    'Browsing your library',
    'library home cards grid filter sort type workspace switcher recent newest title personal shared invite',
    `
    <p>The <strong>Library</strong> tab lists what you can access, newest first by default.</p>
    <p>You can narrow the list by <strong>type</strong> (document, presentation, image, web) and change the sort order to updated date, created date or title.</p>
    <p>The switcher at the top of the Home screen moves between your workspaces. Each workspace keeps its own artifacts, tags and members, so switching never mixes two projects together.</p>
    <p>To start another workspace, choose <strong>New workspace</strong> at the bottom of the switcher or on your Profile. Organization owners and admins can create a workspace for the organization from the Administration page. You become the new workspace's admin and decide who else joins.</p>
    <p>There are two kinds of workspace. A <strong>personal</strong> workspace is just you. A <strong>shared</strong> workspace has a team, with a team directory, roles and an optional custom URL. In both, admins set the name, logo, time zone and date format, and can invite people. The first invitation you send from a personal workspace asks you to confirm that it becomes a shared workspace. Plans will be priced by the number of workspaces, personal and shared, so that change may affect what you pay in future.</p>
    <p>Anything you cannot access is not merely hidden from view — it is excluded from the results themselves, so it cannot leak through counts, titles or suggestions.</p>`
  ),

  S(
    'search',
    'Searching',
    'search query keyword full text fts lexical semantic vectorize filters recent history',
    `
    <p>Search looks across titles, filenames, descriptions, tags and the <strong>extracted text inside your files</strong>.</p>
    <p>Type at least two characters. Results are ranked by relevance, and each result tells you how it matched.</p>
    <p>You can filter results by workspace, type, tag, owner and date. Your recent searches are stored per user, so they are never visible to anyone else.</p>
    <div class="guide-note">
      <strong>About "semantic" search.</strong> Search currently uses keyword (lexical) matching. The keyword index is listed as active in the search response; the semantic engine reports itself as unavailable until the vector index is provisioned on the account. The app never presents keyword results as if they were semantic — the engine block in each search response tells you exactly which engines ran.
    </div>`
  ),

  S(
    'extraction',
    'What is searchable inside your files',
    'extract text inside pdf docx pptx html ocr scanned images partial skipped metadata searchable',
    `
    <p>Files are more useful when you can search their contents, not just their names. The library reads text out of documents as they are uploaded:</p>
    <ul>
      <li><strong>HTML</strong> — visible text, with scripts and styling removed.</li>
      <li><strong>PDF</strong> — the text layer, including compressed content streams.</li>
      <li><strong>DOCX</strong> — body text, preserving line breaks and tabs so words do not run together.</li>
      <li><strong>PPTX</strong> — the text on each slide, plus speaker notes, labelled by slide number.</li>
    </ul>
    <p>Every artifact records an extraction outcome:</p>
    <ul>
      <li><strong>DONE</strong> — text was extracted and is searchable.</li>
      <li><strong>PARTIAL</strong> — the file was read successfully but contained no usable text. This is normal for scanned or image-only PDFs, which are pictures of text.</li>
      <li><strong>SKIPPED</strong> — this file type carries no text to extract, such as a PNG or JPG.</li>
    </ul>
    <p>Whatever the outcome, an artifact is always findable by its <strong>title, filename, description, tags, owner and dates</strong>. A scanned PDF is still perfectly findable — just by its metadata rather than its words.</p>`
  ),

  S(
    'tags',
    'Tags',
    'tag taxonomy suggested confirmed rejected ai automatic auto-tag accept reject personal organization duplicate case sensitive',
    `
    <p><strong>Tags are suggested for you automatically.</strong> Every time you upload, save or reprocess an artifact, the library reads its content and metadata and proposes a small set of tags — normally three to seven. They appear as <strong>suggested</strong> until you act on them.</p>
    <p><strong>You decide.</strong> For each suggestion you can <strong>accept</strong> it or <strong>delete (reject)</strong> it, and you can add your own tags at any time. Accepting and adding produce a <strong>confirmed</strong> tag; rejecting records the decision so the same tag is not offered to you again unless the document actually changes. A new version is a new basis, so a tag you rejected on the old content may be offered again on the new one.</p>
    <p><strong>Only confirmed tags are searchable.</strong> A suggestion the machine made is not yet part of the library's vocabulary, so it will not change what a search can find until you confirm it.</p>
    <p><strong>You can create tags.</strong> Earlier versions of the library limited new tags to administrators; that rule is gone. An organization can still keep an administrator-managed set of canonical tags, and can switch user-created tags off entirely — but if it does, you can still apply the tags that already exist.</p>
    <p>Names are matched case-insensitively, so "AI", "ai" and "Ai" are the same tag rather than three near-duplicates. Tag management lives in <strong>Profile → Tag management</strong>.</p>`
  ),

  S(
    'teams',
    'Teams and shared audiences',
    'team group audience board prep members reusable share address ai agent',
    `
    <p>A <strong>team</strong> is a reusable named audience — "Board prep", "Finance reviews" — that you can share with by name instead of typing addresses every time.</p>
    <p>A team can be scoped to a whole organization or to a single workspace, and it has members, an owner, and an active or inactive state. You can add and remove members at any time.</p>
    <p><strong>Membership stays live.</strong> When you share with a team, the people on it at that moment are recorded on the share, <em>and</em> someone added to the team later also gets access — without you re-issuing the link. Removing someone withdraws it.</p>
    <p><strong>Ambiguous names are never guessed.</strong> If two teams you belong to share a name, the library asks you which one rather than picking. Sharing a confidential document is not a place for a coin flip.</p>
    <p>A team only works within its own organization: it cannot be used for an artifact in a personal workspace or in a different organization, and a team with no active members has nobody to share with.</p>`
  ),

  S(
    'ai-agents',
    'Connecting an AI agent (MCP)',
    'mcp ai agent chatgpt claude gemini connector token scope search save share find confirmation prompt tool',
    `
    <p>You can connect an AI application to your library so it can work with your artifacts directly. Most apps sign in with OAuth: you approve, and can untick, what they may do. For anything that can't, create an access token in <strong>Profile → Access tokens</strong> with the least privilege it needs. <strong>The token is shown once.</strong></p>
    <p>The agent works in three jobs rather than low-level operations:</p>
    <ul>
      <li><strong>Find</strong> — search by natural language, with filters for workspace, type, tags, collection, owner and date range.</li>
      <li><strong>Save</strong> — store what it produced, as a new artifact or a new version of an existing one.</li>
      <li><strong>Share</strong> — put it in front of an audience: a team, a workspace, specific people, an email domain, or a public link, with an optional expiry and view-only or download permission.</li>
    </ul>
    <p>An agent can only ever see and do what you can. Its permissions are never wider than your own, and every call is recorded with the AI application's name, the operation, the artifact and the time.</p>
    <div class="guide-note">
      <strong>Sharing beyond your organization needs your explicit confirmation.</strong> If the agent tries to create a public link, or share with individual addresses or an email domain, it cannot proceed on its own: it must ask, and <em>nothing is shared until you agree</em>. The confirmation is tied to that exact request, so an approval for one audience cannot be reused for a different one, and it expires. Sharing with a team or workspace inside your organization proceeds without a prompt.
    </div>`
  ),

  S(
    'collections',
    'Collections',
    'collection group bundle share collection of artifacts',
    `
    <p>Collections group related artifacts into a single shareable unit — a pitch deck with its supporting documents, for example. An artifact is in one collection at a time; moving it to another takes it out of the first.</p>
    <p>In the Library, choose <strong>Select</strong> to pick several artifacts and move them to a collection together, or (for workspace Owners and Admins) delete them permanently after a confirmation. While a collection is open, <strong>Upload files</strong> adds many files to it at once, each named after its file and tagged automatically.</p>
    <p>A collection can be shared the same way a single artifact can, and it can be set to include items you add later.</p>
    <p>Deleting a collection never deletes the artifacts inside it; it only removes the grouping.</p>`
  ),

  S(
    'sharing',
    'Sharing with others',
    'share link public email domain restrict expiry revoke download recipient incognito external',
    `
    <p>Nothing is shared by default. When you do share, you choose <strong>who</strong> and <strong>what they may do</strong>.</p>
    <p><strong>Three access types:</strong></p>
    <ul>
      <li><strong>Anyone with the link</strong> — no sign-in required. Useful for sending something to someone outside your organization.</li>
      <li><strong>Specific email addresses</strong> — the recipient proves control of the address by entering a code before they can open the item.</li>
      <li><strong>Anyone with a domain</strong> — restricted to people with an address on an approved domain.</li>
    </ul>
    <p><strong>You also control:</strong></p>
    <ul>
      <li><strong>Expiry</strong> — after which the share stops working automatically.</li>
      <li><strong>Downloading</strong> — viewing can be allowed while downloading is not.</li>
      <li><strong>Revoking</strong> — ends the share immediately, even if someone already opened it.</li>
    </ul>
    <p>Recipients see only the item you shared. They do not see your workspaces, tags, members, analytics or any navigation into the rest of the library.</p>
    <div class="guide-note">
      <strong>How it stays secure:</strong> the link's token is stored only as a hash, so it cannot be recovered from the database. For email shares, typing an address is never enough — access is granted only after the code is redeemed against the address actually entitled to it.
    </div>`
  ),

  S(
    'versions',
    'Versions',
    'version history restore revert replace file new version change summary immutable',
    `
    <p>Uploading a new file to an existing artifact creates a <strong>version</strong> instead of a new artifact.</p>
    <p>Every version keeps its own file, checksum, size and extraction result. Older versions stay downloadable, and you can restore one to make it current again.</p>
    <p>An artifact's identity and its link never change, no matter how many versions it has, what it is renamed to, or which workspace it lives in. Links you shared months ago keep working.</p>`
  ),

  S(
    'analytics',
    'Usage analytics',
    'analytics views unique viewers downloads channels internal public link email ai daily rollup',
    `
    <p>Each artifact has an analytics view showing how it is actually being used:</p>
    <ul>
      <li><strong>Views</strong> — each time it was opened.</li>
      <li><strong>Unique viewers</strong> — counted with a daily-rotating privacy-safe key, so one person refreshing the page counts once, without fingerprinting anyone.</li>
      <li><strong>Downloads</strong> — counted separately from views.</li>
      <li><strong>Where it was seen</strong> — internal, public link, email share, domain share, or an AI app.</li>
    </ul>
    <p>Counters are rolled up per day, so long histories stay fast to read.</p>`
  ),

  S(
    'ai',
    'Connecting AI apps',
    'ai mcp chatgpt claude gemini copilot microsoft connector scope token connect endpoint model context protocol oauth sign in',
    `
    <p>AI applications can search, save and share in your library through <strong>MCP</strong> (Model Context Protocol). Every app uses the same address: <code>https://app.artifactry.app/api/v1/mcp</code>. You sign in to Artifactry and approve what the app may do; no token to copy.</p>
    <p><strong>ChatGPT</strong> (web and desktop, Plus, Pro, Business, Enterprise, Edu):</p>
    <ol>
      <li>Settings → Security and login → turn on <strong>Developer mode</strong>.</li>
      <li>Settings → Apps &amp; Connectors → <strong>Create</strong>. Name it Artifactry, paste the address, choose <strong>OAuth</strong>, and create it.</li>
      <li>Sign in to Artifactry in the window that opens and choose <strong>Allow</strong>.</li>
      <li>In a chat, pick Developer mode → Artifactry, then ask “save this to Artifactry”.</li>
    </ol>
    <p><strong>Claude</strong> (claude.ai, desktop and mobile): Settings → Connectors → <strong>Add custom connector</strong>, paste the address, then <strong>Connect</strong> and approve. On Team and Enterprise plans an owner adds it once for the organization. <strong>Claude Code</strong>: <code>claude mcp add --transport http artifactry https://app.artifactry.app/api/v1/mcp</code>, then <code>/mcp</code> to sign in.</p>
    <p><strong>Microsoft Copilot</strong> (Copilot Studio agents, published to Teams and Microsoft 365 Copilot): in your agent, Tools → Add a tool → <strong>Model Context Protocol</strong>, paste the address, choose <strong>OAuth 2.0 → Dynamic discovery</strong>, create the connection and sign in.</p>
    <p><strong>Gemini Enterprise</strong>: it asks for a client ID and secret, which your Artifactry admin creates for you. Then in Gemini Enterprise add an MCP server with the address, OAuth 2.0, the authorization and token URLs shown, and the client ID and secret. The consumer Gemini app does not support custom connectors yet. <strong>Gemini CLI</strong> signs in with OAuth on its own.</p>
    <p><strong>Saving files:</strong> HTML pages the AI writes are stored exactly as written. Files you upload or the AI generates in ChatGPT are handed over directly. Other apps can pass a public link to the file.</p>
    <p><strong>Permissions are granular.</strong> Each capability is granted separately and enforced on every request, and an app can never do more than you can. Sharing outside your organization always asks you first.</p>
    <p>Long pages and big files are fine: if a file is too large for the app to send in one go, it sends it in parts and Artifactry puts them back together before saving.</p>
    <p>Disconnecting an app in Profile revokes it straight away; the app will ask you to sign in again. Apps that cannot sign in with OAuth (scripts, scheduled agents, CI) use a personal access token from <em>Profile → Access tokens</em>: named, limited to the permissions you tick, shown once and revocable on its own.</p>`
  ),

  S(
    'handoffs',
    'Handing work between AI tools',
    'handoff hand off pick up cursor claude chatgpt gemini lineage built from derived project made by provenance brief',
    `
    <p>A <strong>handoff</strong> is a short brief plus a few artifacts that one AI tool leaves for the next. Claude finishes the research and hands it to Cursor; Cursor builds it and hands the code and spec to Gemini for a deck.</p>
    <ol>
      <li>In the first tool, say “save this to Artifactry and hand it off to Cursor: build the API from this spec”. Or open an artifact here and choose <strong>Hand off to another AI tool</strong>.</li>
      <li>You get a link and a <strong>pickup line</strong>. Copy the line.</li>
      <li>Paste it into the next tool (connected to Artifactry too). It reads the brief and every file in full, and the handoff shows who picked it up.</li>
    </ol>
    <p><strong>Made by.</strong> Every artifact and version shows which tool made it (Made by Claude, Made by Cursor). Search → Filters → Made by narrows results to one tool.</p>
    <p><strong>Built from.</strong> When a tool saves something made from other artifacts, the library records the links, either because the tool named its sources or because it read them through the same connection in the last two hours. Open an artifact to see what it was built from and what it was used in; remove a link that is wrong.</p>
    <p><strong>Projects.</strong> Mark a collection as a project and your AI tools can list it and save into it by name. Handoffs and links follow your access: a tool never sees an artifact you cannot read.</p>
    <p>Set-up steps for each tool are on the <strong>Connect</strong> page (Add → Set up Claude, ChatGPT, Cursor and more).</p>`
  ),

  S(
    'roles',
    'Roles and permissions',
    'roles rbac owner admin member contributor viewer organization workspace permission',
    `
    <p>Access is decided by role. Organization roles are <strong>Owner</strong> and <strong>Admin</strong>; workspace roles are <strong>Workspace admin</strong>, <strong>Contributor</strong> and <strong>Viewer</strong>.</p>
    <p>A Viewer can read and download. A Contributor can also upload and create versions. A Workspace admin can additionally manage members, tags and collections. Organization owners and admins manage the organization and its workspaces.</p>
    <p>Adding someone to a workspace requires that they already have an account. The API will not create an account on someone else's behalf, which is what prevents an invitation from being used to take over an address.</p>`
  ),

  S(
    'security',
    'Security and privacy',
    'security privacy hash token session audit trail private encrypted acl scope no plaintext',
    `
    <p>Your artifacts are private unless you deliberately share them.</p>
    <ul>
      <li><strong>Sign-in codes and session tokens are stored as hashes</strong>, never as readable values.</li>
      <li><strong>Share links and AI tokens are hashed too</strong> — the raw value exists only in the moment it is created or sent.</li>
      <li><strong>Access is part of every query.</strong> What you may read is applied when data is fetched, not filtered afterwards, so nothing can slip through.</li>
      <li><strong>Audit trail.</strong> Significant actions — sharing, access, administrative changes — are recorded.</li>
      <li><strong>HTML previews run sandboxed.</strong> Safe Preview renders HTML and CSS with JavaScript disabled. Interactive Preview runs on a separate origin with no access to your session, no library storage, and network requests blocked by default.</li>
    </ul>`
  ),

  S(
    'accessibility',
    'Mobile use and accessibility',
    'mobile touch target thumb keyboard screen reader reduced motion contrast wcag safe area',
    `
    <p>The interface is designed mobile-first and stays comfortable on a phone as small as 320 px wide.</p>
    <ul>
      <li>Buttons and rows are at least 44 px tall, and primary actions 48 px.</li>
      <li>Primary actions sit within easy reach of your thumb, and the navigation bar respects the home-indicator area.</li>
      <li>Panels open as bottom sheets that can be dismissed with a swipe, the close button, or the Escape key.</li>
      <li>Animations are reduced automatically if your device requests it.</li>
      <li>Text and controls meet WCAG 2.2 AA contrast targets.</li>
    </ul>
    <p>There is no horizontal scrolling, and no wide tables — data is shown as cards that read well on a narrow screen.</p>`
  ),

  S(
    'limits',
    'Known limitations',
    'limitation not supported known issue thumbnail semantic ocr preview email timeline roadmap javascript script sandbox html css interactive',
    `
    <p>These are the current, deliberate limits. They are stated here rather than hidden, and each is visible in the app where it applies.</p>
    <ul>
      <li><strong>HTML has two preview modes.</strong> Interactive Preview is the default for new uploads and runs the uploaded JavaScript inside an isolated, credential-free sandbox on a separate origin, with network access blocked by default. Safe Preview runs no JavaScript; switch to it per artifact, or untick Interactive Preview when you upload.</li>
      <li><strong>Interactive Preview does not support <code>eval</code> or <code>new Function</code>.</strong> Both are blocked, so a script that builds code from strings at run time will not work.</li>
      <li><strong>Interactive Preview has no external network access.</strong> <code>fetch</code>, <code>XMLHttpRequest</code>, WebSocket and beacon requests are all blocked. A page cannot call an API or send data anywhere.</li>
      <li><strong>Libraries loaded from the internet will not work in Interactive Preview.</strong> A CDN script, remote stylesheet or web font is a blocked external resource, so an artifact must carry its HTML, CSS and JavaScript in the file itself. Links may still point outwards, but nothing loads automatically.</li>
      <li><strong>Scanned PDFs have no text to extract.</strong> They are stored and shared normally, and remain searchable by title, filename, description, tags and dates.</li>
      <li><strong>PDF text extraction is best-effort.</strong> Text layers, including compressed content streams and documents that map glyphs to characters through their own font tables, are read. PDFs that encrypt their content, compress the file structure itself, or give no character mapping for their fonts may yield partial text or none — the artifact is still stored, shared and findable by its metadata.</li>
      <li><strong>Thumbnails are not generated.</strong> Files show a type badge instead of a preview image.</li>
      <li><strong>DOCX and PPTX cannot be generated.</strong> Content can be rendered to PDF and HTML; the app refuses the other two rather than returning a degraded file.</li>
    </ul>`
  ),

  S(
    'troubleshooting',
    'Troubleshooting',
    'troubleshoot problem not working error sign in code not received upload failed share not accessible',
    `
    <p><strong>"My sign-in code never arrived."</strong> Check the address for typos, then request a new code after the cooldown. If codes consistently fail to arrive, email delivery may not be fully configured for the deployment — ask the person who runs the service.</p>
    <p><strong>"My upload failed."</strong> The most common causes are a file over 25 MB, or a file whose contents do not match its extension (for example a video renamed to <code>.pdf</code>). Both are rejected deliberately.</p>
    <p><strong>"A share link will not open for someone."</strong> Check whether it has expired or been revoked, and whether the recipient is using the address it was granted to. Email shares only open for the entitled address, after the code is redeemed.</p>
    <p><strong>"I cannot find a file I uploaded."</strong> Confirm you are in the right workspace, and try searching a word you know is in the document. If it is a scanned PDF, search by its title or tags instead — scanned pages have no searchable text.</p>
    <p><strong>"An AI app says it is not authorised."</strong> The token may have been revoked or replaced by a newer connection, or it may lack the specific permission the action needs. Sign it in again, or create a new token in Profile → Access tokens.</p>`
  )
]

// ---------------------------------------------------------------
// Search over the guide
// ---------------------------------------------------------------

/** Plain-text projection of a section, used for matching and snippets. */
function sectionText(section) {
  return section.html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&middot;/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
}

const INDEX = GUIDE_SECTIONS.map((section) => ({
  section,
  title: section.title.toLowerCase(),
  tags: section.tags.toLowerCase(),
  text: sectionText(section),
  lowered: sectionText(section).toLowerCase()
}))

/** Split a query into terms, ignoring very short fragments. */
function terms(query) {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9.-]/g, ''))
    .filter((t) => t.length >= 2)
    .slice(0, 6)
}

/**
 * Rank sections against a query.
 *
 * Every term must appear somewhere (AND), so adding a word narrows rather than
 * widens. Title hits outrank tag hits, which outrank body hits.
 */
function searchGuide(query) {
  const list = terms(query)
  if (!list.length) return []

  const results = []
  for (const entry of INDEX) {
    const haystacks = [entry.title, entry.tags, entry.lowered]
    if (!list.every((t) => haystacks.some((h) => h.includes(t)))) continue

    let score = 0
    for (const t of list) {
      if (entry.title.includes(t)) score += 10
      if (entry.tags.includes(t)) score += 5
      if (entry.lowered.includes(t)) score += 1
    }
    results.push({ ...entry, score })
  }

  return results.sort((a, b) => b.score - a.score || a.section.title.localeCompare(b.section.title))
}

/** A readable excerpt around the first matching term, safe to inject. */
function snippet(text, query, width = 150) {
  const lower = text.toLowerCase()
  let at = -1
  for (const t of terms(query)) {
    const found = lower.indexOf(t)
    if (found >= 0 && (at < 0 || found < at)) at = found
  }
  if (at < 0) at = 0

  const start = Math.max(0, at - 50)
  const slice = text.slice(start, start + width).trim()
  const prefix = start > 0 ? '… ' : ''
  const suffix = start + width < text.length ? ' …' : ''

  let out = esc(prefix + slice + suffix)
  for (const t of terms(query)) {
    if (t.length < 2) continue
    const safe = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`(${safe})`, 'gi'), '<mark>$1</mark>')
  }
  return out
}

// ---------------------------------------------------------------
// Screen
// ---------------------------------------------------------------

export function renderGuide(ctx) {
  const authenticated = !!ctx.state?.session?.authenticated
  const canGoBack = !!ctx.boot?.initialData?.cameFromApp || authenticated

  const toc = GUIDE_SECTIONS.map(
    (s) => `<button class="guide-toc-item" data-guide-jump="${esc(s.id)}">
        <span>${esc(s.title)}</span>${icon('chevron', 14)}
      </button>`
  ).join('')

  const body = GUIDE_SECTIONS.map(
    (s) => `
    <section class="guide-section" id="guide-${esc(s.id)}">
      <h2 class="guide-h2">${esc(s.title)}</h2>
      ${s.html}
      <button class="guide-top" data-guide-top>${icon('chevronUp', 13)} Back to top</button>
    </section>`
  ).join('')

  return {
    html: `
      ${screenHeader({
        title: 'User guide',
        onBackId: canGoBack ? 'guide-back' : undefined,
        subtitle: 'How Artifactry works'
      })}

      <main class="app-main" style="padding-top:10px">
        <div class="guide-search-wrap">
          <label class="sr-only" for="guide-search">Search the guide</label>
          <div class="guide-search">
            ${icon('search', 18)}
            <input id="guide-search" type="search" inputmode="search" autocomplete="off"
              placeholder="Search the guide — e.g. sharing, versions, tags" aria-describedby="guide-search-hint">
            <button id="guide-search-clear" class="guide-clear" aria-label="Clear search" hidden>${icon('x', 16)}</button>
          </div>
          <p id="guide-search-hint" class="guide-hint">Type at least two characters to filter ${GUIDE_SECTIONS.length} topics.</p>
        </div>

        <div id="guide-results" class="guide-results" hidden aria-live="polite"></div>

        <nav id="guide-toc-card" class="card guide-toc" aria-label="Guide contents">
          <h2 class="guide-toc-title">Contents</h2>
          ${toc}
        </nav>

        <div id="guide-body">${body}</div>

        <p class="guide-footer-note">
          This guide covers Artifactry. Where a feature is not available yet, it is listed under
          <button class="guide-inline-link" data-guide-jump="limits">Known limitations</button>.
        </p>
      </main>
      ${authenticated ? ctx.bottomNav('profile') : ''}`,

    mount(root) {
      const input = root.querySelector('#guide-search')
      const clear = root.querySelector('#guide-search-clear')
      const results = root.querySelector('#guide-results')
      const tocCard = root.querySelector('#guide-toc-card')
      const bodyWrap = root.querySelector('#guide-body')
      const hint = root.querySelector('#guide-search-hint')

      const jump = (id) => {
        const target = root.querySelector(`#guide-${id}`)
        if (!target) return
        target.scrollIntoView({ behavior: 'smooth', block: 'start' })
        target.classList.add('guide-flash')
        window.setTimeout(() => target.classList.remove('guide-flash'), 1200)
      }

      const renderResults = (query) => {
        const matches = searchGuide(query)

        if (matches.length) {
          results.hidden = false
          tocCard.hidden = true
          bodyWrap.hidden = true
          hint.textContent = `${matches.length} of ${GUIDE_SECTIONS.length} topics match “${query.trim()}”.`
          results.innerHTML = matches
            .map(
              (m) => `
              <button class="card guide-result" data-guide-jump="${esc(m.section.id)}">
                <span class="guide-result-title">${esc(m.section.title)}</span>
                <span class="guide-result-snippet">${snippet(sectionText(m.section), query)}</span>
              </button>`
            )
            .join('')
        } else {
          results.hidden = false
          tocCard.hidden = true
          bodyWrap.hidden = true
          hint.textContent = `No topics match “${query.trim()}”.`
          results.innerHTML = `
            <div class="card guide-no-results">
              <div class="guide-result-title">No matches</div>
              <p class="guide-result-snippet">
                Try a different word — for example <em>share</em>, <em>version</em>, <em>tag</em> or <em>search</em>.
              </p>
              <button class="btn" id="guide-show-all" style="margin-top:10px">Show all topics</button>
            </div>`
          root.querySelector('#guide-show-all')?.addEventListener('click', () => {
            input.value = ''
            reset()
            input.focus()
          })
        }
      }

      const reset = () => {
        results.hidden = true
        results.innerHTML = ''
        tocCard.hidden = false
        bodyWrap.hidden = false
        hint.textContent = `Type at least two characters to filter ${GUIDE_SECTIONS.length} topics.`
        clear.hidden = true
      }

      let timer = null
      input?.addEventListener('input', () => {
        const value = input.value
        clear.hidden = !value
        window.clearTimeout(timer)
        timer = window.setTimeout(() => {
          if (terms(value).length) renderResults(value)
          else reset()
        }, 180)
      })

      input?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          window.clearTimeout(timer)
          if (terms(input.value).length) renderResults(input.value)
        }
        if (event.key === 'Escape') {
          input.value = ''
          reset()
        }
      })

      clear?.addEventListener('click', () => {
        input.value = ''
        reset()
        input.focus()
      })

      root.querySelector('#guide-back')?.addEventListener('click', () => ctx.goBack())

      // Jump links exist in the TOC, in results and inline in the prose, so the
      // handler is bound by selector rather than per-element.
      root.querySelectorAll('[data-guide-jump]').forEach((button) => {
        button.addEventListener('click', () => {
          const id = button.dataset.guideJump
          if (results.hidden === false) {
            input.value = ''
            reset()
          }
          jump(id)
        })
      })

      root.querySelectorAll('[data-guide-top]').forEach((button) => {
        button.addEventListener('click', () =>
          window.scrollTo({ top: 0, behavior: 'smooth' })
        )
      })
    }
  }
}
