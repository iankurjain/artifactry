/**
 * API client and application state.
 *
 * Every call goes through request(), which:
 *   - sends cookies (same-origin session), never cross-origin credentials
 *   - normalises the { ok, data } / { ok, error, message } envelope
 *   - surfaces 401 by clearing session state so the UI can re-authenticate
 */

const state = {
  me: null,
  workspaces: [],
  organizations: [],
  integrations: [],
  tags: [],
  collections: [],
  artifacts: [],
  activity: [],
  boot: null,
  currentWorkspaceId: null,
  session: { authenticated: false, devMode: false }
}

export function getState() {
  return state
}

export function setState(patch) {
  Object.assign(state, patch)
}

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

async function request(path, options = {}) {
  const { method = 'GET', body, raw = false, headers = {} } = options

  const init = {
    method,
    credentials: 'same-origin',
    headers: { ...headers }
  }

  if (body instanceof FormData) {
    init.body = body
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  let response
  try {
    response = await fetch(path, init)
  } catch {
    throw new ApiError(0, 'NETWORK', 'Network unavailable. Check your connection and try again.')
  }

  if (raw) {
    if (!response.ok) {
      throw new ApiError(response.status, 'HTTP', `Request failed (${response.status})`)
    }
    return response
  }

  let payload = null
  const contentType = response.headers.get('Content-Type') || ''
  if (contentType.includes('application/json')) {
    payload = await response.json().catch(() => null)
  }

  if (!response.ok || (payload && payload.ok === false)) {
    const message =
      payload?.message ||
      (response.status === 401
        ? 'Your session expired. Please sign in again.'
        : `Request failed (${response.status})`)
    const error = new ApiError(response.status, payload?.error || 'ERROR', message, payload?.details)

    if (response.status === 401) {
      state.session = { ...state.session, authenticated: false }
      state.me = null
      window.dispatchEvent(new CustomEvent('app:unauthenticated'))
    }

    throw error
  }

  return payload?.data ?? null
}

export { ApiError }

// ---------------------------------------------------------------
// Auth
// ---------------------------------------------------------------

export const api = {
  requestCode: (email) => request('/api/v1/auth/request-code', { method: 'POST', body: { email } }),

  verifyCode: (email, code) =>
    request('/api/v1/auth/verify-code', { method: 'POST', body: { email, code } }),

  logout: () => request('/api/v1/auth/logout', { method: 'POST', body: {} }),

  session: () => request('/api/v1/auth/session'),

  me: () => request('/api/v1/auth/me'),

  // ---------------------------------------------------------------
  // Artifacts
  // ---------------------------------------------------------------

  listArtifacts: ({ workspaceId, type, sort, limit = 25, offset = 0 } = {}) => {
    const params = new URLSearchParams()
    if (workspaceId) params.set('workspaceId', workspaceId)
    if (type) params.set('type', type)
    if (sort) params.set('sort', sort)
    params.set('limit', String(limit))
    params.set('offset', String(offset))
    return request(`/api/v1/artifacts?${params}`)
  },

  getArtifact: (id) => request(`/api/v1/artifacts/${encodeURIComponent(id)}`),

  indexState: (id) =>
    request(`/api/v1/artifacts/${encodeURIComponent(id)}/index-state`).catch(() => null),

  reprocess: (id) =>
    request(`/api/v1/artifacts/${encodeURIComponent(id)}/reprocess`, { method: 'POST', body: {} }),

  uploadArtifact: (formData) =>
    request('/api/v1/artifacts', { method: 'POST', body: formData }),

  createArtifactFromContent: (payload) =>
    request('/api/v1/artifacts', { method: 'POST', body: payload }),

  updateArtifact: (id, patch) =>
    request(`/api/v1/artifacts/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),

  deleteArtifact: (id) =>
    request(`/api/v1/artifacts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  addVersion: (id, formData) =>
    request(`/api/v1/artifacts/${encodeURIComponent(id)}/versions`, {
      method: 'POST',
      body: formData
    }),

  restoreVersion: (id, versionId) =>
    request(`/api/v1/artifacts/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`, {
      method: 'POST',
      body: {}
    }),

  artifactJobs: (id) => request(`/api/v1/artifacts/${encodeURIComponent(id)}/jobs`),

  analytics: (id, period = '30d') =>
    request(`/api/v1/artifacts/${encodeURIComponent(id)}/analytics?period=${period}`),

  applyTags: (id, tags) =>
    request(`/api/v1/artifacts/${encodeURIComponent(id)}/tags`, { method: 'POST', body: { tags } }),

  removeTag: (id, slug) =>
    request(`/api/v1/artifacts/${encodeURIComponent(id)}/tags/${encodeURIComponent(slug)}`, {
      method: 'DELETE'
    }),

  // ---------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------

  search: (payload) => request('/api/v1/search', { method: 'POST', body: payload }),

  searchFilters: () => request('/api/v1/search/filters'),

  recentSearches: () => request('/api/v1/search/recent'),

  saveSearch: (query) => request('/api/v1/search/recent', { method: 'POST', body: { query } }),

  suggest: (q) => request(`/api/v1/search/suggest?q=${encodeURIComponent(q)}`),

  // ---------------------------------------------------------------
  // Sharing
  // ---------------------------------------------------------------

  createShare: (payload) => request('/api/v1/shares', { method: 'POST', body: payload }),

  listShares: (targetId) =>
    request(`/api/v1/shares${targetId ? `?targetId=${encodeURIComponent(targetId)}` : ''}`),

  getShare: (id) => request(`/api/v1/shares/${encodeURIComponent(id)}`),

  updateShare: (id, patch) =>
    request(`/api/v1/shares/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),

  revokeShare: (id) =>
    request(`/api/v1/shares/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // External recipient surface
  shareMeta: (token) => request(`/api/v1/shares/${encodeURIComponent(token)}/meta`),

  shareRequestCode: (token, email) =>
    request(`/api/v1/shares/${encodeURIComponent(token)}/request-code`, {
      method: 'POST',
      body: { email }
    }),

  shareVerify: (token, email, code) =>
    request(`/api/v1/shares/${encodeURIComponent(token)}/verify`, {
      method: 'POST',
      body: { email, code }
    }),

  shareView: (token) => request(`/api/v1/shares/${encodeURIComponent(token)}/view`),

  // ---------------------------------------------------------------
  // Taxonomy and collections
  // ---------------------------------------------------------------

  tags: () => request('/api/v1/tags'),

  createTag: (payload) => request('/api/v1/tags', { method: 'POST', body: payload }),

  updateTag: (id, patch) => request(`/api/v1/tags/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),

  deleteTag: (id) => request(`/api/v1/tags/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  collections: (workspaceId) =>
    request(`/api/v1/collections${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`),

  collection: (id) => request(`/api/v1/collections/${encodeURIComponent(id)}`),

  createCollection: (payload) => request('/api/v1/collections', { method: 'POST', body: payload }),

  addToCollection: (id, artifactIds) =>
    request(`/api/v1/collections/${encodeURIComponent(id)}/artifacts`, {
      method: 'POST',
      body: { artifactIds }
    }),

  removeFromCollection: (id, artifactId) =>
    request(`/api/v1/collections/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}`, {
      method: 'DELETE'
    }),

  // ---------------------------------------------------------------
  // Workspaces and organizations
  // ---------------------------------------------------------------

  workspaces: () => request('/api/v1/workspaces'),

  workspace: (id) => request(`/api/v1/workspaces/${encodeURIComponent(id)}`),

  createWorkspace: (payload) => request('/api/v1/workspaces', { method: 'POST', body: payload }),

  updateWorkspace: (id, patch) =>
    request(`/api/v1/workspaces/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),

  workspaceMembers: (id) => request(`/api/v1/workspaces/${encodeURIComponent(id)}/members`),

  addWorkspaceMember: (id, email, role) =>
    request(`/api/v1/workspaces/${encodeURIComponent(id)}/members`, {
      method: 'POST',
      body: { email, role }
    }),

  updateWorkspaceMember: (id, userId, role) =>
    request(`/api/v1/workspaces/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: { role }
    }),

  removeWorkspaceMember: (id, userId) =>
    request(`/api/v1/workspaces/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, {
      method: 'DELETE'
    }),

  organizations: () => request('/api/v1/organizations'),

  createOrganization: (name) =>
    request('/api/v1/organizations', { method: 'POST', body: { name } }),

  orgMembers: (id) => request(`/api/v1/organizations/${encodeURIComponent(id)}/members`),

  addOrgMember: (id, email, role) =>
    request(`/api/v1/organizations/${encodeURIComponent(id)}/members`, {
      method: 'POST',
      body: { email, role }
    }),

  orgAnalytics: (id, period = '30d') =>
    request(`/api/v1/organizations/${encodeURIComponent(id)}/analytics?period=${period}`),

  updateOrgSettings: (id, settings) =>
    request(`/api/v1/organizations/${encodeURIComponent(id)}/settings`, {
      method: 'PATCH',
      body: settings
    }),

  // ---------------------------------------------------------------
  // AI connectors, activity, profile
  // ---------------------------------------------------------------

  integrations: () => request('/api/v1/integrations'),

  connectIntegration: (integrationId, scopes) =>
    request(`/api/v1/integrations/${encodeURIComponent(integrationId)}/connect`, {
      method: 'POST',
      body: { scopes }
    }),

  disconnectIntegration: (grantId) =>
    request(`/api/v1/integrations/grants/${encodeURIComponent(grantId)}`, { method: 'DELETE' }),

  activity: (limit = 20) => request(`/api/v1/activity?limit=${limit}`),

  profile: () => request('/api/v1/profile'),

  updateProfile: (displayName) =>
    request('/api/v1/profile', { method: 'PATCH', body: { displayName } })
}

export default api
