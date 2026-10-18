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

import { api, getState, setState, AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from './api.js'
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
  spinner,
  brandLockup,
  brandUrl,
  avatar,
  roleLabel,
  setRegional
} from './ui.js'
import { renderWorkspaceManage, renderJoin, pickPicture } from './workspace.js'
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
import { renderConnect, renderHandoffs, renderHandoff, openHandoffSheet } from './handoffs.js'

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
  guide: 'guide',
  connect: 'connect',
  handoffs: 'handoffs'
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

  if (segments[0] === 'workspace') {
    return { name: 'workspace', workspaceId: segments[1] ? decodeURIComponent(segments[1]) : null }
  }

  if (segments[0] === 'join' && segments[1]) {
    return { name: 'join', token: decodeURIComponent(segments[1]) }
  }

  if (segments[0] === 'h' && segments[1]) {
    return { name: 'handoff', handoffId: decodeURIComponent(segments[1]) }
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
  // sort: created (newest first) | oldest | updated | title.
  // collectionId narrows the library to one collection of the current workspace.
  filters: { type: 'all', q: '', sort: 'created', collectionId: null },
  // Home's two rows, each its own listing so filters elsewhere never change them.
  home: { viewed: [], added: [] },
  search: { query: '', results: [], total: 0, performed: false, loading: false, engine: null, activeFilters: [] },
  detail: { loading: false, artifact: null, versions: [], analytics: null, indexState: null },
  analyticsView: { loading: false, data: null, artifactId: null, title: null },
  // Library selection mode: which artifacts are ticked for a bulk action.
  selection: { active: false, ids: new Set() },
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
  adminProviderStats: [],
  // Workspace management screen and the invitation join page.
  wm: { loading: false, workspaceId: null, manage: null, directory: null, shareDomain: null, lastInvite: null },
  join: { token: null, loading: false, info: null, result: null, workspaceId: null }
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
    case 'workspace':
      return renderWorkspaceManage(ctx)
    case 'join':
      return renderJoin(ctx)
    case 'artifact':
      return renderArtifactDetail(ctx)
    case 'analytics':
      return renderAnalytics(ctx)
    case 'share':
      return renderShareRecipient(ctx)
    case 'guide':
      return renderGuide(ctx)
    case 'connect':
      return renderConnect(ctx)
    case 'handoffs':
      return renderHandoffs(ctx)
    case 'handoff':
      return renderHandoff(ctx)
    default:
      return renderHome(ctx)
  }
}

function render() {
  const root = document.getElementById('app')
  if (!root) return

  // Dates follow the regional settings of the workspace being viewed.
  const current = (state.workspaces || []).find((w) => w.id === state.currentWorkspaceId)
  setRegional(current?.regional)

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
  // Selection belongs to the library screen; leaving it ends selection.
  if (currentRoute.name !== 'library') ctx.clearSelection({ render: false })
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

async function loadArtifacts({ workspaceId, collectionId = ctx.filters.collectionId, sort = ctx.filters.sort } = {}) {
  const result = await api.listArtifacts({
    workspaceId: workspaceId ?? state.currentWorkspaceId ?? undefined,
    // Groups of extensions are filtered on the page; one extension by the server.
    type: ctx.filters.type && !['all', 'image', 'audio', 'video'].includes(ctx.filters.type)
      ? ctx.filters.type
      : undefined,
    collectionId: collectionId || undefined,
    sort,
    limit: 60
  })
  setState({ artifacts: result?.artifacts || [] })
  return result
}

/** Home: what this person opened last, and what was saved last, in this workspace. */
async function loadHomeLists() {
  const workspaceId = state.currentWorkspaceId || undefined
  const [viewed, added] = await Promise.all([
    api.listArtifacts({ workspaceId, sort: 'viewed', limit: 4 }).catch(() => null),
    api.listArtifacts({ workspaceId, sort: 'created', limit: 4 }).catch(() => null)
  ])
  ctx.home = { viewed: viewed?.artifacts || [], added: added?.artifacts || [] }
}

/** Library search: a query goes to the search index, otherwise a plain listing. */
async function runLibraryQuery() {
  const query = (ctx.filters.q || '').trim()
  if (query.length >= 2) {
    const result = await api.search({
      query,
      workspaceIds: state.currentWorkspaceId ? [state.currentWorkspaceId] : undefined,
      collectionIds: ctx.filters.collectionId ? [ctx.filters.collectionId] : undefined,
      limit: 60
    })
    const hits = (result?.results || []).map((hit) => ({
      ...hit,
      isOwner: true,
      tags: hit.tags || []
    }))
    // Matches keep relevance order unless the person chose a date order.
    const byCreated = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
    if (ctx.filters.sort === 'created') hits.sort((a, b) => byCreated(b, a))
    if (ctx.filters.sort === 'oldest') hits.sort(byCreated)
    setState({ artifacts: hits })
    return
  }
  await loadArtifacts()
}

ctx.runLibraryQuery = runLibraryQuery

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

  // /login and /signup are entry points from the marketing site; once signed
  // in there is nothing to show at those addresses, so land on Home.
  if (/^\/(login|signup)\/?$/.test(window.location.pathname)) {
    window.history.replaceState({}, '', '/')
    currentRoute = parseRoute('/')
  }

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
    case 'home': {
      await Promise.all([
        loadArtifacts({ collectionId: null, sort: 'updated' }),
        loadHomeLists(),
        loadIntegrations(),
        loadHandoffs()
      ])
      break
    }
    case 'library': {
      // A collection filter from another workspace means nothing here.
      const collections = await loadCollections()
      if (ctx.filters.collectionId && !collections.some((col) => col.id === ctx.filters.collectionId)) {
        ctx.filters.collectionId = null
      }
      await Promise.all([runLibraryQuery(), loadIntegrations()])
      break
    }
    case 'connect': {
      await loadIntegrations()
      break
    }
    case 'handoffs': {
      await loadHandoffs(ctx.handoffsShowClosed ? 'all' : undefined)
      break
    }
    case 'handoff': {
      if (ctx.handoffView?.id !== route.handoffId) ctx.handoffView = { id: route.handoffId, loading: true }
      try {
        const result = await api.handoff(route.handoffId)
        ctx.handoffView = { id: route.handoffId, loading: false, ...result }
      } catch (error) {
        ctx.handoffView = { id: route.handoffId, loading: false, error: error.message || 'Handoff not found' }
      }
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
      const [profile] = await Promise.all([api.profile(), loadAccess()])
      setState({ profile })
      break
    }
    case 'admin': {
      await loadAdminData()
      break
    }
    case 'workspace': {
      await loadWorkspaceManage(route.workspaceId)
      break
    }
    case 'join': {
      if (ctx.join.token !== route.token) {
        ctx.join = { token: route.token, loading: true, info: null, result: null, workspaceId: null }
      }
      try {
        ctx.join.info = await api.invitation(route.token)
      } finally {
        ctx.join.loading = false
      }
      break
    }
    case 'artifact': {
      ctx.detail.loading = true
      ctx.detail.artifact = null
      ctx.detail.versions = []
      ctx.detail.analytics = null
      ctx.detail.indexState = null
      render()
      try {
        const [detail, analytics, indexState] = await Promise.all([
          api.getArtifact(route.artifactId),
          api.analytics(route.artifactId, '30d').catch(() => null),
          api.indexState(route.artifactId)
        ])
        ctx.detail.artifact = detail?.artifact || null
        ctx.detail.versions = detail?.versions || []
        ctx.detail.analytics = analytics
        ctx.detail.indexState = indexState
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
    setState({
      integrations: result?.integrations || [],
      mcpEndpoint: result?.mcpEndpoint || null,
      connectedTools: result?.connectedTools || []
    })
  } catch {
    /* connector list is supplementary */
  }
}

/** OAuth sign-ins and personal access tokens, for Profile. */
async function loadAccess() {
  try {
    setState({ access: await api.access() })
  } catch {
    setState({ access: null })
  }
}

async function loadHandoffs(status) {
  try {
    const result = await api.handoffs({ status })
    setState({ handoffs: result?.handoffs || [] })
  } catch {
    /* handoffs are supplementary on Home */
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

/**
 * Workspace management: the workspace named in the URL, else the one being
 * viewed, else the first shared workspace this person can manage, else any
 * workspace. Personal workspaces get identity, regional and invitations.
 */
async function loadWorkspaceManage(requestedId) {
  const workspaces = state.workspaces || []
  const org = workspaces.filter((w) => w.type !== 'PERSONAL')
  const current = workspaces.find((w) => w.id === state.currentWorkspaceId)
  const id = requestedId || current?.id || org.find((w) => w.canManage)?.id || workspaces[0]?.id || null

  if (ctx.wm.workspaceId !== id) {
    ctx.wm = { loading: true, workspaceId: id, manage: null, directory: null, shareDomain: null, lastInvite: null }
  }
  if (!id) {
    ctx.wm.loading = false
    return
  }
  if (!requestedId) window.history.replaceState({}, '', `/workspace/${encodeURIComponent(id)}`)

  try {
    const manage = await api.workspaceManage(id)
    const isOrg = manage.workspace.type !== 'PERSONAL'
    const [directory, shareDomain] = await Promise.all([
      isOrg && manage.workspace.canManageMembers ? api.workspaceDirectory(id).catch(() => null) : null,
      // Supplementary: the screen renders without it.
      isOrg ? api.shareDomain(id).catch(() => null) : null
    ])
    Object.assign(ctx.wm, { manage, directory, shareDomain })
  } catch (error) {
    ctx.wm.manage = null
    if (error?.status !== 403 && error?.status !== 404) throw error
  } finally {
    ctx.wm.loading = false
  }
}

// ---------------------------------------------------------------
// ctx: navigation and shell affordances
// ---------------------------------------------------------------

ctx.navigate = navigate

ctx.goBack = goBack

ctx.copyText = (value) => copyText(value)

ctx.closeSheet = closeSheet

ctx.openHandoffSheet = (artifact) => openHandoffSheet(ctx, artifact)

/**
 * Re-render the current route from data already in memory.
 *
 * Cheap and correct only for changes that are purely presentational. It does
 * NOT re-fetch, so it must never be used after a write: the rendered output
 * would reflect the new server state while the cached data still described the
 * old one. That is not hypothetical — it made the Interactive Preview toggle
 * show "ON" while its iframe kept the Safe preview descriptor, i.e. the UI
 * claimed scripts would run and they would not.
 *
 * Use `ctx.reload()` after a mutation instead.
 */
ctx.refresh = () => refresh({ reload: false })

/** Re-fetch the current route's data, then re-render. Use after a write. */
ctx.reload = () => refresh({ reload: true })

ctx.clearSelection = ({ render: rerender = true } = {}) => {
  ctx.selection.active = false
  ctx.selection.ids.clear()
  if (rerender) void refresh()
}

/** Re-fetch the signed-in shell (names, logos, pictures, regional) and the route. */
ctx.reloadShell = async () => {
  await loadShellData()
  await refresh({ reload: true })
}

ctx.selectWorkspace = (workspaceId) => setState({ currentWorkspaceId: workspaceId })
ctx.pickPicture = pickPicture

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
  ctx.detail = { loading: false, artifact: null, versions: [], analytics: null, indexState: null }
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

/**
 * The active workspace's logo (or initial) and name, shown on the desktop rail
 * under the Artifactry logo. It opens that workspace's settings screen.
 */
function railWorkspace() {
  const current = (state.workspaces || []).find((w) => w.id === state.currentWorkspaceId)
  if (!current) return ''
  const kind = current.type === 'PERSONAL' ? 'Personal workspace' : 'Shared workspace'
  return `
    <button class="rail-workspace nav-rail-only" data-nav="/workspace/${encodeURIComponent(current.id)}"
            aria-label="${esc(`${current.name}, ${kind.toLowerCase()} settings`)}" title="${esc(current.name)}">
      ${avatar({ url: current.logoUrl, name: current.name, size: 32 })}
      <span class="rail-workspace-text">
        <span class="rail-workspace-name">${esc(current.name)}</span>
        <span class="rail-workspace-kind">${kind}</span>
      </span>
    </button>`
}

ctx.bottomNav = (active) => `
  <nav class="bottom-nav" aria-label="Primary navigation">
    <a class="rail-brand" href="/" data-nav="/" aria-label="Artifactry home">${brandLockup(32)}</a>
    ${railWorkspace()}
    ${navItem('home', '/', 'Home', 'home', active)}
    ${navItem('library', '/library', 'Library', 'library', active)}
    <button class="nav-item" id="nav-add" aria-label="Add to library">
      <span class="nav-add">${icon('plus', 22)}</span>
      <span>Add</span>
    </button>
    ${navItem('search', '/search', 'Search', 'search', active)}
    ${navItem('profile', '/profile', 'Profile', 'user', active)}
    ${navItem('workspace', '/workspace', 'Workspace', 'building', active).replace('class="nav-item"', 'class="nav-item nav-rail-only"')}
    <button class="nav-item nav-rail-only rail-logout" id="nav-logout">
      ${icon('logout', 21)}
      <span>Log out</span>
    </button>
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
      ${icon('chevronDown', 12)}
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
    const types =
      filters.type === 'image'
        ? ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp']
        : filters.type === 'audio'
          ? AUDIO_EXTENSIONS
        : filters.type === 'video'
          ? VIDEO_EXTENSIONS
        : filters.type === 'html'
          ? ['html', 'htm']
          : filters.type === 'text'
            ? ['md', 'markdown', 'txt']
            : filters.type
              ? [filters.type]
              : undefined
    const result = await api.search({
      query,
      filters,
      types,
      sort: filters.sort,
      madeBy: filters.madeBy,
      limit: 40
    })
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
    ['image', 'Image'],
    ['audio', 'Audio'],
    ['video', 'Video'],
    ['text', 'Notes (Markdown, text)']
  ]
  const makers = [
    ['', 'Anyone'],
    ['claude', 'Claude'],
    ['chatgpt', 'ChatGPT'],
    ['cursor', 'Cursor'],
    ['gemini', 'Gemini'],
    ['web', 'Uploaded by a person']
  ]
  const currentMaker = ctx.search.activeFilters.find((f) => f.key === 'madeBy')?.value || ''

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

        <div style="font-size:12.5px;font-weight:640;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin:18px 0 8px">Made by</div>
        ${makers
          .map(
            ([value, label]) => `
          <label class="row" style="gap:11px;padding:11px 0">
            <input type="radio" name="filter-maker" value="${esc(value)}" ${currentMaker === value ? 'checked' : ''}
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

          const maker = panel?.querySelector('input[name="filter-maker"]:checked')?.value || ''

          ctx.search.activeFilters = ctx.search.activeFilters.filter(
            (f) => f.key !== 'type' && f.key !== 'sort' && f.key !== 'madeBy'
          )
          if (maker) {
            const label = makers.find(([value]) => value === maker)?.[1] || maker
            ctx.search.activeFilters.push({ key: 'madeBy', value: maker, label: `Made by: ${label}` })
          }
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

/**
 * Preview URL for a shared HTML artifact.
 *
 * Uses the server's `preview` descriptor when present: for an Interactive
 * artifact that is a short-lived signed document URL on the isolated preview
 * origin, and for a Safe artifact it is the same-origin Safe path. Falling back
 * to the same-origin path keeps older links working and is always Safe.
 */
ctx.sharePreviewUrl = (artifactId, shareView) => {
  const preview = shareView && shareView.preview
  if (preview && (preview.url || preview.fallbackUrl)) return preview.url || preview.fallbackUrl
  return `/api/v1/shares/${encodeURIComponent(ctx.shareToken)}/preview?artifactId=${encodeURIComponent(artifactId)}`
}

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

const ACCEPTED =
  '.pptx,.pdf,.docx,.html,.htm,.png,.jpg,.jpeg,.bmp,.gif,.webp,' +
  // Audio (up to 20 MB) and video (up to 200 MB)
  [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS].map((ext) => `.${ext},`).join('') +
  // Notes, data and code (stored and shown as plain text)
  '.txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.toml,.ini,.log,.js,.mjs,.cjs,.jsx,.ts,.tsx,.py,.rb,.go,.rs,' +
  '.java,.kt,.swift,.c,.h,.cpp,.hpp,.cs,.php,.sql,.sh,.css,.scss,.graphql,.proto'

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

// ---------------------------------------------------------------
// Interactive Preview at upload. New HTML artifacts start with it ON; the
// switch lets the uploader start in Safe Preview instead. The server applies
// the same default when the field is absent.
// ---------------------------------------------------------------

const INTERACTIVE_ON = 'Interactive Preview is ON — uploaded JavaScript runs in the isolated sandbox.'
const INTERACTIVE_OFF = 'Interactive Preview is OFF — Safe Preview renders HTML and CSS with JavaScript disabled.'

function interactiveToggleField(prefix, { label = 'HTML preview', hidden = false } = {}) {
  return `
    <div id="${prefix}-interactive-field" style="margin-bottom:14px${hidden ? ';display:none' : ''}">
      <label style="font-size:13px;font-weight:600;display:block;margin-bottom:6px">${esc(label)}</label>
      <label class="row" style="padding:10px 12px;border:1px solid var(--border);border-radius:12px;cursor:pointer;gap:10px;align-items:flex-start;box-sizing:border-box;min-height:0">
        <input type="checkbox" id="${prefix}-interactive" checked
          style="width:18px;height:18px;margin:1px 0 0;accent-color:var(--accent);flex:none">
        <span style="flex:1;min-width:0">
          <span style="display:block;font-size:14px;font-weight:560">Interactive Preview</span>
          <span id="${prefix}-interactive-note" style="display:block;font-size:12px;color:var(--text-2);line-height:1.5;margin-top:2px">${esc(INTERACTIVE_ON)}</span>
        </span>
      </label>
    </div>`
}

function mountInteractiveToggle(root, prefix) {
  const box = root.querySelector(`#${prefix}-interactive`)
  const note = root.querySelector(`#${prefix}-interactive-note`)
  box?.addEventListener('change', () => {
    if (note) note.textContent = box.checked ? INTERACTIVE_ON : INTERACTIVE_OFF
  })
}

function showInteractiveToggle(root, prefix, visible) {
  const host = root?.querySelector(`#${prefix}-interactive-field`)
  if (host) host.style.display = visible ? '' : 'none'
}

function interactiveChosen(root, prefix) {
  return root?.querySelector(`#${prefix}-interactive`)?.checked !== false
}

const isHtmlName = (name) => /\.html?$/i.test(name || '')

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
          'PPTX, PDF, DOCX, HTML, images, text, audio (up to 20 MB) or video (up to 200 MB).'
        )}
        ${interactiveToggleField('upload', { hidden: true })}
        ${field(
          'Workspace',
          `<select id="upload-workspace" class="input">${workspaceOptions()}</select>`
        )}
        ${field(
          'Title',
          '<input id="upload-title" class="input" type="text" placeholder="Optional — defaults to the filename">'
        )}
        ${collectionPickerField('upload')}
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
          const collectionIds = pickedCollections(panel, 'upload')
          if (collectionIds.length) form.append('collectionIds', collectionIds.join(','))
          if (isHtmlName(file.name)) form.append('interactiveHtml', String(interactiveChosen(panel, 'upload')))

          if (button) {
            button.disabled = true
            button.innerHTML = busyButton('Upload', 'upload', 'Uploading…')
          }

          // Audio and video go up in parts, so show how far along they are.
          const onProgress = (share) => {
            if (button) button.innerHTML = busyButton('Upload', 'upload', `Uploading… ${Math.floor(share * 100)}%`)
          }
          const result = await attempt(() => api.uploadArtifact(form, { onProgress }))
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
      mountCollectionPicker(handle.body, 'upload', '#upload-workspace')
      mountInteractiveToggle(handle.body, 'upload')
      const input = handle.body.querySelector('#upload-file')
      const label = handle.body.querySelector('#upload-filename')

      input?.addEventListener('change', () => {
        file = input.files?.[0] || null
        showInteractiveToggle(handle.body, 'upload', isHtmlName(file?.name))
        if (label) {
          label.textContent = file
            ? `${file.name} · ${formatBytes(file.size)}`
            : 'No file chosen'
        }
      })
    }
  })
}

const BULK_UPLOAD_MAX = 50

/**
 * Many files at once into the collection the library is showing. Each file is
 * named after itself and keeps the tags the system generates for it; HTML
 * files follow the Interactive Preview switch (on by default). Files go up
 * one at a time and one failure does not stop the rest. A batch is capped at
 * 50 files, inside the 60-uploads-per-5-minutes limit on the upload endpoint.
 */
ctx.openBulkUploadSheet = (collection) => {
  if (!collection) return
  let files = []
  let running = false

  const queueRow = (f, i) => `
    <div class="upload-queue-row" data-row="${i}">
      ${icon('file', 16)}
      <span class="upload-queue-name">${esc(f.name)}</span>
      <span class="upload-queue-state" data-state="${i}">${esc(formatBytes(f.size))}</span>
    </div>`

  sheet({
    title: `Upload to ${collection.name}`,
    content: `
      <div>
        <label class="drop-zone" id="bulk-drop" style="display:block;cursor:pointer">
          ${icon('upload', 22)}
          <div style="font-size:14px;font-weight:600;color:var(--text);margin-top:6px">Choose files or drop them here</div>
          <div style="margin-top:3px">Each file is named after itself and tagged automatically.</div>
          <input id="bulk-files" type="file" class="sr-only" multiple accept="${ACCEPTED}">
        </label>
        <div class="upload-queue" id="bulk-queue"></div>
        <div style="margin-top:14px">${interactiveToggleField('bulk', { label: 'HTML files', hidden: true })}</div>
      </div>`,
    actions: [
      {
        label: 'Upload',
        variant: 'primary',
        keepOpen: true,
        onClick: async () => {
          const panel = document.querySelector('.sheet')
          const button = panel?.querySelector('#sheet-actions .btn-primary')
          if (running) return
          if (!files.length) {
            toast('Choose some files first', 'error')
            return
          }
          running = true
          if (button) {
            button.disabled = true
            button.innerHTML = busyButton('Upload', 'upload', 'Uploading…')
          }
          const interactive = interactiveChosen(panel, 'bulk')
          let done = 0
          let failed = 0
          for (let i = 0; i < files.length; i++) {
            const stateEl = panel?.querySelector(`[data-state="${i}"]`)
            if (stateEl) {
              stateEl.className = 'upload-queue-state'
              stateEl.textContent = 'Uploading…'
            }
            const form = new FormData()
            form.append('file', files[i])
            form.append('workspaceId', collection.workspaceId || state.currentWorkspaceId || '')
            form.append('collectionIds', collection.id)
            form.append('acceptSuggestedTags', 'true')
            if (isHtmlName(files[i].name)) form.append('interactiveHtml', String(interactive))
            try {
              await api.uploadArtifact(form, {
                onProgress: (share) => {
                  if (stateEl) stateEl.textContent = `Uploading… ${Math.floor(share * 100)}%`
                }
              })
              done++
              if (stateEl) {
                stateEl.className = 'upload-queue-state is-done'
                stateEl.textContent = 'Added'
              }
            } catch (error) {
              failed++
              if (stateEl) {
                stateEl.className = 'upload-queue-state is-error'
                stateEl.textContent = error?.message || 'Failed'
                stateEl.title = error?.message || ''
              }
            }
          }
          running = false
          toast(
            `Added ${done} file${done === 1 ? '' : 's'} to ${collection.name}${failed ? ` · ${failed} failed` : ''}`,
            failed && !done ? 'error' : 'success'
          )
          await loadCollections()
          if (!failed) closeSheet()
          else if (button) {
            // Leave the sheet open on the failures so the reasons stay readable.
            files = []
            button.disabled = false
            button.textContent = 'Upload'
          }
          void refresh({ reload: true })
        }
      }
    ],
    onMount(handle) {
      mountInteractiveToggle(handle.body, 'bulk')
      const input = handle.body.querySelector('#bulk-files')
      const drop = handle.body.querySelector('#bulk-drop')
      const queue = handle.body.querySelector('#bulk-queue')
      const take = (list) => {
        if (running) return
        files = [...list].slice(0, BULK_UPLOAD_MAX)
        queue.innerHTML = files.map(queueRow).join('')
        showInteractiveToggle(handle.body, 'bulk', files.some((f) => isHtmlName(f.name)))
        if (list.length > BULK_UPLOAD_MAX) {
          toast(`Up to ${BULK_UPLOAD_MAX} files at a time; the first ${BULK_UPLOAD_MAX} are queued`, 'error')
        }
      }
      input?.addEventListener('change', () => take(input.files || []))
      drop?.addEventListener('dragover', (e) => {
        e.preventDefault()
        drop.classList.add('is-over')
      })
      drop?.addEventListener('dragleave', () => drop.classList.remove('is-over'))
      drop?.addEventListener('drop', (e) => {
        e.preventDefault()
        drop.classList.remove('is-over')
        take(e.dataTransfer?.files || [])
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
        ${interactiveToggleField('content')}
        ${field(
          'Content',
          `<textarea id="content-body" class="input" placeholder="<!doctype html>…"></textarea>`
        )}
        ${field(
          'Workspace',
          `<select id="content-workspace" class="input">${workspaceOptions()}</select>`
        )}
        ${collectionPickerField('content')}
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
              workspaceId,
              collectionIds: pickedCollections(panel, 'content'),
              interactiveHtml: interactiveChosen(panel, 'content')
            })
          )
          if (!result) return

          closeSheet()
          toast('Artifact saved', 'success')
          await loadArtifacts()
          navigate(`/a/${encodeURIComponent(result.artifact.id)}`)
        }
      }
    ],
    onMount(handle) {
      mountCollectionPicker(handle.body, 'content', '#content-workspace')
      mountInteractiveToggle(handle.body, 'content')
      const filename = handle.body.querySelector('#content-filename')
      filename?.addEventListener('input', () => showInteractiveToggle(handle.body, 'content', isHtmlName(filename.value)))
    }
  })
}

// ---------------------------------------------------------------
// Choosing collections while saving
//
// The picker lists the collections of whichever workspace is selected in the
// same sheet, and can create one on the spot. Selection lives on the chips
// (aria-pressed) so the sheet's submit handler reads it straight from the DOM.
// ---------------------------------------------------------------

function collectionPickerField(prefix) {
  return field(
    'Collection',
    `<div id="${prefix}-collections" class="collection-picker" role="group" aria-label="Collection">
       <span style="font-size:12.5px;color:var(--text-3)">Loading collections…</span>
     </div>`,
    'Optional. A file sits in one collection.'
  )
}

function pickedCollections(root, prefix) {
  return [...(root?.querySelectorAll(`#${prefix}-collections [data-pick][aria-pressed="true"]`) || [])].map(
    (chip) => chip.dataset.pick
  )
}

function collectionChip(collection, pressed) {
  return `<button type="button" class="chip-toggle" data-pick="${esc(collection.id)}" aria-pressed="${pressed}">
      ${icon(pressed ? 'check' : 'folder', 13)} ${esc(collection.name)}
    </button>`
}

function mountCollectionPicker(root, prefix, workspaceSelector) {
  const host = root.querySelector(`#${prefix}-collections`)
  const select = root.querySelector(workspaceSelector)
  if (!host) return
  // One collection at most: picking a chip replaces the previous pick, and
  // picking the chosen one again clears it.
  const selected = new Set()

  const paint = (collections) => {
    host.innerHTML = `
      ${collections.map((col) => collectionChip(col, selected.has(col.id))).join('')}
      <button type="button" class="chip-toggle chip-new" data-new-collection>${icon('plus', 13)} New collection</button>`
    host.querySelectorAll('[data-pick]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const id = chip.dataset.pick
        const was = selected.has(id)
        selected.clear()
        if (!was) selected.add(id)
        paint(collections)
      })
    })
    host.querySelector('[data-new-collection]')?.addEventListener('click', (event) => {
      const button = event.currentTarget
      button.outerHTML = `
        <span class="chip-new-form">
          <input class="input" type="text" data-new-name placeholder="Collection name" aria-label="New collection name"
            style="min-height:34px;padding:0 10px;font-size:13px;width:170px">
          <button type="button" class="btn btn-secondary" data-new-save style="min-height:34px;padding:0 12px;font-size:13px">Add</button>
        </span>`
      const input = host.querySelector('[data-new-name]')
      const save = async () => {
        const name = input?.value?.trim()
        if (!name) return
        const created = await attempt(() => api.createCollection({ name, workspaceId: select?.value }))
        if (!created?.collection) return
        selected.clear()
        selected.add(created.collection.id)
        collections.push({ id: created.collection.id, name })
        paint(collections)
        if (select?.value === state.currentWorkspaceId) void loadCollections()
      }
      host.querySelector('[data-new-save]')?.addEventListener('click', save)
      input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          void save()
        }
      })
      input?.focus()
    })
  }

  const load = async () => {
    selected.clear()
    // Saving from a filtered library files into that collection by default.
    if (select?.value === state.currentWorkspaceId && ctx.filters.collectionId) selected.add(ctx.filters.collectionId)
    try {
      const result = await api.collections(select?.value || undefined)
      paint(result?.collections || [])
    } catch {
      paint([])
    }
  }

  select?.addEventListener('change', load)
  void load()
}

/**
 * Choose the one collection for a set of artifacts (one or many) in a
 * workspace: an existing collection, a new one, or none. Applying moves every
 * artifact out of whatever collection it was in.
 */
async function openCollectionChooser({ title, intro, workspaceId, artifacts, currentId = null }) {
  let collections = []
  try {
    const result = await api.collections(workspaceId)
    collections = result?.collections || []
  } catch (error) {
    toast(error.message, 'error')
    return
  }

  const option = (value, label, meta, checked) => `
    <label class="row" style="padding:11px 0;cursor:pointer">
      <input type="radio" name="collection-choice" value="${esc(value)}" ${checked ? 'checked' : ''}
        style="width:18px;height:18px;margin:0;accent-color:var(--accent)">
      <span style="flex:1;min-width:0">
        <span style="display:block;font-size:14px;font-weight:560">${label}</span>
        ${meta ? `<span style="display:block;font-size:11.5px;color:var(--text-2)">${meta}</span>` : ''}
      </span>
    </label>`

  sheet({
    title,
    content: `
      <p style="font-size:13px;color:var(--text-2);margin:0 0 6px;line-height:1.5">${intro}</p>
      <div id="collection-choices">
        ${collections
          .map((col) =>
            option(
              col.id,
              `${icon('folder', 15)} ${esc(col.name)}`,
              `${col.artifactCount} artifact${col.artifactCount === 1 ? '' : 's'}${col.id === currentId ? ' · current' : ''}`,
              col.id === currentId
            )
          )
          .join('')}
        ${option('__new', `${icon('plus', 15)} New collection`, '', !collections.length)}
        <div id="collection-new-wrap" style="padding:0 0 8px 30px;${collections.length ? 'display:none' : ''}">
          <input id="collection-new-name" class="input" type="text" placeholder="Collection name" aria-label="New collection name">
        </div>
        ${option('', 'No collection', 'Take them out of their collection', false)}
      </div>`,
    actions: [
      {
        label: 'Apply',
        variant: 'primary',
        keepOpen: true,
        onClick: async () => {
          const panel = document.querySelector('.sheet')
          const picked = panel?.querySelector('input[name="collection-choice"]:checked')
          if (!picked) {
            toast('Choose a collection', 'error')
            return
          }
          let collectionId = picked.value || null
          let name = collections.find((col) => col.id === collectionId)?.name
          if (collectionId === '__new') {
            name = panel.querySelector('#collection-new-name')?.value?.trim()
            if (!name) {
              toast('Give the collection a name', 'error')
              return
            }
            const created = await attempt(() => api.createCollection({ name, workspaceId }))
            if (!created?.collection) return
            collectionId = created.collection.id
          }
          const ids = artifacts.map((a) => a.id)
          const result = await attempt(() => api.bulkSetCollection(ids, collectionId))
          if (!result) return
          const count = result.moved === 1 ? '1 artifact' : `${result.moved} artifacts`
          const skipped = result.skipped?.length ? ` · ${result.skipped.length} skipped` : ''
          toast(collectionId ? `Moved ${count} to ${name}${skipped}` : `Took ${count} out of their collection${skipped}`, 'success')
          closeSheet()
          ctx.clearSelection({ render: false })
          await loadCollections()
          void refresh({ reload: true })
        }
      }
    ],
    onMount(handle) {
      const wrap = handle.body.querySelector('#collection-new-wrap')
      handle.body.querySelectorAll('input[name="collection-choice"]').forEach((radio) => {
        radio.addEventListener('change', () => {
          const isNew = radio.value === '__new' && radio.checked
          if (wrap) wrap.style.display = isNew ? '' : 'none'
          if (isNew) handle.body.querySelector('#collection-new-name')?.focus()
        })
      })
    }
  })
}

/** The one collection an artifact is in, chosen from its page. */
ctx.openArtifactCollectionsSheet = (artifact) =>
  openCollectionChooser({
    title: 'Collection',
    intro: `Choose the collection “${esc(artifact.title)}” belongs to. An artifact is in one collection at a time.`,
    workspaceId: artifact.workspaceId,
    artifacts: [artifact],
    currentId: (artifact.collections || [])[0]?.id || null
  })

/** Library bulk action: put every selected artifact in one collection. */
ctx.openBulkCollectionSheet = (artifacts) => {
  if (!artifacts.length) return
  return openCollectionChooser({
    title: artifacts.length === 1 ? 'Move 1 artifact' : `Move ${artifacts.length} artifacts`,
    intro: 'Choose their collection. Artifacts already in another collection move out of it, since an artifact is in one collection at a time.',
    workspaceId: state.currentWorkspaceId || artifacts[0].workspaceId,
    artifacts
  })
}

ctx.removeFromCollection = async (artifactId, collection) => {
  const done = await attempt(
    () => api.removeFromCollection(collection.id, artifactId),
    `Removed from ${collection.name}`
  )
  if (done) await refresh({ reload: true })
}

ctx.filterLibraryByCollection = (collectionId) => {
  ctx.filters.collectionId = collectionId || null
  ctx.filters.type = 'all'
  closeSheet()
  navigate('/library')
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
        <label style="display:flex;gap:9px;align-items:flex-start;font-size:13px;line-height:1.45;margin-top:4px">
          <input type="checkbox" id="collection-project" style="margin-top:3px">
          <span><strong>This is a project.</strong> Your AI tools can list it and save straight into it,
          e.g. "save this to the Q4 launch project".</span>
        </label>
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
          const isProject = Boolean(panel?.querySelector('#collection-project')?.checked)

          const result = await attempt(() =>
            api.createCollection({ name, description, workspaceId, isProject })
          )
          if (!result) return

          closeSheet()
          toast('Collection created', 'success')
          await loadCollections()
          render()
          ctx.openCollectionsSheet()
        }
      }
    ]
  })
}

// ---------------------------------------------------------------
// AI connectors (§58, §60)
// ---------------------------------------------------------------

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

const SCOPE_TEXT = {
  'artifact.read': 'Search and read artifacts',
  'artifact.write': 'Save artifacts, add versions and tags',
  'artifact.share': 'Create and revoke shares',
  'artifact.analytics.read': 'Read view and download analytics',
  'workspace.read': 'List workspaces',
  'team.read': 'List teams',
  'tags.read': 'List tags',
  'profile.read': 'Read your name and email'
}

function scopeChips(scopes) {
  return (scopes || []).length
    ? scopes.map((s) => `<span class="chip">${esc(s)}</span>`).join('')
    : '<span style="color:var(--text-3)">None</span>'
}

function detailRow(label, value) {
  return `<div style="display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:6px 0">
    <span style="color:var(--text-2)">${esc(label)}</span>
    <span style="font-weight:560;text-align:right">${value}</span>
  </div>`
}

/** Create a personal access token: name, scopes, expiry. */
ctx.openCreateTokenSheet = () => {
  const access = state.access || {}
  const defaults = access.defaultTokenScopes || ['artifact.read', 'artifact.write', 'artifact.share']
  const all = access.availableScopes || Object.keys(SCOPE_TEXT)
  const expiries = access.tokenExpiryDays || [7, 30, 90, 365]
  const defaultExpiry = access.defaultTokenExpiryDays || 90
  const scopeRow = (value) => `
    <label class="row" style="gap:11px;padding:9px 0;cursor:pointer">
      <input type="checkbox" name="token-scope" value="${esc(value)}" ${defaults.includes(value) ? 'checked' : ''}
        style="accent-color:var(--accent);width:20px;height:20px;flex:none">
      <span style="flex:1;font-size:14px">${esc(SCOPE_TEXT[value] || value)}
        <span style="display:block;font-size:11.5px;color:var(--text-3);font-family:var(--font-mono)">${esc(value)}</span>
      </span>
    </label>`

  sheet({
    title: 'New access token',
    content: `
      <div>
        <p style="font-size:13px;color:var(--text-2);margin:0 0 12px;line-height:1.55">
          For scripts, scheduled agents, CI and MCP clients that can't sign in with a browser.
          AI apps like Claude and ChatGPT should sign in instead.
        </p>
        ${field('Name', '<input id="token-name" class="input" type="text" maxlength="80" placeholder="e.g. Nightly backup script">')}
        ${field(
          'Expires',
          `<select id="token-expiry" class="input">
            ${expiries.map((d) => `<option value="${d}" ${d === defaultExpiry ? 'selected' : ''}>In ${d} days</option>`).join('')}
            <option value="never">Never</option>
          </select>`
        )}
        <div style="font-size:12.5px;font-weight:640;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin:14px 0 4px">
          What it may do
        </div>
        ${all.filter((s) => defaults.includes(s)).map(scopeRow).join('')}
        <details style="margin-top:4px">
          <summary style="font-size:13px;color:var(--text-2);cursor:pointer;padding:6px 0">More permissions</summary>
          ${all.filter((s) => !defaults.includes(s)).map(scopeRow).join('')}
        </details>
        <p style="font-size:11.5px;color:var(--text-3);margin:12px 0 0;line-height:1.55">
          A token can never do more than you can. Untick anything it doesn't need.
        </p>
      </div>`,
    actions: [
      {
        label: 'Create token',
        variant: 'primary',
        keepOpen: true,
        onClick: async () => {
          const panel = document.querySelector('.sheet')
          const name = panel?.querySelector('#token-name')?.value.trim() || ''
          const expiry = panel?.querySelector('#token-expiry')?.value
          const scopes = Array.from(panel?.querySelectorAll('input[name="token-scope"]:checked') || []).map((i) => i.value)
          if (!name) {
            toast('Give the token a name', 'error')
            return
          }
          if (!scopes.length) {
            toast('Select at least one permission', 'error')
            return
          }
          const result = await attempt(() =>
            api.createToken({ name, scopes, expiresInDays: expiry === 'never' ? null : Number(expiry) })
          )
          if (!result) return
          closeSheet()
          await loadAccess()
          render()
          ctx.openTokenResultSheet(result)
        }
      }
    ]
  })
}

/** The one moment a personal access token is visible. */
ctx.openTokenResultSheet = (result) => {
  sheet({
    title: 'Copy your token',
    content: `
      <div>
        <div style="font-size:11.5px;font-weight:640;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">${esc(result.name)}</div>
        <div style="padding:11px;border-radius:11px;background:var(--surface-2);font-family:var(--font-mono);
          font-size:11.5px;word-break:break-all;line-height:1.6">${esc(result.token)}</div>

        <div style="margin-top:14px;padding:11px 13px;border-radius:11px;background:var(--warning-weak);
          border:1px solid #fedf89;font-size:12px;line-height:1.55;color:#93370d">
          ${icon('alert', 13)} ${esc(result.note || 'This token cannot be shown again.')}
        </div>

        <div style="font-size:11.5px;font-weight:640;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin:14px 0 5px">MCP endpoint</div>
        <div class="brand-url" style="padding:11px;border-radius:11px;background:var(--surface-2);
          font-size:11.5px;word-break:break-all;line-height:1.6">${brandUrl(result.mcpEndpoint)}</div>
        <p style="font-size:12px;color:var(--text-2);margin:10px 0 0;line-height:1.55">
          Send it as <code>Authorization: Bearer &lt;token&gt;</code>.
          ${result.expiresAt ? `It expires ${esc(formatDate(result.expiresAt))}.` : 'It does not expire.'}
        </p>
      </div>`,
    actions: [
      { label: 'Copy token', variant: 'primary', keepOpen: true, onClick: () => copyText(result.token) },
      { label: 'Done', variant: 'secondary' }
    ]
  })
}

/**
 * One OAuth sign-in or access token: what it may do, when it was last used,
 * its latest tool calls from the audit trail, and Revoke.
 */
ctx.openAccessSheet = (kind, id) => {
  const access = state.access || {}
  const list = kind === 'connection' ? access.connections : kind === 'token' ? access.tokens : access.legacyTokens
  const item = (list || []).find((x) => x.id === id)
  if (!item) return

  const title = kind === 'connection' ? item.app : item.name
  const rows = [
    kind === 'connection' && item.client ? detailRow('App', esc(item.client)) : '',
    kind !== 'connection' ? detailRow('Token', `<span style="font-family:var(--font-mono);font-size:11.5px">${esc(item.tokenPrefix)}…</span>`) : '',
    detailRow(kind === 'connection' ? 'Signed in' : 'Created', esc(formatDate(item.connectedAt || item.createdAt))),
    detailRow('Last used', item.lastUsedAt ? esc(timeAgo(item.lastUsedAt)) : 'Never'),
    kind === 'token' ? detailRow('Expires', item.expiresAt ? esc(formatDate(item.expiresAt)) + (item.expired ? ' (expired)' : '') : 'Never') : ''
  ].join('')

  sheet({
    title,
    content: `
      <div>
        ${
          kind === 'legacy'
            ? `<p style="font-size:12.5px;color:var(--text-2);margin:0 0 8px;line-height:1.55">
                 A token pasted into ${esc(item.name)} from the older Connect screen. It keeps working;
                 signing that app in with OAuth, or a named access token, is easier to manage.</p>`
            : ''
        }
        ${rows}
        <div style="font-size:13px;padding:6px 0">
          <div style="color:var(--text-2);margin-bottom:7px">Permissions</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">${scopeChips(item.scopes)}</div>
        </div>
        <div style="font-size:13px;padding:10px 0 0">
          <div style="color:var(--text-2);margin-bottom:7px">Recent activity</div>
          <div id="access-activity" style="font-size:12.5px;color:var(--text-3)">Loading…</div>
        </div>
      </div>`,
    actions: [
      {
        label: kind === 'connection' ? 'Disconnect' : 'Revoke token',
        variant: 'danger',
        onClick: async () => {
          const done = await attempt(
            () => api.revokeToken(item.id),
            kind === 'connection' ? `${title} disconnected` : 'Token revoked'
          )
          if (done === null) return
          await Promise.all([loadAccess(), loadIntegrations()])
          render()
        }
      }
    ],
    async onMount(handle) {
      const host = handle.body.querySelector('#access-activity')
      try {
        const result = await api.accessActivity(item.id)
        const activity = result?.activity || []
        host.innerHTML = activity.length
          ? activity
              .slice(0, 10)
              .map(
                (a) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:4px 0;color:var(--text-1)">
                  <span style="font-family:var(--font-mono);font-size:11.5px">${esc(a.tool || '—')}${
                    a.outcome && a.outcome !== 'ok' ? ` <span style="color:var(--danger)">${esc(a.outcome)}</span>` : ''
                  }</span>
                  <span style="color:var(--text-3)">${esc(timeAgo(a.at))}</span>
                </div>`
              )
              .join('')
          : 'No tool calls yet.'
      } catch {
        host.textContent = 'Activity is not available right now.'
      }
    }
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

/**
 * Apply one tag decision from the detail screen and refresh it in place.
 *
 * The single funnel for accept / reject / add / remove, so all four share one
 * error path and one refresh path. `remove` is refused for a pending suggestion
 * by the service — rejecting is the meaningful action there — so a refusal is
 * surfaced as a toast rather than being swallowed.
 */
ctx.decideTags = async (artifactId, decision, successMessage) => {
  const outcome = await attempt(
    () => api.decideTags(artifactId, decision),
    successMessage || 'Tags updated'
  )
  if (outcome === null) return false

  // A name that resolved to nothing is worth saying out loud; otherwise the
  // chip simply disappears and the user cannot tell whether it worked.
  if (outcome?.not_found?.length) {
    toast(`No tag on this artifact matches: ${outcome.not_found.join(', ')}`, 'error')
  }

  await ctx.reload()
  return true
}

/**
 * Add one tag by hand from the detail screen.
 *
 * Deliberately a single field — this is the "type a word and file it" case, not
 * a tag-management screen. The value goes through the `add` decision, which
 * resolves or creates the tag by slug and confirms it with USER provenance, so
 * a manual add can never create a case-duplicate of a tag that already exists.
 */
ctx.openAddTagSheet = (artifact) => {
  sheet({
    title: 'Add tag',
    content: `
      <div>
        ${field(
          'Tag name',
          '<input id="tag-new-name" class="input" type="text" placeholder="board prep" autocomplete="off">',
          'Any word or short phrase that helps you find this later.'
        )}
      </div>`,
    actions: [
      {
        label: 'Add tag',
        variant: 'primary',
        keepOpen: true,
        onClick: async () => {
          const panel = document.querySelector('.sheet')
          const raw = panel?.querySelector('#tag-new-name')?.value?.trim()
          if (!raw) {
            toast('Enter a tag name', 'error')
            return
          }
          const done = await ctx.decideTags(artifact.id, { add: [raw] }, `Tag added: ${raw}`)
          if (done) closeSheet()
        }
      }
    ]
  })
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
                        ${c.isProject ? 'Project · ' : ''}${c.artifactCount} item(s)${c.workspaceName ? ` · ${esc(c.workspaceName)}` : ''}
                      </span>
                    </span>
                    ${icon('chevron', 16)}
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
        label: 'Show in library',
        variant: 'primary',
        onClick: () => ctx.filterLibraryByCollection(collectionId)
      },
      {
        label: 'Share collection',
        variant: 'secondary',
        onClick: () => {
          const collection = { id: collectionId, name: detail?.collection?.name || 'Collection' }
          shareCreateSheet(ctx, collection, () => {})
        }
      },
      {
        // A project is a collection AI tools can list and save into by name.
        label: detail?.collection?.isProject ? 'Stop using as a project' : 'Use as a project',
        variant: 'secondary',
        onClick: async () => {
          const isProject = !detail?.collection?.isProject
          const ok = await attempt(() => api.setCollectionProject(collectionId, isProject))
          if (!ok) return
          toast(isProject ? 'Now a project your AI tools can save into' : 'Back to a plain collection', 'success')
          await loadCollections()
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
          <span style="font-weight:560">${esc(workspace?.type === 'PERSONAL' ? 'Personal' : 'Shared')}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0">
          <span style="color:var(--text-2)">Your role</span>
          <span style="font-weight:560">${esc(roleLabel(workspace?.role || 'VIEWER'))}</span>
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
              ${avatar({ url: m.avatarUrl, name: m.displayName || m.email, size: 34 })}
              <span style="flex:1;min-width:0">
                <span style="display:block;font-size:13.5px;font-weight:560;overflow:hidden;text-overflow:ellipsis">${esc(m.displayName || m.email)}</span>
                <span style="display:block;font-size:11.5px;color:var(--text-2)">${esc(m.isWorkspaceOwner ? 'Owner' : m.customRoleName || roleLabel(m.role))}${m.status && m.status !== 'ACTIVE' ? ` · ${esc(m.status === 'REMOVED' ? 'deactivated' : 'awaiting approval')}` : ''}</span>
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
      ...(canManage && workspace?.type !== 'PERSONAL'
        ? [
            {
              label: 'Add member',
              variant: 'secondary',
              keepOpen: true,
              onClick: () => ctx.openAddMemberSheet(workspaceId)
            }
          ]
        : []),
      ...(canManage
        ? [
            {
              label: 'Workspace settings',
              variant: 'secondary',
              keepOpen: true,
              onClick: () => {
                closeSheet()
                navigate(`/workspace/${encodeURIComponent(workspaceId)}`)
              }
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
             <option value="VIEWER">Guest — view and download</option>
             <option value="CONTRIBUTOR" selected>Member — add, edit and share</option>
             <option value="WORKSPACE_ADMIN">Admin — manage settings and people</option>
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
        ['VIEWER', 'Guest — view and download'],
        ['CONTRIBUTOR', 'Member — add, edit and share'],
        ['WORKSPACE_ADMIN', 'Admin — manage settings and people']
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

/**
 * Create a workspace. With an organizationId it belongs to that organization
 * (owners and admins only, enforced server-side); without one it is another
 * personal workspace. The creator becomes its workspace admin.
 */
ctx.openCreateWorkspaceSheet = ({ organizationId = null, organizationName = '' } = {}) => {
  sheet({
    title: 'New workspace',
    content: `
      <div>
        ${field(
          'Workspace name',
          '<input id="ws-name" class="input" type="text" maxlength="120" placeholder="Marketing">',
          organizationId
            ? `Belongs to ${organizationName || 'your organization'}. You become its admin and decide who else joins.`
            : 'A separate personal workspace. You become its admin and decide who else joins.'
        )}
        ${field(
          'Description',
          '<input id="ws-description" class="input" type="text" maxlength="500" placeholder="Optional">'
        )}
      </div>`,
    actions: [
      {
        label: 'Create',
        variant: 'primary',
        keepOpen: true,
        onClick: async () => {
          const panel = document.querySelector('.sheet')
          const name = panel?.querySelector('#ws-name')?.value?.trim()
          const description = panel?.querySelector('#ws-description')?.value?.trim()
          if (!name) {
            toast('Enter a name', 'error')
            return
          }

          const payload = { name }
          if (description) payload.description = description
          if (organizationId) payload.organizationId = organizationId

          const created = await attempt(() => api.createWorkspace(payload), 'Workspace created')
          if (created === null) return

          closeSheet()
          // The switcher and profile read the workspace list from the shell
          // data, which is otherwise loaded once per session.
          await loadShellData().catch(() => {})
          if (created?.workspace?.id) setState({ currentWorkspaceId: created.workspace.id })
          await refresh({ reload: true })
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

/**
 * Profile picture. Any PNG, JPEG, WebP or GIF up to 1 MB; whatever its shape,
 * it is shown cropped to a circle.
 */
ctx.openAvatarSheet = () => {
  const upload = (file) =>
    attempt(async () => {
      const result = await api.uploadAvatar(file)
      setState({ me: { ...state.me, avatarUrl: result.avatarUrl } })
      closeSheet()
      void refresh({ reload: true })
    }, 'Profile picture updated')

  sheet({
    title: 'Profile picture',
    content: `
      <div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:6px 0 4px">
        ${avatar({ url: state.me?.avatarUrl, name: state.me?.displayName || state.me?.email, size: 112 })}
        <p style="font-size:12.5px;color:var(--text-2);margin:0;text-align:center;line-height:1.5">
          PNG, JPEG, WebP or GIF, up to 1 MB. A square picture around 320 × 320 looks best;
          any other shape is cropped to the circle.
        </p>
      </div>`,
    actions: [
      {
        label: state.me?.avatarUrl ? 'Choose a new picture' : 'Choose a picture',
        variant: 'primary',
        keepOpen: true,
        onClick: () => pickPicture(upload)
      },
      ...(state.me?.avatarUrl
        ? [
            {
              label: 'Remove picture',
              variant: 'danger',
              keepOpen: true,
              onClick: () =>
                attempt(async () => {
                  await api.removeAvatar()
                  setState({ me: { ...state.me, avatarUrl: null } })
                  closeSheet()
                  void refresh({ reload: true })
                }, 'Profile picture removed')
            }
          ]
        : [])
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
          <span style="font-weight:560;font-family:var(--font-mono);font-size:11.5px">${esc(share.tokenPrefix)}…</span>
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
      ${
        artifact.canManageCollections
          ? `<button class="row" id="art-collections">${icon('folder', 19)} <span style="flex:1">Change collection</span></button>`
          : ''
      }
      <button class="row" id="art-copy">${icon('link', 19)} <span style="flex:1">Copy canonical link</span></button>
      <button class="row" id="art-analytics">${icon('chart', 19)} <span style="flex:1">View analytics</span></button>
      ${
        artifact.canDelete
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
      handle.body.querySelector('#art-collections')?.addEventListener('click', () =>
        ctx.openArtifactCollectionsSheet(artifact)
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

ctx.confirmDeleteArtifact = (artifact) =>
  ctx.confirmDeleteArtifacts([artifact], { after: () => navigate('/library') })

/**
 * Always asks before deleting, for one artifact or many. Deleting is
 * permanent and only workspace Owners and Admins can do it (the server
 * refuses everyone else).
 */
ctx.confirmDeleteArtifacts = (artifacts, { after } = {}) => {
  if (!artifacts.length) return
  const n = artifacts.length
  const listed = artifacts.slice(0, 5)
  sheet({
    title: n === 1 ? 'Delete this artifact permanently?' : `Delete ${n} artifacts permanently?`,
    content: `
      <div>
        <ul style="margin:0 0 12px;padding-left:18px;font-size:13.5px;line-height:1.6">
          ${listed.map((a) => `<li style="overflow-wrap:anywhere">${esc(a.title)}</li>`).join('')}
          ${n > listed.length ? `<li style="color:var(--text-2)">and ${n - listed.length} more</li>` : ''}
        </ul>
        <p style="font-size:13.5px;color:var(--text-2);margin:0;line-height:1.55">
          ${n === 1 ? 'Its files, versions and shares are' : 'Their files, versions and shares are'} removed for good.
          This cannot be undone.
        </p>
      </div>`,
    actions: [
      { label: 'Cancel', variant: 'secondary', onClick: () => {} },
      {
        label: n === 1 ? 'Delete permanently' : `Delete ${n} permanently`,
        variant: 'danger',
        keepOpen: true,
        onClick: async () => {
          const result =
            n === 1
              ? await attempt(() => api.deleteArtifact(artifacts[0].id))
              : await attempt(() => api.bulkDelete(artifacts.map((a) => a.id)))
          if (!result) return
          const deleted = n === 1 ? 1 : result.deleted
          const skipped = n === 1 ? 0 : result.skipped?.length || 0
          toast(
            `Deleted ${deleted === 1 ? '1 artifact' : `${deleted} artifacts`}${skipped ? ` · ${skipped} not allowed` : ''}`,
            'success'
          )
          closeSheet()
          ctx.clearSelection({ render: false })
          await loadCollections()
          if (after) after()
          else void refresh({ reload: true })
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

    if (event.target.closest('#nav-logout')) {
      event.preventDefault()
      ctx.signOut()
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
        <button class="row" id="switch-new-workspace" style="padding:12px 0">
          ${icon('plus', 19)}
          <span style="flex:1;font-size:14px;font-weight:560">New workspace</span>
        </button>
      </div>`,
    onMount(handle) {
      handle.body.querySelector('#switch-new-workspace')?.addEventListener('click', () => {
        closeSheet()
        ctx.openCreateWorkspaceSheet()
      })
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
