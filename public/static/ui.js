/**
 * UI primitives: safe string handling, icons, toasts, bottom sheets and
 * formatting helpers.
 *
 * Escaping policy: every value that originates from a user or an API response
 * is passed through esc() before it reaches innerHTML. Attribute values are
 * always quoted. This is the only place markup is assembled, so the rule is
 * enforceable by reading one file.
 */

export function esc(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Only allow http(s) and same-origin relative URLs into href/src. */
export function safeUrl(url) {
  if (!url) return '#'
  const value = String(url).trim()
  if (value.startsWith('/') || value.startsWith('#')) return value
  if (/^https?:\/\//i.test(value)) return value
  return '#'
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
  const value = n / 1024 ** i
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

export function timeAgo(iso) {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const seconds = Math.floor((Date.now() - then) / 1000)
  if (seconds < 45) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  const days = Math.floor(seconds / 86400)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatDate(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatDateTime(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${formatDate(iso)} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}

/** Human label for an artifact kind, used on cards and detail headers. */
export function kindLabel(extension) {
  const ext = (extension || '').toLowerCase()
  switch (ext) {
    case 'pptx':
      return 'Presentation'
    case 'pdf':
      return 'PDF'
    case 'docx':
      return 'Document'
    case 'html':
    case 'htm':
      return 'Web'
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'bmp':
    case 'gif':
      return 'Image'
    default:
      return ext ? ext.toUpperCase() : 'File'
  }
}

export function extLabel(extension) {
  return (extension || 'file').toUpperCase()
}

// ---------------------------------------------------------------
// Icons (inline SVG, 24x24, currentColor)
// ---------------------------------------------------------------

const ICON_PATHS = {
  home: '<path d="M3 10.2 12 3l9 7.2"/><path d="M5 9.6V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  library: '<rect x="3" y="4" width="7" height="7" rx="1.6"/><rect x="14" y="4" width="7" height="7" rx="1.6"/><rect x="3" y="15" width="7" height="6" rx="1.6"/><rect x="14" y="15" width="7" height="6" rx="1.6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  download: '<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 20h14"/>',
  share: '<circle cx="17" cy="6" r="2.6"/><circle cx="7" cy="12" r="2.6"/><circle cx="17" cy="18" r="2.6"/><path d="m9.3 10.7 5.4-3.4M9.3 13.3l5.4 3.4"/>',
  chart: '<path d="M4 20V9"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
  tag: '<path d="M3 11.5V5a2 2 0 0 1 2-2h6.5L21 12.5 12.5 21 3 11.5Z"/><circle cx="7.5" cy="7.5" r="1.4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h3.6l2 2.4H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
  sparkle: '<path d="M12 3.5 13.9 9l5.6 2-5.6 2-1.9 5.5L10.1 13 4.5 11l5.6-2Z"/>',
  shield: '<path d="M12 3l7 3v6c0 4.4-3 8-7 9-4-1-7-4.6-7-9V6Z"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"/><path d="M6.5 7l.8 12.1A1.5 1.5 0 0 0 8.8 20.5h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/>',
  upload: '<path d="M12 16V5"/><path d="m7.5 9.5 4.5-4.5 4.5 4.5"/><path d="M5 20h14"/>',
  link: '<path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-1.4 1.4"/><path d="M14 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.4-1.4"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.4"/><path d="m4 7 8 5.5L20 7"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3.5 9h17M3.5 15h17"/><path d="M12 3c2.5 2.4 3.8 5.4 3.8 9S14.5 18.6 12 21c-2.5-2.4-3.8-5.4-3.8-9S9.5 5.4 12 3Z"/>',
  file: '<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9Z"/><path d="M13 3v6h6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.4"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m4 17 4.5-4.5L13 17l3-2.5 4 3.5"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h9"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  alert: '<path d="M12 4.5 21 19.5H3Z"/><path d="M12 10v4"/><circle cx="12" cy="16.8" r=".9"/>',
  building: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 20v-4h6v4"/><path d="M8 8h2M14 8h2M8 12h2M14 12h2"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.4"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  eye: '<path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  ai: '<rect x="5" y="7" width="14" height="11" rx="3"/><path d="M12 3.5V7"/><circle cx="9.5" cy="12" r="1.2"/><circle cx="14.5" cy="12" r="1.2"/>'
}

export function icon(name, size = 24, extraClass = '') {
  const path = ICON_PATHS[name] || ICON_PATHS.file
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
    class="${esc(extraClass)}" focusable="false">${path}</svg>`
}

/** Extension badge used as a thumbnail stand-in. */
export function fileBadge(extension) {
  const ext = (extension || '').toLowerCase()
  const palette = {
    pptx: ['#fff1e6', '#b54708'],
    pdf: ['#fef3f2', '#b42318'],
    docx: ['#eaf0ff', '#1d4ed8'],
    html: ['#f3e8ff', '#7e22ce']
  }
  const [bg, fg] = palette[ext] ||
    (['png', 'jpg', 'jpeg', 'bmp', 'gif'].includes(ext) ? ['#ecfdf3', '#067647'] : ['#f1f3f6', '#5b6472'])

  return `<div style="width:46px;height:46px;flex:none;border-radius:11px;background:${bg};color:${fg};
    display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:700;letter-spacing:.03em">
    ${esc(extLabel(ext).slice(0, 4))}</div>`
}

// ---------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------

export function toast(message, variant = 'default', timeout = 3600) {
  const host = document.getElementById('toast-host')
  if (!host) return
  const node = document.createElement('div')
  node.className = `toast${variant === 'error' ? ' toast-error' : variant === 'success' ? ' toast-success' : ''}`
  // textContent: toast copy may echo API messages, never HTML
  node.textContent = message
  host.appendChild(node)
  setTimeout(() => {
    node.style.transition = 'opacity .2s ease'
    node.style.opacity = '0'
    setTimeout(() => node.remove(), 220)
  }, timeout)
}

// ---------------------------------------------------------------
// Bottom sheet (§79)
// ---------------------------------------------------------------

let openSheet = null

/**
 * Open a bottom sheet. Returns a handle with close().
 *
 * Focus is moved into the sheet and returned to the trigger on close, and
 * Escape dismisses it — the accessibility requirements in §113 apply to
 * sheets as well as dialogs.
 */
export function sheet({ title, content, actions = [], onMount, dismissible = true }) {
  closeSheet()

  const host = document.getElementById('sheet-host')
  const previouslyFocused = document.activeElement

  const backdrop = document.createElement('div')
  backdrop.className = 'sheet-backdrop'

  const panel = document.createElement('div')
  panel.className = 'sheet'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', title || 'Actions')

  panel.innerHTML = `
    <div class="sheet-grabber" aria-hidden="true"></div>
    ${title ? `<div style="padding:6px 16px 4px;font-size:17px;font-weight:620" id="sheet-title">${esc(title)}</div>` : ''}
    <div class="sheet-body" id="sheet-body"></div>
    ${actions.length ? '<div id="sheet-actions" style="padding:10px 16px 6px;display:flex;flex-direction:column;gap:8px"></div>' : ''}
  `

  host.appendChild(backdrop)
  host.appendChild(panel)

  const body = panel.querySelector('#sheet-body')
  if (typeof content === 'string') body.innerHTML = content
  else if (content instanceof Node) body.appendChild(content)

  const actionsHost = panel.querySelector('#sheet-actions')
  if (actionsHost) {
    for (const action of actions) {
      const button = document.createElement('button')
      button.className = `btn btn-block ${action.variant === 'danger' ? 'btn-danger' : action.variant === 'primary' ? 'btn-primary' : 'btn-secondary'}`
      button.type = 'button'
      if (action.variant === 'danger') button.style.color = 'var(--danger)'
      button.textContent = action.label
      button.addEventListener('click', async () => {
        if (action.keepOpen !== true) closeSheet()
        await action.onClick?.()
      })
      actionsHost.appendChild(button)
    }
  }

  requestAnimationFrame(() => {
    backdrop.classList.add('is-open')
    panel.classList.add('is-open')
  })

  const onKey = (event) => {
    if (event.key === 'Escape' && dismissible) closeSheet()
  }
  document.addEventListener('keydown', onKey)

  if (dismissible) backdrop.addEventListener('click', () => closeSheet())

  // Move focus to the first control, or the panel itself
  const focusTarget =
    panel.querySelector('button, input, select, textarea, a[href]') || panel
  if (focusTarget === panel) panel.setAttribute('tabindex', '-1')
  setTimeout(() => focusTarget.focus?.(), 60)

  const handle = {
    panel,
    body,
    close: () => closeSheet(),
    setActions(extra) {
      if (!actionsHost) return
      for (const action of extra) {
        const button = document.createElement('button')
        button.className = `btn btn-block ${action.variant === 'danger' ? 'btn-danger' : action.variant === 'primary' ? 'btn-primary' : 'btn-secondary'}`
        button.type = 'button'
        button.textContent = action.label
        button.addEventListener('click', async () => {
          if (action.keepOpen !== true) closeSheet()
          await action.onClick?.()
        })
        actionsHost.appendChild(button)
      }
    }
  }

  openSheet = {
    close() {
      document.removeEventListener('keydown', onKey)
      backdrop.classList.remove('is-open')
      panel.classList.remove('is-open')
      setTimeout(() => {
        backdrop.remove()
        panel.remove()
      }, 260)
      previouslyFocused?.focus?.()
      openSheet = null
    }
  }

  onMount?.(handle)
  return handle
}

export function closeSheet() {
  openSheet?.close()
}

// ---------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------

export function spinner(dark = false) {
  return `<span class="spinner${dark ? ' spinner-dark' : ''}" role="status" aria-label="Loading"></span>`
}

export function emptyState({ iconName = 'file', title, message, action }) {
  return `
    <div class="empty-state">
      ${icon(iconName, 40)}
      <div style="font-size:15px;font-weight:600;color:var(--text)">${esc(title)}</div>
      ${message ? `<p style="font-size:13.5px;margin:6px 0 0;line-height:1.5">${esc(message)}</p>` : ''}
      ${action ? `<div style="margin-top:16px">${action}</div>` : ''}
    </div>`
}

export function screenHeader({ title, onBackId, rightId, rightLabel, subtitle }) {
  return `
    <header class="app-header" data-header>
      <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;min-height:56px">
        ${
          onBackId
            ? `<button class="btn btn-ghost" id="${esc(onBackId)}" style="min-width:44px;padding:0 8px" aria-label="Go back">${icon('back', 22)}</button>`
            : '<span style="width:8px"></span>'
        }
        <div style="flex:1;min-width:0">
          <h1 style="margin:0;font-size:20px;font-weight:640;letter-spacing:-0.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</h1>
          ${subtitle ? `<div style="font-size:12.5px;color:var(--text-2);margin-top:1px">${esc(subtitle)}</div>` : ''}
        </div>
        ${
          rightId
            ? `<button class="btn btn-ghost" id="${esc(rightId)}" style="min-width:44px;padding:0 10px" aria-label="${esc(rightLabel || 'More actions')}">${icon('more', 22)}</button>`
            : '<span style="width:4px"></span>'
        }
      </div>
    </header>`
}

/** Progressively label a size, used in usage summaries. */
export function percent(part, total) {
  if (!total) return 0
  return Math.round((part / total) * 100)
}
