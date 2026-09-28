/**
 * Application entry point.
 *
 * Responsibilities, in order:
 *   1. read the boot payload the shell embedded (route, deep-link ids, auth state)
 *   2. hydrate shared state from the JSON API
 *   3. route to a screen, render it into #app, then run the screen's mount()
 *   4. provide the `ctx` surface every screen module consumes
 *
 * Screens never touch the URL or fetch directly: they read ctx, call ctx.navigate(),
 * and return { html, mount }. That keeps routing, data loading and error handling
 * in one place, and keeps the screens pure enough to reason about in isolation.
 */

import { api, getState, setState } from './api.js'
import {
  esc,
  icon,
  toast,
  sheet,
  closeSheet,
  formatBytes,
  formatDate,
  timeAgo,
  kindLabel,
  extLabel,
  fileBadge,
  emptyState,
  spinner
} from './ui.js'
import {
  renderLogin,
  renderHome,
  renderLibrary,
  renderSearch,
  renderAdd,
  renderProfile,
  renderAdmin,
  renderShareRecipient,
  artifactRow
} from './screens.js'
import {
  renderArtifactDetail,
  renderAnalytics,
  versionsSheet,
  shareCreateSheet,
  shareResultSheet
} from './detail.js'
import { renderGuide } from './guide.js'

// ---------------------------------------------------------------
// Boot payload
// ---------------------------------------------------------------

function readBoot() {
  const node = document.getElementById('boot-data')
  if (!node) return { route: 'home' }
  try {
    return JSON.parse(node.textContent || '{}')
  } catch {
    return { route: 'home' }
  }
}

const boot = readBoot()

// ---------------------------------------------------------------
// Focus preservation
//
// Every re-render replaces #app's innerHTML, which would otherwise drop the
// caret out of the field the user is typing in (search, library filter). We
// snapshot the focused control and restore it after the swap.
// ---------------------------------------------------------------

function captureFocus() {
  const el = document.activeElement
  if (!el || !el.id) return null
  if (!document.getElementById('app')?.contains(el)) return null
  return {
    id: el.id,
    start: typeof el.selectionStart === 'number' ? el.selectionStart : null,
    end: typeof el.selectionEnd === 'number' ? el.selectionEnd : null
  }
}

function restoreFocus(snapshot) {
  if (!snapshot) return
  const el = document.getElementById(snapshot.id)
  if (!el || typeof el.focus !== 'function') return
  el.focus()
  if (snapshot.start !== null && typeof el.setSelectionRange === 'function') {
    try {
      el.setSelectionRange(snapshot.start, snapshot.end ?? snapshot.start)
    } catch {
      /* not a text-selectable input */
    }
  }
}

// ---------------------------------------------------------------
// Routing
// ---------------------------------------------------------------

const SIMPLE_ROUTES = {
  library: 'library',
  search: 'search',
  add: 'add',
  profile: 'profile',
  admin: 'admin',
  settings: 'profile',
  guide: 'guide'
}

function parseRoute(pathname = window.location.pathname) {
  const path = pathname.replace(/\/+$/, '') || '/'
  const segments = path.split('/').filter(Boolean)

  if (segments[0] === 'a' && segments[1]) {
    const artifactId = decodeURIComponent(segments[1])
    if (segments[2] === 'analytics') return { name: 'analytics', artifactId }
    return { name: 'artifact', artifactId }
  }

  if (segments[0] === 's' && segments[1]) {
    return { name: 'share', token: decodeURIComponent(segments[1]) }
  }

  if (!segments.length) return { name: 'home' }
  return { name: SIMPLE_ROUTES[segments[0]] || 'home' }
}

// ---------------------------------------------------------------
// Shared view state
//
// `state` (from api.js) holds hydrated server data. `ctx` holds view state:
// filters, in-flight search results, the detail being viewed, share context.
// ---------------------------------------------------------------

const state = getState()

Object.assign(state, {
  recentSearches: [],
  profile: null,
  adminOrg: null,
  adminMembers: [],
  adminWorkspaces: []
})

const ctx = {
  state,
  api,
  boot,
  devCode: null,
  filters: { type: 'all', q: '', sort: 'updated' },
  search: { query: '', results: [], total: 0, performed: false, loading: false, engine: null, activeFilters: [] },
  detail: { loading: false, artifact: null, versions: [], analytics: null },
  analyticsView: { loading: false, data: null, artifactId: null, title: null },
  share: {
    loading: false,
    accessible: false,
    reason: null,
    accessType: null,
    requiresVerification: false,
    stage: 'email',
    view: null,
    sharedBy: null
  },
  shareToken: null,
  shareEmail: '',
  shareDevCode: null,
  adminTotals: null,
  adminProviderStats: []
}

let currentRoute = parseRoute()
let renderToken = 0

/**
 * Whether this browser has completed share verification in this page session.
 * The server's boot flag only reflects the cookie present at document load, so
 * after an in-page verification we track it here rather than re-reading boot.
 */
let shareGranted = !!boot.hasShareGrant

// ---------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------

function screenFor(route) {
  // The external recipient surface and the user guide are public: the guide is
  // documentation, holds no user data, and is linked from every footer, so a
  // signed-out visitor gets it rather than a sign-in wall. Every other route
  // requires a session.
  const isPublic = route.name === 'share' || route.name === 'guide'
  if (!state.session.authenticated && !isPublic) {
    return renderLogin(ctx)
  }

  switch (route.name) {
    case 'home':
      return renderHome(ctx)
    case 'library':
      return renderLibrary(ctx)
    case 'search':
      return renderSearch(ctx)
    case 'add':
      return renderAdd(ctx)
    case 'profile':
      return renderProfile(ctx)
    case 'admin':
      return renderAdmin(ctx)
    case 'artifact':
      return renderArtifactDetail(ctx)
    case 'analytics':
      return renderAnalytics(ctx)
    case 'share':
      return renderShareRecipient(ctx)
    case 'guide':
      return renderGuide(ctx)
    default:
      return renderHome(ctx)
  }
}

function render() {
  const root = document.getElementById('app')
  if (!root) return

  const snapshot = captureFocus()
  const screen = screenFor(currentRoute)

  root.innerHTML = screen.html || ''
  try {
    screen.mount?.(root)
  } catch (error) {
    console.error('[mount]', error)
  }
  restoreFocus(snapshot)

  // Header hairline appears only once content is scrolled beneath it
  const header = root.querySelector('[data-header]')
  if (header) {
    const sentinel = () => {
      header.classList.toggle('is-scrolled', window.scrollY > 4)
    }
    window.removeEventListener('scroll', window.__headerScroll || (() => {}))
    window.__headerScroll = sentinel
    window.addEventListener('scroll', sentinel, { passive: true })
    sentinel()
  }
}

/**
 * Re-render the current route, optionally re-fetching its data.
 * Guarded by a token so a slow response cannot overwrite a newer view.
 */
async function refresh({ reload = false } = {}) {
  const token = ++renderToken
  if (reload) {
    try {
      await loadRouteData(currentRoute)
    } catch (error) {
      if (error?.status !== 401) toast(error.message || 'Could not load that', 'error')
    }
  }
  if (token !== renderToken) return
  render()
}

function navigate(path, { replace = false } = {}) {
  if (replace) window.history.replaceState({}, '', path)
  else window.history.pushState({}, '', path)

  currentRoute = parseRoute(path)
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' })
  void refresh({ reload: true })
}

function goBack() {
  if (window.history.length > 1) window.history.back()
  else navigate('/')
}

// ---------------------------------------------------------------
// Data loading per route
// ---------------------------------------------------------------

async function loadArtifacts({ workspaceId } = {}) {
  const result = await api.listArtifacts({
    workspaceId: workspaceId ?? state.currentWorkspaceId ?? undefined,
    type: ctx.filters.type && ctx.filters.type !== 'all' && ctx.filters.type !== 'image'
      ? ctx.filters.type
      : undefined,
    sort: ctx.filters.sort,
    limit: 60
  })
  setState({ artifacts: result?.artifacts || [] })
  return result
}

/** Library search: a query goes to the search index, otherwise a plain listing. */
async function runLibraryQuery() {
  const query = (ctx.filters.q || '').trim()
  if (query.length >= 2) {
    const result = await api.search({
      query,
      limit: 60
    })
    setState({
      artifacts: (result?.results || []).map((hit) => ({
        ...hit,
        isOwner: true,
        tags: hit.tags || []
      }))
    })
    return
  }
  await loadArtifacts()
}

async function loadShellData() {
  const me = await api.me()
  if (!me?.authenticated) {
    setState({ session: { authenticated: false, devMode: !!me?.devMode }, me: null })
    return false
  }

  setState({
    me: me.user,
    workspaces: me.workspaces || [],
    organizations: me.organizations || [],
    integrations: me.integrations || [],
    session: { authenticated: true, devMode: !!me.devMode }
  })

  if (!state.currentWorkspaceId) {
    const personal = (me.workspaces || []).find((w) => w.type === 'PERSONAL')
    setState({ currentWorkspaceId: personal?.id || me.workspaces?.[0]?.id || null })
  }

  return true
}

async function loadRouteData(route) {
  // The external recipient surface is the one route that never requires a session.
  if (route.name === 'share') {
    ctx.shareToken = route.token
    await loadShare()
    return
  }

  if (!state.session.authenticated) {
    const okToRender = await loadShellData()
    if (!okToRender) return
  }

  switch (route.name) {
    case 'home':
    case 'library': {
      await Promise.all([loadArtifacts(), loadIntegrations()])
      break
    }
    case 'search': {
      if (!state.recentSearches.length) {
        try {
          const recent = await api.recentSearches()
          setState({ recentSearches: recent?.recent || [] })
        } catch {
          /* history is a convenience, never a blocker */
        }
      }
      break
    }
    case 'add': {
      await loadIntegrations()
      break
    }
    case 'profile': {
      const profile = await api.profile()
      setState({ profile })
      break
    }
    case 'admin': {
      await loadAdminData()
      break
    }
    case 'artifact': {
      ctx.detail.loading = true
      ctx.detail.artifact = null
      ctx.detail.versions = []
      ctx.detail.analytics = null
      render()
      try {
        const [detail, analytics] = await Promise.all([
          api.getArtifact(route.artifactId),
          api.analytics(route.artifactId, '30d').catch(() => null)
        ])
        ctx.detail.artifact = detail?.artifact || null
        ctx.detail.versions = detail?.versions || []
        ctx.detail.analytics = analytics
      } catch (error) {
        ctx.detail.artifact = null
        if (error?.status !== 404) throw error
      } finally {
        ctx.detail.loading = false
      }
      break
    }
    case 'analytics': {
      ctx.analyticsView.loading = true
      ctx.analyticsView.data = null
      ctx.analyticsView.artifactId = route.artifactId
      if (!ctx.analyticsView.title) {
        const known = state.artifacts.find((a) => a.id === route.artifactId)
        ctx.analyticsView.title = known?.title || 'Artifact'
      }
      render()
      await loadAnalytics(route.artifactId, ctx.analyticsView.data?.period || '30d')
      break
    }
    default:
      break
  }
}

async function loadIntegrations() {
  try {
    const result = await api.integrations()
    setState({ integrations: result?.integrations || [] })
  } catch {
    /* connector list is supplementary */
  }
}

async function loadAdminData() {
  const orgs = await api.organizations()
  const adminOrg = (orgs?.organizations || []).find(
    (o) => o.role === 'ORG_OWNER' || o.role === 'ORG_ADMIN'
  )

  if (!adminOrg) {
    ctx.state.adminOrg = null
    ctx.adminTotals = null
    ctx.adminProviderStats = []
    return
  }

  ctx.state.adminOrg = adminOrg

  const [analytics, members, workspaces] = await Promise.all([
    api.orgAnalytics(adminOrg.id, '30d'),
    api.orgMembers(adminOrg.id).catch(() => ({ members: [] })),
    api.workspaces().catch(() => ({ workspaces: [] }))
  ])

  ctx.adminTotals = {
    artifacts: analytics?.totals?.artifacts ?? 0,
    members: analytics?.totals?.members ?? 0,
    views: analytics?.totals?.views ?? 0,
    aiReferences: analytics?.totals?.aiReferences ?? 0
  }
  ctx.adminProviderStats = analytics?.byProvider || []

  ctx.state.adminMembers = members?.members || []
  ctx.state.adminWorkspaces = (workspaces?.workspaces || []).filter(
    (w) => w.organizationId === adminOrg.id
  ).map((w) => ({
    id: w.id,
    name: w.name,
    artifacts: w.artifactCount ?? 0,
    views: (analytics?.byWorkspace || []).find((x) => x.id === w.id)?.views ?? 0
  }))
}

// ---------------------------------------------------------------
// ctx: navigation and shell affordances
// ---------------------------------------------------------------

ctx.navigate = navigate

ctx.goBack = goBack

ctx.refresh = () => refresh({ reload: false })

ctx.onAuthenticated = async () => {
  await refresh({ reload: true })
  if (currentRoute.name === 'home' || currentRoute.name === 'share') navigate('/', { replace: true })
}

ctx.signOut = async () => {
  try {
    await api.logout()
  } catch {
    /* the session is being discarded regardless */
  }
  setState({
    me: null,
    profile: null,
    artifacts: [],
    workspaces: [],
    organizations: [],
    integrations: [],
    collections: [],
    tags: [],
    activity: [],
    recentSearches: [],
    currentWorkspaceId: null,
    session: { authenticated: false, devMode: state.session.devMode }
  })
  ctx.detail = { loading: false, artifact: null, versions: [], analytics: null }
  window.history.replaceState({}, '', '/')
  currentRoute = parseRoute('/')
  render()
}

function navItem(key, path, label, iconName, active) {
  return `
    <button class="nav-item" data-nav="${esc(path)}" ${active === key ? 'aria-current="page"' : ''}>
      ${icon(iconName, 21)}
      <span>${esc(label)}</span>
    </button>`
}

ctx.bottomNav = (active) => `
  <nav class="bottom-nav" aria-label="Primary navigation">
    ${navItem('home', '/', 'Home', 'home', active)}
    ${navItem('library', '/library', 'Library', 'library', active)}
    <button class="nav-item" id="nav-add" aria-label="Add to library">
      <span class="nav-add">${icon('plus', 22)}</span>
      <span>Add</span>
    </button>
    ${navItem('search', '/search', 'Search', 'search', active)}
    ${navItem('profile', '/profile', 'Profile', 'user', active)}
  </nav>`

/**
 * Application footer.
 *
 * A persistent, quiet route into the user guide and the app's standing
 * statements. Rendered at the end of every screen's <main> so it is always
 * reachable. The "Keyboard & tips" button is handled by the single delegated
 * document click handler, so screens need no per-screen wiring.
 */
ctx.appFooter = () => `
  <footer class="app-footer" aria-label="Help and information">
    <button type="button" data-nav="/guide">${icon('file', 14)} User guide</button>
    <button type="button" id="footer-shortcuts">${icon('search', 14)} Keyboard &amp; tips</button>
    <span class="footer-copy">
      Artifacts are private unless shared &middot; ${icon('shield', 11)} Access is checked on every request
    </span>
  </footer>`

/**
 * Keyboard & tips bottom sheet.
 *
 * Shared by the footer's "Keyboard & tips" button and the Profile/settings row,
 * so the guidance lives in exactly one place.
 */
ctx.openShortcutsSheet = () => {
  sheet({
    title: 'Keyboard & tips',
    content: `
      <div class="guide-section" style="margin-top:0">
        <ul>
          <li><strong>Add a file quickly</strong> — the <em>Add</em> button in the middle of the bottom bar.</li>
          <li><strong>Search everything</strong> — search matches titles, tags and the text inside your documents.</li>
          <li><strong>Close a panel</strong> — swipe it down, tap the X, or press <code>Esc</code>.</li>
          <li><strong>Go back</strong> — your device's back gesture works everywhere; links are real URLs.</li>
          <li><strong>Copy a link</strong> — open an artifact and use its share button.</li>
        </ul>
        <p>The full reference, including every feature and its current limits, is in the
        <button class="guide-inline-link" id="footer-open-guide">user guide</button>.</p>
      </div>`,
    onMount: (host) => {
      host.querySelector('#footer-open-guide')?.addEventListener('click', () => {
        closeSheet()
        ctx.navigate('/guide')
      })
    }
  })
}

/** Workspace switcher in the home header (§30). */
ctx.workspaceSwitcher = () => {
  const current = (state.workspaces || []).find((w) => w.id === state.currentWorkspaceId)
  const label = current?.name || 'Workspace'
  return `
    <button class="chip" id="workspace-switcher" style="min-height:36px;padding:6px 11px;cursor:pointer;max-width:170px">
      ${icon(current?.type === 'PERSONAL' ? 'user' : 'building', 14)}
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label)}</span>
      ${icon('back', 12, 'rotate-270')}
    </button>`
}

// ---------------------------------------------------------------
// ctx: search and filtering
// ---------------------------------------------------------------

let searchTimer = null
let filterTimer = null

function debounce(fn, delay) {
  return (...args) => {
    window.clearTimeout(fn.__timer)
    fn.__timer = window.setTimeout(() => fn(...args), delay)
  }
}

async function runSearch({ save = true } = {}) {
  const query = (ctx.search.query || '').trim()
  if (query.length < 2) {
    ctx.search.performed = false
    ctx.search.results = []
    ctx.search.total = 0
    ctx.search.engine = null
    render()
    return
  }

  ctx.search.loading = true
  ctx.search.performed = true
  render()

  const filters = {}
  for (const filter of ctx.search.activeFilters) {
    filters[filter.key] = filter.value
  }

  try {
    const result = await api.search({ query, filters, limit: 40 })
    ctx.search.results = result?.results || []
    ctx.search.total = result?.total ?? ctx.search.results.length
    ctx.search.engine = result?.engine || null
    if (save) void api.saveSearch(query).catch(() => {})
  } catch (error) {
    if (error?.status !== 401) toast(error.message, 'error')
    ctx.search.results = []
    ctx.search.total = 0
  } finally {
    ctx.search.loading = false
    render()
  }
}

ctx.runSearch = () => runSearch()

ctx.debouncedSearch = () => {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => runSearch({ save: false }), 280)
}

ctx.debouncedFilter = () => {
  window.clearTimeout(filterTimer)
  filterTimer = window.setTimeout(() => {
    void (async () => {
      try {
        await runLibraryQuery()
      } catch (error) {
        if (error?.status !== 401) toast(error.message, 'error')
      }
      render()
    })()
  }, 280)
}

ctx.clearSearchFilter = (key) => {
  ctx.search.activeFilters = ctx.search.activeFilters.filter((f) => f.key !== key)
  void runSearch({ save: false })
}

ctx.openFilterSheet = () => {
  const types = [
    ['all', 'Any type'],
    ['pptx', 'Presentation (PPTX)'],
    ['pdf', 'PDF'],
    ['docx', 'Document (DOCX)'],
    ['html', 'Web page (HTML)'],
    ['image', 'Image']
  ]

  const currentType = ctx.search.activeFilters.find((f) => f.key === 'type')?.value || 'all'
  const currentSort = ctx.search.activeFilters.find((f) => f.key === 'sort')?.value || 'updated'

  sheet({
    title: 'Filters',
    content: `
      <div>
        <div style="font-size:12.5px;font-weight:640;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Type</div>
        ${types
          .map(
            ([value, label]) => `
          <label class="row" style="gap:11px;padding:11px 0">
            <input type="radio" name="filter-type" value="${esc(value)}" ${currentType === value ? 'checked' : ''}
              style="accent-color:var(--accent);width:18px;height:18px;flex:none">
            <span style="flex:1;font-size:14px">${esc(label)}</span>
          </label>`
          )
          .join('')}

        <div style="font-size:12.5px;font-weight:640;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin:18px 0 8px">Sort</div>
        ${[
          ['updated', 'Recently updated'],
          ['created', 'Recently created'],
          ['title', 'Title A–Z']
        ]
          .map(
            ([value, label]) => `
          <label class="row" style="gap:11px;padding:11px 0">
            <input type="radio" name="filter-sort" value="${esc(value)}" ${currentSort === value ? 'checked' : ''}
              style="accent-color:var(--accent);width:18px;height:18px;flex:none">
            <span style="flex:1;font-size:14px">${esc(label)}</span>
          </label>`
          )
          .join('')}

        <p style="font-size:11.5px;color:var(--text-3);margin:16px 0 0;line-height:1.55">
          Results are always limited to workspaces you can already read.
        </p>
      </div>`,
    actions: [
      {
        label: 'Apply filters',
        variant: 'primary',
        onClick: () => {
          const panel = document.querySelector('.sheet')
          const type = panel?.querySelector('input[name="filter-type"]:checked')?.value || 'all'
          const sort = panel?.querySelector('input[name="filter-sort"]:checked')?.value || 'updated'

          ctx.search.activeFilters = ctx.search.activeFilters.filter(
            (f) => f.key !== 'type' && f.key !== 'sort'
          )
          if (type !== 'all') {
            ctx.search.activeFilters.push({ key: 'type', value: type, label: `Type: ${type.toUpperCase()}` })
          }
          if (sort !== 'updated') {
            ctx.search.activeFilters.push({ key: 'sort', value: sort, label: `Sort: ${sort}` })
          }
          void runSearch({ save: false })
        }
      },
      {
        label: 'Clear all',
        variant: 'secondary',
        onClick: () => {
          ctx.search.activeFilters = []
          void runSearch({ save: false })
        }
      }
    ]
  })
}

// ---------------------------------------------------------------
// ctx: analytics and share loading
// ---------------------------------------------------------------

async function loadAnalytics(artifactId, period = '30d') {
  ctx.analyticsView.loading = true
  ctx.analyticsView.artifactId = artifactId
  render()

  try {
    const data = await api.analytics(artifactId, period)
    ctx.analyticsView.data = data
    if (!ctx.analyticsView.title || ctx.analyticsView.title === 'Artifact') {
      const known = state.artifacts.find((a) => a.id === artifactId)
      if (known?.title) ctx.analyticsView.title = known.title
      else {
        const detail = await api.getArtifact(artifactId).catch(() => null)
        if (detail?.artifact?.title) ctx.analyticsView.title = detail.artifact.title
      }
    }
  } catch (error) {
    if (error?.status !== 401) toast(error.message, 'error')
    ctx.analyticsView.data = { permitted: false, reason: 'Analytics could not be loaded.' }
  } finally {
    ctx.analyticsView.loading = false
    render()
  }
}

async function loadShare() {
  const token = ctx.shareToken
  if (!token) return

  ctx.share.loading = true
  render()

  try {
    const meta = await api.shareMeta(token)

    if (!meta?.exists) {
      ctx.share = { ...ctx.share, loading: false, accessible: false, reason: 'NOT_FOUND', view: null }
      render()
      return
    }

    ctx.share.accessType = meta.accessType
    ctx.share.requiresVerification = !!meta.requiresVerification
    ctx.share.sharedBy = meta.sharedBy

    const blockedReason = meta.status && meta.status !== 'ACTIVE' ? meta.status : null

    if (blockedReason) {
      ctx.share = {
        ...ctx.share,
        loading: false,
        accessible: false,
        reason: blockedReason,
        view: null
      }
      render()
      return
    }

    // Verification-gated shares are decided by the server, not guessed here:
    // we always attempt /view and let the 403 drive the gate. That keeps this
    // client from ever rendering content it was not granted.
    try {
      // GET /shares/:token/view answers with { accessible, view: {...} } and the
      // screens read ctx.share.view as that inner view object.
      const result = await api.shareView(token)
      shareGranted = true
      ctx.share = {
        ...ctx.share,
        loading: false,
        accessible: true,
        reason: null,
        view: result?.view || result || null
      }
    } catch (error) {
      if (error?.status === 403) {
        // Before verification this is the normal state and the gate should
        // render. After verification, a 403 means the proven address is not
        // entitled to this share.
        ctx.share = {
          ...ctx.share,
          loading: false,
          accessible: false,
          reason: shareGranted ? 'EMAIL_MISMATCH' : null,
          view: null
        }
      } else {
        ctx.share = {
          ...ctx.share,
          loading: false,
          accessible: false,
          reason: error?.status === 404 ? 'NOT_FOUND' : 'GONE',
          view: null
        }
      }
    }
  } catch (error) {
    ctx.share = {
      ...ctx.share,
      loading: false,
      accessible: false,
      reason: error?.status === 404 ? 'NOT_FOUND' : 'GONE',
      view: null
    }
  }

  render()
}

ctx.loadShare = loadShare
ctx.loadAnalytics = loadAnalytics

ctx.sharePreviewUrl = (artifactId) =>
  `/api/v1/shares/${encodeURIComponent(ctx.shareToken)}/preview?artifactId=${encodeURIComponent(artifactId)}`

ctx.shareContentUrl = (artifactId, download) =>
  `/api/v1/shares/${encodeURIComponent(ctx.shareToken)}/content?artifactId=${encodeURIComponent(artifactId)}${download ? '&download=1' : ''}`

/**
 * User-facing "open" URL for a shared artifact.
 *
 * HTML goes to the secure viewer route, which serves our own trusted wrapper
 * and loads the artifact inside an opaque-origin sandbox iframe — so the
 * recipient gets a rendered page instead of source code, and the artifact
 * still never executes on the application origin. Everything else is served
 * directly by the delivery endpoint.
 */
ctx.shareViewerUrl = (artifactId) =>
  `/s/${encodeURIComponent(ctx.shareToken)}/artifact/${encodeURIComponent(artifactId)}`

ctx.shareOpenUrl = (artifactId, isHtml) =>
  isHtml ? ctx.shareViewerUrl(artifactId) : ctx.shareContentUrl(artifactId, false)

ctx.openAnalyticsScreen = (artifactId) => navigate(`/a/${encodeURIComponent(artifactId)}/analytics`)

// ---------------------------------------------------------------
// Small shared builders
// ---------------------------------------------------------------

const ACCEPTED = '.pptx,.pdf,.docx,.html,.htm,.png,.jpg,.jpeg,.bmp,.gif'

function workspaceOptions(selectedId) {
  const current = selectedId ?? state.currentWorkspaceId
  const writable = (state.workspaces || []).filter(
    (w) => !w.role || w.role !== 'VIEWER'
  )
  const list = writable.length ? writable : state.workspaces || []

  return list
    .map(
      (w) => `<option value="${esc(w.id)}" ${w.id === current ? 'selected' : ''}>
        ${esc(w.name)}${w.type === 'PERSONAL' ? ' (Personal)' : ''}
      </option>`
    )
    .join('')
}

function field(label, inputHtml, hint) {
  return `
    <div style="margin-bottom:14px">
      <label style="font-size:13px;font-weight:600;display:block;margin-bottom:6px">${esc(label)}</label>
      ${inputHtml}
      ${hint ? `<p style="font-size:11.5px;color:var(--text-2);margin:6px 0 0;line-height:1.5">${esc(hint)}</p>` : ''}
    </div>`
}

function busyButton(label, iconName, busyLabel) {
  return `${spinner()} ${esc(busyLabel || label)}`
}

/** Runs an async action with an error toast, returning a boolean. */
async function attempt(fn, successMessage) {
  try {
    const result = await fn()
    if (successMessage) toast(successMessage, 'success')
    return result
  } catch (error) {
    if (error?.status !== 401) toast(error?.message || 'Something went wrong', 'error')
    return null
  }
}

// ---------------------------------------------------------------
// Add / upload / save content
// ---------------------------------------------------------------

ctx.openAddSheet = () => {
  sheet({
    title: 'Add to library',
    content: `
      <button class="row" id="sheet-upload">${icon('upload', 20)} <span style="flex:1">Upload a file</span></button>
      <button class="row" id="sheet-content">${icon('globe', 20)} <span style="flex:1">Save HTML or text</span></button>
      <button class="row" id="sheet-collection">${icon('folder', 20)} <span style="flex:1">Create a collection</span></button>
      <button class="row" id="sheet-go-add">${icon('ai', 20)} <span style="flex:1">Connected AI apps</span></button>
    `,
    onMount(handle) {
      handle.body.querySelector('#sheet-upload')?.addEventListener('click', () => ctx.openUploadSheet())
      handle.body.querySelector('#sheet-content')?.addEventListener('click', () => ctx.openContentSheet())
      handle.body.querySelector('#sheet-collection')?.addEventListener('click', () =>
        ctx.openCollectionCreateSheet()
      )
      handle.body.querySelector('#sheet-go-add')?.addEventListener('click', () => navigate('/add'))
    }
  })
}

ctx.openUploadSheet = () => {
  let file = null

  sheet({
    title: 'Upload a file',
    content: `
      <div>
        ${field(
          'File',
          `<label class="btn btn-secondary btn-block" style="cursor:pointer">
             ${icon('upload', 18)} Choose a file
             <input id="upload-file" type="file" class="sr-only" accept="${ACCEPTED}">
           </label>
           <div id="upload-filename" style="font-size:12.5px;color:var(--text-2);margin-top:8px">No file chosen</div>`,
          'PPTX, PDF, DOCX, HTML or images.'
        )}
        ${field(
          'Workspace',
          `<select id="upload-workspace" class="input">${workspaceOptions()}</select>`
        )}
        ${field(
          'Title',
          '<input id="upload-title" class="input" type="text" placeholder="Optional — defaults to the filename">'
        )}
        ${field(
          'Tags',
          '<input id="upload-tags" class="input" type="text" placeholder="comma, separated, slugs">',
          'Tags are governed by your organization admin.'
        )}
      </div>`,
    actions: [
      {
        label: 'Upload',
        variant: 'primary',
        keepOpen: true,
        onClick: async (event) => {
          const panel = document.querySelector('.sheet')
          const button = panel?.querySelector('#sheet-actions .btn-primary')
          file = file || panel?.querySelector('#upload-file')?.files?.[0] || null

          if (!file) {
            toast('Choose a file first', 'error')
            return
          }

          const form = new FormData()
          form.append('file', file)
          const workspaceId = panel?.querySelector('#upload-workspace')?.value
          if (workspaceId) form.append('workspaceId', workspaceId)
          const title = panel?.querySelector('#upload-title')?.value?.trim()
          if (title) form.append('title', title)
          const tags = panel?.querySelector('#upload-tags')?.value?.trim()
          if (tags) form.append('tags', tags)

          if (button) {
            button.disabled = true
            button.innerHTML = busyButton('Upload', 'upload', 'Uploading…')
          }

          const result = await attempt(() => api.uploadArtifact(form))
          if (!result) {
            if (button) {
              button.disabled = false
              button.textContent = 'Upload'
            }
            return
          }

          closeSheet()
          toast('Artifact added', 'success')
          await loadArtifacts()
          navigate(`/a/${encodeURIComponent(result.artifact.id)}`)
        }
      }
    ],
    onMount(handle) {
      const input = handle.body.querySelector('#upload-file')
      const label = handle.body.querySelector('#upload-filename')

      input?.addEventListener('change', () => {
        file = input.files?.[0] || null
        if (label) {
          label.textContent = file
            ? `${file.name} · ${formatBytes(file.size)}`
            : 'No file chosen'
        }
      })
    }
  })
}

ctx.openContentSheet = () => {
  sheet({
    title: 'Save HTML or text',
    content: `
      <div>
        ${field(
          'Title',
          '<input id="content-title" class="input" type="text" placeholder="Board update — Q3">'
        )}
        ${field(
          'Filename',
          '<input id="content-filename" class="input" type="text" value="note.html">',
          'Use an .html extension for markup, .txt for plain text.'
        )}
        ${field(
          'Content',
          `<textarea id="content-body" class="input" placeholder="<!doctype html>…"></textarea>`
        )}
        ${field(
          'Workspace',
          `<select id="content-workspace" class="input">${workspaceOptions()}</select>`
        )}
      </div>`,
    actions: [
      {
        label: 'Save',
        variant: 'primary',
        keepOpen: true,
        onClick: async () => {
          const panel = document.querySelector('.sheet')
          const title = panel?.querySelector('#content-title')?.value?.trim() || ''
          const filename = panel?.querySelector('#content-filename')?.value?.trim() || 'note.html'
          const content = panel?.querySelector('#content-body')?.value || ''
          const workspaceId = panel?.querySelector('#content-workspace')?.value

          if (!content.trim()) {
            toast('Add some content first', 'error')
            return
          }

          const result = await attempt(() =>
            api.createArtifactFromContent({
              filename,
              mimeType: filename.toLowerCase().endsWith('.html') ? 'text/html' : 'text/plain',
              contentText: content,
              title: title || undefined,
              workspaceId
            })
          )
          if (!result) return

          closeSheet()
          toast('Artifact saved', 'success')
          await loadArtifacts()
          navigate(`/a/${encodeURIComponent(result.artifact.id)}`)
        }
      }
    ]
  })
}

ctx.openCollectionCreateSheet = () => {
  sheet({
    title: 'New collection',
    content: `
      <div>
        ${field('Name', '<input id="collection-name" class="input" type="text" placeholder="Q3 board pack">')}
        ${field(
          'Description',
          '<textarea id="collection-desc" class="input" placeholder="Optional"></textarea>'
        )}
        ${field(
          'Workspace',
          `<select id="collection-workspace" class="input">${workspaceOptions()}</select>`
        )}
      </div>`,
    actions: [
      {
        label: 'Create collection',
        variant: 'primary',
        keepOpen: true,
        onClick: async () => {
          const panel = document.querySelector('.sheet')
          const name = panel?.querySelector('#collection-name')?.value?.trim()
          if (!name) {
            toast('Give the collection a name', 'error')
            return
          }
          const description = panel?.querySelector('#collection-desc')?.value?.trim() || null
          const workspaceId = panel?.querySelector('#collection-workspace')?.value

          const result = await attempt(() =>
            api.createCollection({ name, description, workspaceId })
          )
          if (!result) return

          closeSheet()
          toast('Collection created', 'success')
          await loadCollections()
          ctx.openCollectionsSheet()
        }
      }
    ]
  })
}

// ---------------------------------------------------------------
// AI connectors (§58, §60)
// ---------------------------------------------------------------

ctx.openConnectSheet = (integration) => {
  if (!integration) {
    toast('That connector is not available', 'error')
    return
  }

  let scopes = integration.requiredScopes || ['artifact.read', 'artifact.write']

  sheet({
    title: `Connect ${integration.name}`,
    content: `
      <div>
        <p style="font-size:13.5px;color:var(--text-2);margin:0 0 16px;line-height:1.55">
          ${esc(integration.description || 'Grant this AI app scoped access to your library.')}
        </p>

        <div style="font-size:12.5px;font-weight:640;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">
          Access to grant
        </div>

        ${[
          ['artifact.read', 'Read artifacts you can already read'],
          ['artifact.write', 'Create and update artifacts'],
          ['artifact.share', 'Create and revoke shares'],
          ['analytics.read', 'Read analytics']
        ]
          .map(
            ([value, label]) => `
          <label class="row" style="gap:11px;padding:11px 0;cursor:pointer">
            <input type="checkbox" name="scope" value="${esc(value)}" ${scopes.includes(value) ? 'checked' : ''}
              style="accent-color:var(--accent);width:20px;height:20px;flex:none">
            <span style="flex:1;font-size:14px">${esc(label)}</span>
          </label>`
          )
          .join('')}

        <p style="font-size:11.5px;color:var(--text-3);margin:14px 0 0;line-height:1.55">
          A connector can never exceed your own access. Uncheck anything you do not need.
        </p>
      </div>`,
    actions: [
      {
        label: 'Connect',
        variant: 'primary',
        keepOpen: true,
        onClick: async () => {
          const panel = document.querySelector('.sheet')
          const selected = Array.from(panel?.querySelectorAll('input[name="scope"]:checked') || []).map(
            (input) => input.value
          )
          if (!selected.length) {
            toast('Select at least one permission', 'error')
            return
          }

          const result = await attempt(() =>
            api.connectIntegration(integration.integrationId, selected)
          )
          if (!result) return

          closeSheet()
          await loadIntegrations()
          ctx.openGrantResultSheet(result, integration)
        }
      }
    ],
    onMount(handle) {
      handle.body.querySelectorAll('input[name="scope"]').forEach((input) => {
        input.addEventListener('change', () => {
          scopes = Array.from(handle.body.querySelectorAll('input[name="scope"]:checked')).map(
            (i) => i.value
          )
        })
      })
    }
  })
}

/** The one moment a grant token is visible (§58). */
ctx.openGrantResultSheet = (result, integration) => {
  sheet({
    title: 'Connector ready',
    content: `
      <div>
        <p style="font-size:13px;color:var(--text-2);margin:0 0 12px;line-height:1.55">
          Paste these two values into ${esc(integration?.name || 'your AI app')}:
        </p>

        <div style="font-size:11.5px;font-weight:640;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">MCP endpoint</div>
        <div style="padding:11px;border-radius:11px;background:var(--surface-2);font-family:ui-monospace,monospace;
          font-size:11.5px;word-break:break-all;line-height:1.6">${esc(result.mcpEndpoint)}</div>

        <div style="font-size:11.5px;font-weight:640;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin:14px 0 5px">Access token</div>
        <div style="padding:11px;border-radius:11px;background:var(--surface-2);font-family:ui-monospace,monospace;
          font-size:11.5px;word-break:break-all;line-height:1.6">${esc(result.token)}</div>

        <div style="margin-top:14px;padding:11px 13px;border-radius:11px;background:var(--warning-weak);
          border:1px solid #fedf89;font-size:12px;line-height:1.55;color:#93370d">
          ${icon('alert', 13)} ${esc(result.note || 'This token cannot be shown again.')}
        </div>

        <div style="font-size:12.5px;color:var(--text-2);margin-top:14px">
          Granted scopes: ${esc((result.scopes || []).join(', '))}
        </div>
      </div>`,
    actions: [
      {
        label: 'Copy token',
        variant: 'primary',
        keepOpen: true,
        onClick: async () => {
          await copyText(result.token)
        }
      },
      {
        label: 'Copy endpoint',
        keepOpen: true,
        onClick: async () => {
          await copyText(result.mcpEndpoint)
        }
      }
    ]
  })
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value)
    toast('Copied', 'success')
  } catch {
    const area = document.createElement('textarea')
    area.value = value
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    area.remove()
    toast('Copied', 'success')
  }
}

ctx.openIntegrationSheet = (integration) => {
  const scopes = integration.scopes || []

  sheet({
    title: integration.name,
    content: `
      <div>
        <p style="font-size:13.5px;color:var(--text-2);margin:0 0 14px;line-height:1.55">
          ${esc(integration.description || 'Connected to your library.')}
        </p>

        <div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0">
          <span style="color:var(--text-2)">Status</span>
          <span style="font-weight:560;color:var(--success)">Connected</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0">
          <span style="color:var(--text-2)">Token prefix</span>
          <span style="font-weight:560;font-family:ui-monospace,monospace;font-size:11.5px">${esc(
            integration.tokenPrefix || '—'
          )}</span>
        </div>
        <div style="font-size:13px;padding:6px 0">
          <div style="color:var(--text-2);margin-bottom:7px">Scopes</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${
              scopes.length
                ? scopes.map((s) => `<span class="chip">${esc(s)}</span>`).join('')
                : '<span style="color:var(--text-3)">None</span>'
            }
          </div>
        </div>
      </div>`,
    actions: [
      {
        label: 'Disconnect',
        variant: 'danger',
        onClick: async () => {
          const done = await attempt(
            () => api.disconnectIntegration(integration.grantId),
            'Connector disconnected'
          )
          if (done === null) return
          await loadIntegrations()
          render()
        }
      }
    ]
  })
}

// ---------------------------------------------------------------
// Tags (§24)
// ---------------------------------------------------------------

async function ensureTags() {
  if (state.tags?.length) return state.tags
  try {
    const result = await api.tags()
    setState({ tags: result?.tags || [] })
  } catch {
    setState({ tags: [] })
  }
  return state.tags
}

ctx.openTagsSheet = async (options = {}) => {
  const tags = await ensureTags()

  // Apply / remove on a specific artifact
  if (options.artifact) {
    const artifact = options.artifact
    const applied = new Set((artifact.tags || []).map((t) => t.toLowerCase()))
    const byName = new Map(tags.map((t) => [t.name.toLowerCase(), t]))

    sheet({
      title: 'Manage tags',
      content: `
        <div>
          <input id="tag-filter" class="input" type="search" placeholder="Filter tags" style="margin-bottom:12px">
          <div id="tag-list">
            ${
              tags.length
                ? tags
                    .map(
                      (t) => `
              <label class="row" data-tag-row data-name="${esc(t.name.toLowerCase())}" style="gap:11px;padding:11px 0;cursor:pointer">
                <input type="checkbox" data-tag-slug="${esc(t.slug)}" ${applied.has(t.name.toLowerCase()) ? 'checked' : ''}
                  style="accent-color:var(--accent);width:20px;height:20px;flex:none">
                <span style="flex:1">
                  <span style="display:block;font-size:14px">${esc(t.name)}</span>
                  <span style="display:block;font-size:11.5px;color:var(--text-2)">
                    ${esc(t.scope)} · used ${t.usageCount} time(s)
                  </span>
                </span>
              </label>`
                    )
                    .join('')
                : '<p style="font-size:13px;color:var(--text-2)">No tags exist yet. An organization admin can create them.</p>'
            }
          </div>
        </div>`,
      actions: [
        {
          label: 'Save tags',
          variant: 'primary',
          keepOpen: true,
          onClick: async () => {
            const panel = document.querySelector('.sheet')
            const desired = new Set(
              Array.from(panel?.querySelectorAll('input[data-tag-slug]:checked') || []).map(
                (input) => input.dataset.tagSlug
              )
            )
            const currentSlugs = new Map(
              (artifact.tags || [])
                .map((name) => byName.get(String(name).toLowerCase())?.slug)
                .filter(Boolean)
                .map((slug) => [slug, true])
            )

            const toAdd = [...desired].filter((slug) => !currentSlugs.has(slug))
            const toRemove = [...currentSlugs.keys()].filter((slug) => !desired.has(slug))

            const changed = await attempt(async () => {
              if (toAdd.length) await api.applyTags(artifact.id, toAdd)
              for (const slug of toRemove) await api.removeTag(artifact.id, slug)
              return true
            })

            if (!changed) return

            toast('Tags updated', 'success')
            closeSheet()
            if (ctx.detail.artifact?.id === artifact.id) {
              const detail = await api.getArtifact(artifact.id).catch(() => null)
              if (detail) {
                ctx.detail.artifact = detail.artifact
                ctx.detail.versions = detail.versions || []
              }
            }
            render()
          }
        }
      ],
      onMount(handle) {
        handle.body.querySelector('#tag-filter')?.addEventListener('input', (event) => {
          const term = event.target.value.toLowerCase()
          handle.body.querySelectorAll('[data-tag-row]').forEach((row) => {
            row.style.display = row.dataset.name.includes(term) ? '' : 'none'
          })
        })
      }
    })
    return
  }

  // Tag management surface
  sheet({
    title: 'Tags',
    content: `
      <div>
        ${field(
          'New tag',
          '<input id="tag-name" class="input" type="text" placeholder="market-analysis">',
          'Admin-governed: organization tags require an org admin.'
        )}
        <div style="display:flex;flex-direction:column;gap:9px;margin-top:6px">
          ${
            tags.length
              ? tags
                  .map(
                    (t) => `
            <div class="list-row" style="cursor:default">
              <span class="chip" style="flex:none">${esc(t.name)}</span>
              <span style="flex:1;min-width:0;font-size:11.5px;color:var(--text-2)">
                ${esc(t.scope)} · used ${t.usageCount} time(s)
              </span>
              ${
                t.usageCount > 0
                  ? '<span style="font-size:11px;color:var(--text-3)">in use</span>'
                  : `<button class="btn btn-ghost" data-delete-tag="${esc(t.id)}" style="min-height:36px;padding:0 10px;font-size:12.5px;color:var(--danger)">Delete</button>`
              }
            </div>`
                  )
                  .join('')
              : '<p style="font-size:13px;color:var(--text-2)">No tags yet.</p>'
          }
        </div>
      </div>`,
    actions: [
      {
        label: 'Create tag',
        variant: 'primary',
        keepOpen: true,
        onClick: async () => {
          const panel = document.querySelector('.sheet')
          const name = panel?.querySelector('#tag-name')?.value?.trim()
          if (!name) {
            toast('Enter a tag name', 'error')
            return
          }

          const created = await attempt(() => api.createTag({ name }), 'Tag created')
          if (created === null) return

          setState({ tags: [] })
          await ensureTags()
          ctx.openTagsSheet({ manage: true })
        }
      }
    ],
    onMount(handle) {
      handle.body.querySelectorAll('[data-delete-tag]').forEach((button) => {
        button.addEventListener('click', async () => {
          const removed = await attempt(
            () => api.deleteTag(button.dataset.deleteTag),
            'Tag deleted'
          )
          if (removed === null) return
          setState({ tags: [] })
          await ensureTags()
          ctx.openTagsSheet({ manage: true })
        })
      })
    }
  })
}

// ---------------------------------------------------------------
// Collections (§26)
// ---------------------------------------------------------------

async function loadCollections() {
  try {
    const result = await api.collections(state.currentWorkspaceId || undefined)
    setState({ collections: result?.collections || [] })
  } catch {
    setState({ collections: [] })
  }
  return state.collections
}

ctx.openCollectionsSheet = async () => {
  const collections = await loadCollections()

  sheet({
    title: 'Collections',
    content: `
      <div>
        ${
          collections.length
            ? `<div style="display:flex;flex-direction:column;gap:9px">
                ${collections
                  .map(
                    (c) => `
                  <button class="list-row" data-collection="${esc(c.id)}">
                    ${icon('folder', 20)}
                    <span style="flex:1;min-width:0">
                      <span style="display:block;font-size:14px;font-weight:600">${esc(c.name)}</span>
                      <span style="display:block;font-size:11.5px;color:var(--text-2)">
                        ${c.artifactCount} item(s)${c.workspaceName ? ` · ${esc(c.workspaceName)}` : ''}
                      </span>
                    </span>
                    ${icon('back', 16)}
                  </button>`
                  )
                  .join('')}
               </div>`
            : '<p style="font-size:13px;color:var(--text-2)">No collections in this workspace yet.</p>'
        }
      </div>`,
    actions: [
      {
        label: 'New collection',
        variant: 'secondary',
        onClick: () => ctx.openCollectionCreateSheet()
      }
    ],
    onMount(handle) {
      handle.body.querySelectorAll('[data-collection]').forEach((button) => {
        button.addEventListener('click', () => ctx.openCollectionDetailSheet(button.dataset.collection))
      })
    }
  })
}

ctx.openCollectionDetailSheet = async (collectionId) => {
  let detail = null
  try {
    detail = await api.collection(collectionId)
  } catch (error) {
    toast(error.message, 'error')
    return
  }

  const items = detail?.artifacts || []

  sheet({
    title: detail?.collection?.name || 'Collection',
    content: `
      <div>
        ${
          detail?.collection?.description
            ? `<p style="font-size:13px;color:var(--text-2);margin:0 0 14px;line-height:1.55">${esc(detail.collection.description)}</p>`
            : ''
        }
        ${
          items.length
            ? `<div style="display:flex;flex-direction:column;gap:8px">
                ${items
                  .map(
                    (it) => `
                  <button class="list-row" data-artifact="${esc(it.id)}">
                    ${fileBadge(it.extension)}
                    <span style="flex:1;min-width:0">
                      <span style="display:block;font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.title)}</span>
                      <span style="display:block;font-size:11.5px;color:var(--text-2)">
                        ${esc(extLabel(it.extension))} · ${esc(formatBytes(it.sizeBytes))}
                      </span>
                    </span>
                  </button>`
                  )
                  .join('')}
               </div>`
            : '<p style="font-size:13px;color:var(--text-2)">This collection is empty.</p>'
        }
      </div>`,
    actions: [
      {
        label: 'Share collection',
        variant: 'primary',
        onClick: () => {
          const collection = { id: collectionId, name: detail?.collection?.name || 'Collection' }
          shareCreateSheet(ctx, collection, () => {})
        }
      }
    ],
    onMount(handle) {
      handle.body.querySelectorAll('[data-artifact]').forEach((button) => {
        button.addEventListener('click', () => {
          closeSheet()
          navigate(`/a/${encodeURIComponent(button.dataset.artifact)}`)
        })
      })
    }
  })
}

// ---------------------------------------------------------------
// Activity feed (§70)
// ---------------------------------------------------------------

ctx.openActivitySheet = async () => {
  let activity = []
  try {
    const result = await api.activity(30)
    activity = result?.activity || []
  } catch (error) {
    toast(error.message, 'error')
  }

  const labels = {
    artifact_viewed: 'Viewed',
    artifact_downloaded: 'Downloaded',
    artifact_ai_referenced: 'Referenced by AI',
    artifact_shared: 'Shared',
    artifact_version_created: 'New version'
  }

  sheet({
    title: 'Recent activity',
    content: `
      <div>
        ${
          activity.length
            ? activity
                .map(
                  (row) => `
            <div style="display:flex;gap:11px;padding:10px 0;border-bottom:1px solid var(--border)">
              <div style="flex:none;color:var(--text-3)">${icon('clock', 17)}</div>
              <div style="flex:1;min-width:0">
                <div style="font-size:13px;font-weight:560">${esc(labels[row.event] || row.event)}</div>
                <div style="font-size:11.5px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                  ${esc(row.artifact?.title || 'Artifact')}
                </div>
                <div style="font-size:11px;color:var(--text-3);margin-top:2px">
                  ${esc(row.actor)} · ${esc(timeAgo(row.at))}
                </div>
              </div>
            </div>`
                )
                .join('')
            : '<p style="font-size:13px;color:var(--text-2)">No activity recorded yet.</p>'
        }
        <p style="font-size:11px;color:var(--text-3);margin:14px 0 0;line-height:1.55">
          Anonymous viewers are never identified. Only events on artifacts you can access appear here.
        </p>
      </div>`
  })
}

// ---------------------------------------------------------------
// Workspaces and organizations (§28, §89)
// ---------------------------------------------------------------

ctx.openWorkspaceSheet = async (workspaceId) => {
  let detail = null
  let members = []
  try {
    ;[detail, members] = await Promise.all([
      api.workspace(workspaceId),
      api.workspaceMembers(workspaceId).catch(() => ({ members: [] }))
    ])
  } catch (error) {
    toast(error.message, 'error')
    return
  }

  const workspace = detail?.workspace
  const canManage = ['WORKSPACE_ADMIN', 'ORG_OWNER', 'ORG_ADMIN'].includes(workspace?.role)

  sheet({
    title: workspace?.name || 'Workspace',
    content: `
      <div>
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0">
          <span style="color:var(--text-2)">Type</span>
          <span style="font-weight:560">${esc(workspace?.type === 'PERSONAL' ? 'Personal' : 'Organization')}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0">
          <span style="color:var(--text-2)">Your role</span>
          <span style="font-weight:560">${esc(workspace?.role || 'VIEWER')}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0">
          <span style="color:var(--text-2)">Artifacts</span>
          <span style="font-weight:560">${detail?.counts?.artifacts ?? 0}</span>
        </div>
        ${
          workspace?.organization
            ? `<div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0">
                 <span style="color:var(--text-2)">Organization</span>
                 <span style="font-weight:560">${esc(workspace.organization.name)}</span>
               </div>`
            : ''
        }

        <div style="font-size:12.5px;font-weight:640;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin:18px 0 8px">
          Members
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${
            (members?.members || []).length
              ? (members.members || [])
                  .map(
                    (m) => `
            <div class="list-row" style="cursor:default">
              <div style="width:34px;height:34px;border-radius:999px;background:var(--surface-2);flex:none;
                display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600">
                ${esc((m.displayName || m.email || 'U').charAt(0).toUpperCase())}
              </div>
              <span style="flex:1;min-width:0">
                <span style="display:block;font-size:13.5px;font-weight:560;overflow:hidden;text-overflow:ellipsis">${esc(m.displayName || m.email)}</span>
                <span style="display:block;font-size:11.5px;color:var(--text-2)">${esc(m.role)}</span>
              </span>
              ${canManage ? `<button class="btn btn-ghost" data-ws-member="${esc(m.userId)}" style="min-height:36px;padding:0 8px" aria-label="Member options">${icon('more', 17)}</button>` : ''}
            </div>`
                  )
                  .join('')
              : '<p style="font-size:13px;color:var(--text-2)">No members listed.</p>'
          }
        </div>
      </div>`,
    actions: [
      {
        label: 'Switch to this workspace',
        variant: 'primary',
        keepOpen: true,
        onClick: () => {
          setState({ currentWorkspaceId: workspaceId })
          closeSheet()
          toast(`Now viewing ${workspace?.name || 'workspace'}`, 'success')
          void refresh({ reload: true })
        }
      },
      ...(canManage
        ? [
            {
              label: 'Add member',
              variant: 'secondary',
              keepOpen: true,
              onClick: () => ctx.openAddMemberSheet(workspaceId)
            }
          ]
        : [])
    ],
    onMount(handle) {
      handle.body.querySelectorAll('[data-ws-member]').forEach((button) => {
        button.addEventListener('click', () => ctx.openMemberSheet(button.dataset.wsMember, workspaceId))
      })
    }
  })
}

ctx.openAddMemberSheet = (workspaceId) => {
  sheet({
    title: 'Add member',
    content: `
      <div>
        ${field(
          'Email',
          '<input id="member-email" class="input" type="email" inputmode="email" placeholder="teammate@company.com">',
          'The person must already have an account. Adding someone does not notify them.'
        )}
        ${field(
          'Role',
          `<select id="member-role" class="input">
             <option value="VIEWER">Viewer — read only</option>
             <option value="CONTRIBUTOR" selected>Contributor — create and edit</option>
             <option value="WORKSPACE_ADMIN">Workspace admin — manage members</option>
           </select>`
        )}
      </div>`,
    actions: [
      {
        label: 'Add',
        variant: 'primary',
        keepOpen: true,
        onClick: async () => {
          const panel = document.querySelector('.sheet')
          const email = panel?.querySelector('#member-email')?.value?.trim()
          const role = panel?.querySelector('#member-role')?.value || 'VIEWER'
          if (!email) {
            toast('Enter an email address', 'error')
            return
          }

          const added = await attempt(
            () => api.addWorkspaceMember(workspaceId, email, role),
            'Member added'
          )
          if (added === null) return

          closeSheet()
          ctx.openWorkspaceSheet(workspaceId)
        }
      }
    ]
  })
}

ctx.openMemberSheet = (userId, workspaceId) => {
  sheet({
    title: 'Member options',
    content: `
      <div style="font-size:11.5px;font-weight:640;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">
        Change role
      </div>
      ${[
        ['VIEWER', 'Viewer — read only'],
        ['CONTRIBUTOR', 'Contributor — create and edit'],
        ['WORKSPACE_ADMIN', 'Workspace admin']
      ]
        .map(
          ([value, label]) => `
        <button class="row" data-set-role="${esc(value)}" style="padding:11px 0">
          <span style="flex:1;font-size:14px">${esc(label)}</span>
        </button>`
        )
        .join('')}`,
    actions: [
      {
        label: 'Remove from workspace',
        variant: 'danger',
        keepOpen: true,
        onClick: async () => {
          const removed = await attempt(
            () => api.removeWorkspaceMember(workspaceId, userId),
            'Member removed'
          )
          if (removed === null) return
          closeSheet()
          ctx.openWorkspaceSheet(workspaceId)
        }
      }
    ],
    onMount(handle) {
      handle.body.querySelectorAll('[data-set-role]').forEach((button) => {
        button.addEventListener('click', async () => {
          const updated = await attempt(
            () => api.updateWorkspaceMember(workspaceId, userId, button.dataset.setRole),
            'Role updated'
          )
          if (updated === null) return
          closeSheet()
          ctx.openWorkspaceSheet(workspaceId)
        })
      })
    }
  })
}

ctx.openOrgSheet = async (orgId) => {
  const org = (state.organizations || []).find((o) => o.id === orgId)
  const isAdmin = org?.role === 'ORG_OWNER' || org?.role === 'ORG_ADMIN'

  let analytics = null
  let members = []
  if (isAdmin) {
    try {
      ;[analytics, members] = await Promise.all([
        api.orgAnalytics(orgId, '30d'),
        api.orgMembers(orgId).catch(() => ({ members: [] }))
      ])
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  sheet({
    title: org?.name || 'Organization',
    content: `
      <div>
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0">
          <span style="color:var(--text-2)">Your role</span>
          <span style="font-weight:560">${esc(org?.role || 'MEMBER')}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0">
          <span style="color:var(--text-2)">Plan</span>
          <span style="font-weight:560">${esc(org?.plan || 'FREE')}</span>
        </div>

        ${
          analytics
            ? `
          <div class="thumbs" style="grid-template-columns:repeat(2,minmax(0,1fr));margin-top:14px">
            <div class="stat-tile"><div class="stat-value">${analytics.totals.artifacts}</div><div class="stat-label">Artifacts</div></div>
            <div class="stat-tile"><div class="stat-value">${analytics.totals.members}</div><div class="stat-label">Members</div></div>
            <div class="stat-tile"><div class="stat-value">${analytics.totals.views}</div><div class="stat-label">Views · 30d</div></div>
            <div class="stat-tile"><div class="stat-value">${analytics.totals.aiReferences}</div><div class="stat-label">AI references</div></div>
          </div>

          <div style="font-size:12.5px;font-weight:640;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin:18px 0 8px">
            Members
          </div>
          <div style="display:flex;flex-direction:column;gap:8px">
            ${
              (members?.members || []).length
                ? (members.members || [])
                    .map(
                      (m) => `
              <div style="display:flex;align-items:center;gap:10px;padding:6px 0">
                <span style="flex:1;min-width:0;font-size:13.5px;overflow:hidden;text-overflow:ellipsis">${esc(m.displayName || m.email)}</span>
                <span class="chip">${esc(m.role)}</span>
              </div>`
                    )
                    .join('')
                : '<p style="font-size:13px;color:var(--text-2)">No members listed.</p>'
            }
          </div>`
            : `<p style="font-size:12.5px;color:var(--text-3);margin:14px 0 0;line-height:1.55">
                 Organization analytics and member management are visible to organization admins.
               </p>`
        }
      </div>`,
    actions: [
      ...(isAdmin
        ? [
            { label: 'Administration', variant: 'primary', onClick: () => navigate('/admin') },
            { label: 'Add member', variant: 'secondary', keepOpen: true, onClick: () => ctx.openAddOrgMemberSheet(orgId) }
          ]
        : [])
    ]
  })
}

ctx.openAddOrgMemberSheet = (orgId) => {
  sheet({
    title: 'Add organization member',
    content: `
      <div>
        ${field(
          'Email',
          '<input id="org-member-email" class="input" type="email" inputmode="email" placeholder="teammate@company.com">',
          'The person must already have an account.'
        )}
        ${field(
          'Role',
          `<select id="org-member-role" class="input">
             <option value="MEMBER" selected>Member</option>
             <option value="ORG_ADMIN">Organization admin</option>
           </select>`
        )}
      </div>`,
    actions: [
      {
        label: 'Add',
        variant: 'primary',
        keepOpen: true,
        onClick: async () => {
          const panel = document.querySelector('.sheet')
          const email = panel?.querySelector('#org-member-email')?.value?.trim()
          const role = panel?.querySelector('#org-member-role')?.value || 'MEMBER'
          if (!email) {
            toast('Enter an email address', 'error')
            return
          }

          const added = await attempt(() => api.addOrgMember(orgId, email, role), 'Member added')
          if (added === null) return

          closeSheet()
          ctx.openOrgSheet(orgId)
        }
      }
    ]
  })
}

ctx.openCreateOrgSheet = () => {
  sheet({
    title: 'Create an organization',
    content: `
      <div>
        ${field(
          'Organization name',
          '<input id="org-name" class="input" type="text" placeholder="Acme Corporation">',
          'You become the owner. You can add workspaces and members afterwards.'
        )}
      </div>`,
    actions: [
      {
        label: 'Create',
        variant: 'primary',
        keepOpen: true,
        onClick: async () => {
          const panel = document.querySelector('.sheet')
          const name = panel?.querySelector('#org-name')?.value?.trim()
          if (!name) {
            toast('Enter a name', 'error')
            return
          }

          const created = await attempt(() => api.createOrganization(name), 'Organization created')
          if (created === null) return

          closeSheet()
          await refresh({ reload: true })
          navigate('/admin')
        }
      }
    ]
  })
}

ctx.openAdminMenuSheet = () => {
  sheet({
    title: 'Administration',
    content: `
      <button class="row" id="admin-opt-members">${icon('user', 19)} <span style="flex:1">Manage members</span></button>
      <button class="row" id="admin-opt-workspaces">${icon('building', 19)} <span style="flex:1">Manage workspaces</span></button>
      <button class="row" id="admin-opt-tags">${icon('tag', 19)} <span style="flex:1">Manage tags</span></button>
      <button class="row" id="admin-opt-orgs">${icon('building', 19)} <span style="flex:1">All organizations</span></button>
    `,
    onMount(handle) {
      handle.body.querySelector('#admin-opt-members')?.addEventListener('click', () => {
        const org = state.adminOrg
        if (!org) return
        closeSheet()
        const node = document.querySelector('[data-member]')
        node?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
      handle.body.querySelector('#admin-opt-workspaces')?.addEventListener('click', () => {
        closeSheet()
        const node = document.querySelector('#admin-workspaces-heading')
        node?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
      handle.body.querySelector('#admin-opt-tags')?.addEventListener('click', () => {
        closeSheet()
        ctx.openTagsSheet({ manage: true })
      })
      handle.body.querySelector('#admin-opt-orgs')?.addEventListener('click', () => {
        closeSheet()
        navigate('/profile')
      })
    }
  })
}

// ---------------------------------------------------------------
// Profile and identity (§89)
// ---------------------------------------------------------------

ctx.openEditNameSheet = () => {
  sheet({
    title: 'Edit display name',
    content: `
      <div>
        ${field(
          'Display name',
          `<input id="profile-name" class="input" type="text" value="${esc(state.me?.displayName || '')}">`,
          'This is how your name appears to people you share with.'
        )}
      </div>`,
    actions: [
      {
        label: 'Save',
        variant: 'primary',
        keepOpen: true,
        onClick: async () => {
          const panel = document.querySelector('.sheet')
          const displayName = panel?.querySelector('#profile-name')?.value?.trim()
          if (!displayName) {
            toast('Enter a name', 'error')
            return
          }

          const saved = await attempt(() => api.updateProfile(displayName), 'Name updated')
          if (saved === null) return

          setState({ me: { ...state.me, displayName } })
          closeSheet()
          void refresh({ reload: true })
        }
      }
    ]
  })
}

// ---------------------------------------------------------------
// Share management (§36, §40)
// ---------------------------------------------------------------

ctx.openShareManageSheet = async (shareId) => {
  let detail = null
  try {
    detail = await api.getShare(shareId)
  } catch (error) {
    toast(error.message, 'error')
    return
  }

  const share = detail?.share
  if (!share) {
    toast('Share not found', 'error')
    return
  }

  const recipients = detail.recipients || []
  const expired = share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now()

  sheet({
    title: 'Share settings',
    content: `
      <div>
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0">
          <span style="color:var(--text-2)">Item</span>
          <span style="font-weight:560;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${esc(share.title || share.targetId)}
          </span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0">
          <span style="color:var(--text-2)">Access</span>
          <span style="font-weight:560">${esc(share.accessType.replace('_', ' ').toLowerCase())}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0">
          <span style="color:var(--text-2)">Status</span>
          <span style="font-weight:560;color:${expired || share.status !== 'ACTIVE' ? 'var(--danger)' : 'var(--success)'}">
            ${esc(expired ? 'Expired' : share.status)}
          </span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0">
          <span style="color:var(--text-2)">Expires</span>
          <span style="font-weight:560">${share.expiresAt ? esc(formatDate(share.expiresAt)) : 'Never'}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0">
          <span style="color:var(--text-2)">Link prefix</span>
          <span style="font-weight:560;font-family:ui-monospace,monospace;font-size:11.5px">${esc(share.tokenPrefix)}…</span>
        </div>

        <div style="font-size:12.5px;font-weight:640;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin:18px 0 8px">
          Activity
        </div>
        <div style="display:flex;gap:10px;text-align:center">
          <div class="stat-tile" style="flex:1"><div class="stat-value" style="font-size:19px">${detail.activity?.opens ?? 0}</div><div class="stat-label">Opens</div></div>
          <div class="stat-tile" style="flex:1"><div class="stat-value" style="font-size:19px">${detail.activity?.views ?? 0}</div><div class="stat-label">Views</div></div>
          <div class="stat-tile" style="flex:1"><div class="stat-value" style="font-size:19px">${detail.activity?.denied ?? 0}</div><div class="stat-label">Denied</div></div>
        </div>

        ${
          recipients.length
            ? `<div style="font-size:12.5px;font-weight:640;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin:18px 0 8px">
                 Recipients
               </div>
               <div style="display:flex;flex-direction:column;gap:6px">
                 ${recipients
                   .map(
                     (r) => `
                   <div style="display:flex;justify-content:space-between;font-size:12.5px">
                     <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.recipient_value)}</span>
                     <span class="chip">${esc(r.recipient_type)}</span>
                   </div>`
                   )
                   .join('')}
               </div>`
            : ''
        }
      </div>`,
    actions: [
      {
        label: share.allowDownload ? 'Turn off downloads' : 'Allow downloads',
        variant: 'secondary',
        keepOpen: true,
        onClick: async () => {
          const updated = await attempt(() =>
            api.updateShare(shareId, { allowDownload: !share.allowDownload })
          )
          if (updated === null) return
          closeSheet()
          ctx.openShareManageSheet(shareId)
        }
      },
      {
        label: 'Revoke share',
        variant: 'danger',
        onClick: async () => {
          const revoked = await attempt(() => api.revokeShare(shareId), 'Share revoked')
          if (revoked === null) return
          void refresh({ reload: true })
        }
      }
    ]
  })
}

// ---------------------------------------------------------------
// Artifact menu, versions, share creation
// ---------------------------------------------------------------

ctx.openArtifactMenuSheet = (artifact) => {
  sheet({
    title: 'Artifact options',
    content: `
      <button class="row" id="art-share">${icon('share', 19)} <span style="flex:1">Share</span></button>
      ${
        artifact.canDownload
          ? `<button class="row" id="art-download">${icon('download', 19)} <span style="flex:1">Download</span></button>`
          : ''
      }
      ${
        artifact.canWrite
          ? `<button class="row" id="art-rename">${icon('file', 19)} <span style="flex:1">Rename</span></button>
             <button class="row" id="art-tags">${icon('tag', 19)} <span style="flex:1">Manage tags</span></button>
             <button class="row" id="art-newversion">${icon('upload', 19)} <span style="flex:1">Upload a new version</span></button>`
          : ''
      }
      <button class="row" id="art-copy">${icon('link', 19)} <span style="flex:1">Copy canonical link</span></button>
      <button class="row" id="art-analytics">${icon('chart', 19)} <span style="flex:1">View analytics</span></button>
      ${
        artifact.canWrite
          ? `<button class="row" id="art-delete" style="color:var(--danger)">${icon('trash', 19)} <span style="flex:1">Delete artifact</span></button>`
          : ''
      }
    `,
    onMount(handle) {
      handle.body.querySelector('#art-share')?.addEventListener('click', () =>
        ctx.openShareCreateSheet(artifact)
      )
      handle.body.querySelector('#art-download')?.addEventListener('click', () => {
        window.location.href = `/api/v1/artifacts/${encodeURIComponent(artifact.id)}/content?download=1`
        closeSheet()
      })
      handle.body.querySelector('#art-rename')?.addEventListener('click', () =>
        ctx.openEditNameSheetForArtifact(artifact)
      )
      handle.body.querySelector('#art-tags')?.addEventListener('click', () =>
        ctx.openTagsSheet({ artifact })
      )
      handle.body.querySelector('#art-newversion')?.addEventListener('click', () =>
        ctx.openVersionUploadSheet(artifact)
      )
      handle.body.querySelector('#art-copy')?.addEventListener('click', async () => {
        await copyText(`${window.location.origin}/a/${artifact.id}`)
      })
      handle.body.querySelector('#art-analytics')?.addEventListener('click', () =>
        ctx.openAnalyticsScreen(artifact.id)
      )
      handle.body.querySelector('#art-delete')?.addEventListener('click', () =>
        ctx.confirmDeleteArtifact(artifact)
      )
    }
  })
}

ctx.openEditNameSheetForArtifact = (artifact) => {
  sheet({
    title: 'Rename artifact',
    content: `
      <div>
        ${field('Title', `<input id="artifact-title" class="input" type="text" value="${esc(artifact.title)}">`)}
        ${field(
          'Description',
          `<textarea id="artifact-desc" class="input" placeholder="Optional">${esc(artifact.description || '')}</textarea>`
        )}
      </div>`,
    actions: [
      {
        label: 'Save',
        variant: 'primary',
        keepOpen: true,
        onClick: async () => {
          const panel = document.querySelector('.sheet')
          const title = panel?.querySelector('#artifact-title')?.value?.trim()
          const description = panel?.querySelector('#artifact-desc')?.value ?? ''
          if (!title) {
            toast('Title cannot be empty', 'error')
            return
          }

          const saved = await attempt(() =>
            api.updateArtifact(artifact.id, { title, description })
          )
          if (saved === null) return

          closeSheet()
          toast('Artifact updated', 'success')
          void refresh({ reload: true })
        }
      }
    ]
  })
}

ctx.confirmDeleteArtifact = (artifact) => {
  sheet({
    title: 'Delete artifact?',
    content: `
      <div>
        <p style="font-size:13.5px;color:var(--text-2);margin:0;line-height:1.55">
          "${esc(artifact.title)}" will be removed from your library and any shares for it will be revoked.
        </p>
      </div>`,
    actions: [
      {
        label: 'Delete',
        variant: 'danger',
        onClick: async () => {
          const deleted = await attempt(() => api.deleteArtifact(artifact.id), 'Artifact deleted')
          if (deleted === null) return
          navigate('/library')
        }
      }
    ]
  })
}

ctx.openVersionsSheet = (artifact) => {
  versionsSheet(ctx, artifact, ctx.detail.versions || [])
}

ctx.openVersionUploadSheet = (artifact) => {
  let file = null

  sheet({
    title: 'Upload a new version',
    content: `
      <div>
        ${field(
          'New file',
          `<label class="btn btn-secondary btn-block" style="cursor:pointer">
             ${icon('upload', 18)} Choose a file
             <input id="version-file" type="file" class="sr-only" accept="${ACCEPTED}">
           </label>
           <div id="version-filename" style="font-size:12.5px;color:var(--text-2);margin-top:8px">No file chosen</div>`
        )}
        ${field(
          'Change summary',
          '<input id="version-summary" class="input" type="text" placeholder="What changed?">'
        )}
      </div>
      <p style="font-size:11.5px;color:var(--text-3);margin:12px 0 0;line-height:1.55">
        Every previous version is preserved. The artifact's URL and identity never change.
      </p>`,
    actions: [
      {
        label: 'Upload version',
        variant: 'primary',
        keepOpen: true,
        onClick: async () => {
          const panel = document.querySelector('.sheet')
          file = file || panel?.querySelector('#version-file')?.files?.[0] || null
          if (!file) {
            toast('Choose a file first', 'error')
            return
          }

          const form = new FormData()
          form.append('file', file)
          const summary = panel?.querySelector('#version-summary')?.value?.trim()
          if (summary) form.append('changeSummary', summary)

          const result = await attempt(() => api.addVersion(artifact.id, form), 'New version added')
          if (result === null) return

          closeSheet()
          void refresh({ reload: true })
        }
      }
    ],
    onMount(handle) {
      const input = handle.body.querySelector('#version-file')
      const label = handle.body.querySelector('#version-filename')
      input?.addEventListener('change', () => {
        file = input.files?.[0] || null
        if (label) {
          label.textContent = file ? `${file.name} · ${formatBytes(file.size)}` : 'No file chosen'
        }
      })
    }
  })
}

ctx.openShareCreateSheet = (target) => {
  shareCreateSheet(ctx, target, () => {})
}

ctx.openShareResultSheet = (result, target) => {
  shareResultSheet(ctx, result, target)
}

// ---------------------------------------------------------------
// Global events
// ---------------------------------------------------------------

function attachGlobalHandlers() {
  // One delegated click handler covers every artifact card/row rendered by
  // any screen, so screens do not each need their own listener.
  document.addEventListener('click', (event) => {
    const navTarget = event.target.closest('[data-nav]')
    if (navTarget) {
      event.preventDefault()
      navigate(navTarget.dataset.nav)
      return
    }

    if (event.target.closest('#nav-add')) {
      event.preventDefault()
      ctx.openAddSheet()
      return
    }

    // Footer "Keyboard & tips" — one delegated hook serves every screen's footer
    if (event.target.closest('#footer-shortcuts')) {
      event.preventDefault()
      ctx.openShortcutsSheet()
      return
    }

    if (event.target.closest('#workspace-switcher')) {
      event.preventDefault()
      openWorkspaceSwitcher()
      return
    }

    const artifactTarget = event.target.closest('[data-artifact]')
    if (artifactTarget && !event.target.closest('[data-share-manage]')) {
      event.preventDefault()
      closeSheet()
      navigate(`/a/${encodeURIComponent(artifactTarget.dataset.artifact)}`)
    }
  })

  window.addEventListener('popstate', () => {
    currentRoute = parseRoute()
    void refresh({ reload: true })
  })

  // A 401 anywhere in the client means the session is gone; drop to sign-in
  // without losing the route so the user returns to where they were.
  window.addEventListener('app:unauthenticated', () => {
    if (currentRoute.name === 'share') return
    setState({ session: { authenticated: false, devMode: state.session.devMode }, me: null })
    render()
  })
}

function openWorkspaceSwitcher() {
  const workspaces = state.workspaces || []

  sheet({
    title: 'Switch workspace',
    content: `
      <div>
        ${workspaces
          .map(
            (w) => `
          <button class="row" data-switch="${esc(w.id)}" style="padding:12px 0">
            ${icon(w.type === 'PERSONAL' ? 'user' : 'building', 19)}
            <span style="flex:1;min-width:0">
              <span style="display:block;font-size:14px;font-weight:560">${esc(w.name)}</span>
              <span style="display:block;font-size:11.5px;color:var(--text-2)">
                ${esc(w.type === 'PERSONAL' ? 'Personal' : w.role || 'Member')}
              </span>
            </span>
            ${w.id === state.currentWorkspaceId ? icon('check', 18) : ''}
          </button>`
          )
          .join('')}
      </div>`,
    onMount(handle) {
      handle.body.querySelectorAll('[data-switch]').forEach((button) => {
        button.addEventListener('click', async () => {
          setState({ currentWorkspaceId: button.dataset.switch })
          closeSheet()
          await refresh({ reload: true })
        })
      })
    }
  })
}

// ---------------------------------------------------------------
// Start
// ---------------------------------------------------------------

async function start() {
  const root = document.getElementById('app')
  if (!root) return

  attachGlobalHandlers()

  // Optimistic first paint: show the shell immediately, then hydrate. For an
  // unauthenticated visitor the login screen is the only thing rendered.
  if (!boot.authenticated && currentRoute.name !== 'share') {
    setState({ session: { authenticated: false, devMode: false } })
    render()

    const okToRender = await loadShellData().catch(() => false)
    if (!okToRender) {
      setState({ session: { authenticated: false, devMode: state.session.devMode } })
      render()
      return
    }
  }

  await refresh({ reload: true })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start)
} else {
  void start()
}
