/**
 * Primary screens: sign-in, home, library, search, add, profile, admin and the
 * external share recipient view.
 *
 * Each screen returns { html, mount? }. html is a string built with esc() for
 * every dynamic value; mount() attaches listeners to the rendered DOM. Screens
 * never manipulate the URL directly — they call ctx.navigate().
 */

import {
  esc,
  icon,
  brandLockup,
  toast,
  sheet,
  closeSheet,
  emptyState,
  screenHeader,
  formatBytes,
  timeAgo,
  formatDate,
  formatDateTime,
  kindLabel,
  extLabel,
  fileBadge,
  safeUrl,
  spinner,
  avatar,
  roleLabel
} from './ui.js'
import { firstRunCard, handoffsSection } from './handoffs.js'
import { mediaKind } from './api.js'

// ---------------------------------------------------------------
// Shared-recipient HTML preview
//
// Both helpers read the server's `preview` descriptor; neither decides whether
// Interactive mode is allowed. A missing descriptor falls back to the most
// restrictive option (same-origin Safe path, empty sandbox) rather than
// assuming it is safe to grant scripting.
// ---------------------------------------------------------------

/** Sandbox tokens for a shared HTML preview. */
function sharePreviewSandbox(shareView) {
  const sandbox = shareView && shareView.preview && shareView.preview.sandbox
  return sandbox ? String(sandbox) : ''
}

/** One-line note telling the recipient which mode rendered the page. */
function sharePreviewNote(shareView) {
  const preview = shareView && shareView.preview
  if (!preview) return ''
  const interactive = preview.mode === 'INTERACTIVE'
  return `
    <div style="font-size:11.5px;color:var(--text-2);margin-top:7px;line-height:1.5">
      <strong style="color:var(--text)">${interactive ? 'Interactive Preview' : 'Safe Preview'}</strong> ·
      ${
        interactive
          ? 'JavaScript runs in an isolated sandbox.'
          : 'HTML and CSS render; JavaScript does not run.'
      }
    </div>`
}

// ---------------------------------------------------------------
// Sign in (§5)
// ---------------------------------------------------------------

export function renderLogin(ctx) {
  let stage = 'email'
  let email = ''
  let busy = false

  const html = () => `
    <main class="app-main" style="padding-top:calc(var(--safe-top) + 28px);min-height:100vh">
      <div style="text-align:center;margin-bottom:30px">
        <h1 class="sr-only">Artifactry</h1>
        <!--
          Official horizontal lockup from the logo kit. The wordmark is outlined
          artwork set in the brand's own typeface, so the logo is never re-typed
          in a UI font.
        -->
        <img src="/static/brand/artifactry-horizontal.svg" alt=""
          style="height:52px;width:auto;display:block;margin:0 auto 14px">
        <p style="color:var(--text-2);font-size:13.5px;margin:0;line-height:1.5">
          One secure library for everything<br>you and your AI create.
        </p>
      </div>

      <div class="card" style="padding:18px">
        ${
          stage === 'email'
            ? `
          <label for="login-email" style="font-size:13px;font-weight:600;display:block;margin-bottom:7px">Email address</label>
          <input id="login-email" class="input" type="email" inputmode="email" autocomplete="email"
            placeholder="you@company.com" value="${esc(email)}" aria-describedby="login-hint">
          <p id="login-hint" style="font-size:12px;color:var(--text-2);margin:9px 0 16px;line-height:1.5">
            We'll email you a 6-digit code. No password needed.
          </p>
          <button class="btn btn-primary btn-block" id="login-send" ${busy ? 'disabled' : ''}>
            ${busy ? spinner() : icon('mail', 18)} ${busy ? 'Sending…' : 'Continue with email'}
          </button>`
            : `
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
            <button class="btn btn-ghost" id="login-back" style="min-width:44px;padding:0 6px" aria-label="Change email">${icon('back', 20)}</button>
            <div style="min-width:0">
              <div style="font-size:13px;color:var(--text-2)">Code sent to</div>
              <div style="font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis">${esc(email)}</div>
            </div>
          </div>

          <label for="login-code" style="font-size:13px;font-weight:600;display:block;margin-bottom:7px">6-digit code</label>
          <input id="login-code" class="input" type="text" inputmode="numeric" autocomplete="one-time-code"
            maxlength="8" placeholder="000000"
            style="letter-spacing:6px;font-size:20px;text-align:center;font-weight:600">

          ${
            ctx.devCode
              ? `<div style="margin-top:12px;padding:11px 13px;border-radius:11px;background:var(--warning-weak);
                   border:1px solid #fedf89;font-size:12.5px;line-height:1.5">
                   <strong>Development mode.</strong> No email provider is configured, so your code is
                   <span style="font-family:var(--font-mono);font-weight:700">${esc(ctx.devCode)}</span>
                 </div>`
              : ''
          }

          <button class="btn btn-accent btn-block" id="login-verify" style="margin-top:16px" ${busy ? 'disabled' : ''}>
            ${busy ? spinner() : icon('check', 18)} ${busy ? 'Verifying…' : 'Sign in'}
          </button>
          <button class="btn btn-ghost btn-block" id="login-resend" style="margin-top:6px">Send a new code</button>`
        }
      </div>

      <p style="font-size:11.5px;color:var(--text-3);text-align:center;margin-top:22px;line-height:1.6">
        ${icon('lock', 13)} Artifacts are private by default.<br>Nothing is shared unless you choose to share it.
      </p>
    </main>`

  return {
    html: html(),
    mount(root) {
      const rerender = () => {
        root.innerHTML = html()
        bind()
      }

      const bind = () => {
        const emailInput = root.querySelector('#login-email')
        const codeInput = root.querySelector('#login-code')

        emailInput?.addEventListener('input', (e) => {
          email = e.target.value
        })
        emailInput?.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') root.querySelector('#login-send')?.click()
        })

        root.querySelector('#login-send')?.addEventListener('click', async () => {
          const value = (root.querySelector('#login-email')?.value || '').trim()
          if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value)) {
            toast('Enter a valid email address', 'error')
            return
          }
          busy = true
          rerender()

          try {
            const result = await ctx.api.requestCode(value)
            email = result.email
            ctx.devCode = result.devCode || null
            stage = 'code'
          } catch (err) {
            ctx.devCode = null
            toast(err.message, 'error')
          } finally {
            busy = false
            rerender()
          }
        })

        root.querySelector('#login-back')?.addEventListener('click', () => {
          stage = 'email'
          ctx.devCode = null
          rerender()
        })

        root.querySelector('#login-resend')?.addEventListener('click', async () => {
          try {
            const result = await ctx.api.requestCode(email)
            ctx.devCode = result.devCode || null
            toast('A new code is on its way', 'success')
          } catch (err) {
            toast(err.message, 'error')
          }
          rerender()
        })

        const submit = async () => {
          const code = (root.querySelector('#login-code')?.value || '').trim()
          if (!/^\d{4,8}$/.test(code)) {
            toast('Enter the numeric code from your email', 'error')
            return
          }
          busy = true
          rerender()

          try {
            await ctx.api.verifyCode(email, code)
            toast('Signed in', 'success')
            await ctx.onAuthenticated()
          } catch (err) {
            toast(err.message, 'error')
          } finally {
            busy = false
            rerender()
          }
        }

        root.querySelector('#login-verify')?.addEventListener('click', submit)
        codeInput?.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') submit()
        })

        // Move focus to the code field once the code stage renders
        if (stage === 'code') setTimeout(() => codeInput?.focus(), 80)
      }

      bind()
    }
  }
}

// ---------------------------------------------------------------
// Home (§91)
// ---------------------------------------------------------------

export function renderHome(ctx) {
  const state = ctx.state
  const name = (state.me?.displayName || 'there').split(' ')[0]
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  const viewed = ctx.home?.viewed || []
  const added = ctx.home?.added || []
  const aiMade = state.artifacts.filter((a) => a.madeBy).slice(0, 4)
  const sharedWithMe = state.artifacts.filter((a) => !a.isOwner).slice(0, 4)

  const cardRow = (items, emptyText = 'Nothing here yet', dateField = 'updated') =>
    items.length
      ? `<div class="thumbs">${items.map((a) => artifactCard(a, { dateField })).join('')}</div>`
      : `<p style="font-size:13px;color:var(--text-3);margin:2px 0 0">${esc(emptyText)}</p>`

  return {
    html: `
      <header class="app-header" data-header>
        <div style="padding:calc(var(--safe-top) + 12px) 16px 12px">
          <div class="home-brand">${brandLockup(28)}</div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
            <div style="min-width:0">
              <div style="font-size:13px;color:var(--text-2)">${esc(greeting)}</div>
              <h1 style="margin:2px 0 0;font-size:22px;font-weight:650;letter-spacing:-0.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                ${esc(name)}
              </h1>
            </div>
            ${ctx.workspaceSwitcher()}
          </div>

          <button class="input" id="home-search" style="margin-top:14px;display:flex;align-items:center;gap:10px;text-align:left;color:var(--text-3);cursor:pointer">
            ${icon('search', 18)}
            <span style="font-size:15px">Search your library</span>
          </button>
        </div>
      </header>

      <main class="app-main">
        ${
          state.artifacts.length === 0
            ? `${firstRunCard(ctx)}
              <button class="btn btn-ghost btn-block" id="home-upload" style="margin-top:8px">
                ${icon('upload', 17)} Or upload a file yourself
              </button>`
            : `
          ${firstRunCard(ctx)}
          ${handoffsSection(ctx)}
          <section aria-labelledby="home-recent">
            <div style="display:flex;align-items:baseline;justify-content:space-between;margin:18px 0 10px">
              <h2 id="home-recent" style="font-size:15px;font-weight:640;margin:0">Recently viewed</h2>
              <button class="btn btn-ghost" id="home-all" style="min-height:32px;padding:0 6px;font-size:13px">See all</button>
            </div>
            ${cardRow(viewed, 'Artifacts you open will show up here.')}
          </section>

          <section aria-labelledby="home-added">
            <div style="display:flex;align-items:baseline;justify-content:space-between;margin:22px 0 10px">
              <h2 id="home-added" style="font-size:15px;font-weight:640;margin:0">Recently added</h2>
              <button class="btn btn-ghost" id="home-added-all" style="min-height:32px;padding:0 6px;font-size:13px">See all</button>
            </div>
            ${cardRow(added, 'Nothing here yet', 'created')}
          </section>

          ${
            aiMade.length
              ? `<section aria-labelledby="home-ai">
                  <h2 id="home-ai" style="font-size:15px;font-weight:640;margin:22px 0 10px">
                    ${icon('sparkle', 15)} Made by your AI tools
                  </h2>
                  ${cardRow(aiMade)}
                </section>`
              : ''
          }

          ${
            sharedWithMe.length
              ? `<section aria-labelledby="home-shared">
                  <h2 id="home-shared" style="font-size:15px;font-weight:640;margin:22px 0 10px">Shared with me</h2>
                  ${cardRow(sharedWithMe)}
                </section>`
              : ''
          }`
        }
        ${ctx.appFooter()}
      </main>
      ${ctx.bottomNav('home')}`,
    mount(root) {
      root.querySelector('#home-search')?.addEventListener('click', () => ctx.navigate('/search'))
      root.querySelector('#home-all')?.addEventListener('click', () => ctx.navigate('/library'))
      root.querySelector('#home-added-all')?.addEventListener('click', () => {
        ctx.filters.sort = 'created'
        ctx.filters.collectionId = null
        ctx.navigate('/library')
      })
      root.querySelector('#home-upload')?.addEventListener('click', () => ctx.openAddSheet())
    }
  }
}

/**
 * Compact artifact card (§81) — thumbnail, title, type/updated, tag chips.
 * In the library's selection mode the card carries a check instead of
 * opening the artifact.
 */
export function artifactCard(artifact, { dateField = 'updated', selectable = false, selected = false } = {}) {
  const tagChips = (artifact.tags || [])
    .slice(0, 2)
    .map((t) => `<span class="chip">${esc(t)}</span>`)
    .join('')

  const sourceBadge = artifact.madeBy
    ? `<span class="chip" style="background:var(--accent-weak);color:var(--accent)">${icon('sparkle', 11)} ${esc(
        artifact.madeBy
      )}</span>`
    : ''

  // An artifact is in one collection at most.
  const collection = (artifact.collections || [])[0]
  const collectionChip = collection
    ? `<span class="chip chip-collection">${icon('folder', 11)} ${esc(collection.name)}</span>`
    : ''

  const sharedBadge = artifact.isOwner === false
    ? `<span class="chip" style="background:var(--warning-weak);color:var(--warning)">Shared</span>`
    : ''

  const selectAttrs = selectable
    ? `data-select="${esc(artifact.id)}" aria-pressed="${selected}" aria-label="Select ${esc(artifact.title)}"`
    : `data-artifact="${esc(artifact.id)}"`

  return `
    <button class="card${selectable ? ' is-selectable' : ''}${selected ? ' is-selected' : ''}" ${selectAttrs}
      style="padding:12px;display:block;text-align:left;cursor:pointer;border-width:1px;width:100%">
      ${selectable ? `<span class="select-check" aria-hidden="true">${selected ? icon('check', 15) : ''}</span>` : ''}
      <div style="display:flex;gap:11px;align-items:flex-start">
        ${fileBadge(artifact.extension)}
        <div style="flex:1;min-width:0">
          <div style="font-size:14.5px;font-weight:600;line-height:1.35;
            display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">
            ${esc(artifact.title)}
          </div>
          <div style="font-size:11.5px;color:var(--text-2);margin-top:4px">
            ${esc(extLabel(artifact.extension))} · ${esc(
              dateField === 'created' ? `Added ${timeAgo(artifact.createdAt)}` : timeAgo(artifact.updatedAt)
            )}
          </div>
        </div>
      </div>
      ${
        collectionChip || tagChips || sourceBadge || sharedBadge
          ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:10px">${collectionChip}${tagChips}${sourceBadge}${sharedBadge}</div>`
          : ''
      }
    </button>`
}

// ---------------------------------------------------------------
// Library (§80)
// ---------------------------------------------------------------

function selectionLabel(n) {
  return n ? `${n} selected` : 'Tap artifacts to select'
}

export function renderLibrary(ctx) {
  const state = ctx.state
  const activeType = ctx.filters.type || 'all'
  const collections = state.collections || []
  const activeCollection = collections.find((c) => c.id === ctx.filters.collectionId) || null
  const sort = ctx.filters.sort || 'created'

  const types = [
    ['all', 'All'],
    ['pptx', 'PPTX'],
    ['pdf', 'PDF'],
    ['docx', 'DOCX'],
    ['html', 'HTML'],
    ['image', 'Images'],
    ['audio', 'Audio'],
    ['video', 'Video']
  ]

  const sorts = [
    ['created', 'Newest first'],
    ['oldest', 'Oldest first'],
    ['updated', 'Recently updated'],
    ['title', 'Title A–Z']
  ]

  const visible = state.artifacts.filter((a) => {
    if (activeType === 'all') return true
    if (activeType === 'image') return ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'].includes(a.extension)
    if (activeType === 'audio' || activeType === 'video') return mediaKind(`x.${a.extension}`) === activeType
    return a.extension === activeType
  })

  const pill = (attr, value, label, active, extra = '') => `
    <button role="tab" aria-selected="${active}" ${attr}="${esc(value)}" class="filter-pill${active ? ' is-active' : ''}">
      ${extra}${esc(label)}
    </button>`

  const filtered = Boolean(ctx.filters.q || activeCollection || activeType !== 'all')

  // What this person may do to many artifacts at once in this workspace. The
  // server checks every artifact again; this only decides what to offer.
  const workspace = (state.workspaces || []).find((w) => w.id === state.currentWorkspaceId) || {}
  const canDelete = Boolean(workspace.canDelete)
  const canManage = Boolean(workspace.canManageCollections)
  const selection = ctx.selection
  const selecting = selection.active && (canDelete || canManage)
  // Only what is on screen can be selected, so a filter change drops the rest.
  for (const id of [...selection.ids]) if (!visible.some((a) => a.id === id)) selection.ids.delete(id)
  const allSelected = visible.length > 0 && visible.every((a) => selection.ids.has(a.id))
  const canUploadHere = Boolean(activeCollection) && canManage && !selecting

  return {
    html: `
      ${screenHeader({
        title: 'Library',
        rightId: 'library-menu',
        rightLabel: 'Library options'
      })}

      <main class="app-main" style="padding-top:12px">
        <label class="input" style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
          ${icon('search', 18)}
          <input id="library-search" type="search" placeholder="Search artifacts" aria-label="Search artifacts"
            value="${esc(ctx.filters.q || '')}"
            style="border:0;outline:0;background:transparent;font-size:15px;width:100%;font-family:inherit;color:var(--text)">
        </label>

        <div class="filter-label" id="library-type-label">File type</div>
        <div role="tablist" aria-labelledby="library-type-label" class="filter-row">
          ${types.map(([value, label]) => pill('data-type', value, label, activeType === value)).join('')}
        </div>

        <div class="filter-label" id="library-collection-label">Collection</div>
        <div role="tablist" aria-labelledby="library-collection-label" class="filter-row">
          ${pill('data-collection-filter', '', 'All', !activeCollection)}
          ${collections
            .map((c) =>
              pill(
                'data-collection-filter',
                c.id,
                `${c.name} · ${c.artifactCount}`,
                activeCollection?.id === c.id,
                icon('folder', 13)
              )
            )
            .join('')}
          <button class="filter-pill filter-pill-new" id="library-new-collection">${icon('plus', 13)} New</button>
        </div>

        <div class="library-toolbar">
          <span style="font-size:12.5px;color:var(--text-2);white-space:nowrap">
            ${visible.length} artifact${visible.length === 1 ? '' : 's'}${
              activeCollection ? ` in ${esc(activeCollection.name)}` : ''
            }
          </span>
          <div class="library-actions">
            ${
              canUploadHere
                ? `<button class="toolbar-btn" id="library-bulk-upload">${icon('upload', 15)} Upload files</button>`
                : ''
            }
            ${
              selecting
                ? `<button class="toolbar-btn" id="library-select-all">${allSelected ? 'Clear all' : 'Select all'}</button>
                   <button class="toolbar-btn" id="library-select-done">Done</button>`
                : (canDelete || canManage) && visible.length
                  ? `<button class="toolbar-btn" id="library-select">${icon('check', 15)} Select</button>`
                  : ''
            }
            <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text-2)">
              <span class="sr-only">Sort</span>
              <select id="library-sort" class="sort-select" aria-label="Sort artifacts">
                ${sorts
                  .map(([value, label]) => `<option value="${value}" ${sort === value ? 'selected' : ''}>${esc(label)}</option>`)
                  .join('')}
              </select>
            </label>
          </div>
        </div>

        ${
          visible.length
            ? `<div style="display:flex;flex-direction:column;gap:10px">
                ${visible
                  .map((a) =>
                    artifactCard(a, {
                      dateField: sort === 'created' || sort === 'oldest' ? 'created' : 'updated',
                      selectable: selecting,
                      selected: selecting && selection.ids.has(a.id)
                    })
                  )
                  .join('')}
               </div>
               ${
                 selecting
                   ? `<div class="bulk-bar-spacer"></div>
                      <div class="bulk-bar" role="toolbar" aria-label="Selected artifacts">
                        <span class="bulk-bar-count" id="bulk-count">${selectionLabel(selection.ids.size)}</span>
                        ${
                          canManage
                            ? `<button class="btn btn-bar" id="bulk-move" ${selection.ids.size ? '' : 'disabled'}>${icon('folder', 16)} Set collection</button>`
                            : ''
                        }
                        ${
                          canDelete
                            ? `<button class="btn btn-bar-danger" id="bulk-delete" ${selection.ids.size ? '' : 'disabled'}>${icon('trash', 16)} Delete</button>`
                            : ''
                        }
                      </div>`
                   : ''
               }`
            : `<div class="card" style="padding:4px 0 12px">
                ${emptyState({
                  iconName: activeCollection ? 'folder' : 'library',
                  title: ctx.filters.q
                    ? 'No matches'
                    : activeCollection
                      ? 'Nothing in this collection yet'
                      : 'No artifacts here yet',
                  message: ctx.filters.q
                    ? 'Try a different search term or clear the filter.'
                    : activeCollection
                      ? 'Upload files straight into it, or move artifacts here from the library.'
                      : 'Add a file, or save AI output straight into this workspace.',
                  action: canUploadHere && !ctx.filters.q && activeType === 'all'
                    ? `<button class="btn btn-primary" id="library-bulk-upload-empty">${icon('upload', 18)} Upload files</button>`
                    : filtered && !ctx.filters.q
                      ? '<button class="btn btn-secondary" id="library-clear">Show everything</button>'
                      : '<button class="btn btn-primary" id="library-add">Add an artifact</button>'
                })}
               </div>`
        }
        ${ctx.appFooter()}
      </main>
      ${ctx.bottomNav('library')}`,
    mount(root) {
      const searchInput = root.querySelector('#library-search')
      searchInput?.addEventListener('input', (e) => {
        ctx.filters.q = e.target.value
        ctx.debouncedFilter()
      })

      root.querySelectorAll('[data-type]').forEach((button) => {
        button.addEventListener('click', () => {
          ctx.filters.type = button.dataset.type
          ctx.refresh()
        })
      })

      // Selection. A tap toggles the card in place, so the list keeps its
      // scroll position; entering or leaving selection re-renders.
      root.querySelector('#library-select')?.addEventListener('click', () => {
        selection.active = true
        selection.ids.clear()
        ctx.refresh()
      })
      root.querySelector('#library-select-done')?.addEventListener('click', () => ctx.clearSelection())
      root.querySelector('#library-select-all')?.addEventListener('click', () => {
        if (allSelected) selection.ids.clear()
        else visible.forEach((a) => selection.ids.add(a.id))
        ctx.refresh()
      })
      root.querySelectorAll('[data-select]').forEach((card) => {
        card.addEventListener('click', () => {
          const id = card.dataset.select
          const on = !selection.ids.has(id)
          if (on) selection.ids.add(id)
          else selection.ids.delete(id)
          card.classList.toggle('is-selected', on)
          card.setAttribute('aria-pressed', String(on))
          card.querySelector('.select-check').innerHTML = on ? icon('check', 15) : ''
          const count = root.querySelector('#bulk-count')
          if (count) count.textContent = selectionLabel(selection.ids.size)
          root.querySelectorAll('#bulk-move, #bulk-delete').forEach((b) => (b.disabled = !selection.ids.size))
          const toggleAll = root.querySelector('#library-select-all')
          if (toggleAll) {
            toggleAll.textContent = visible.every((a) => selection.ids.has(a.id)) ? 'Clear all' : 'Select all'
          }
        })
      })
      const chosen = () => visible.filter((a) => selection.ids.has(a.id))
      root.querySelector('#bulk-move')?.addEventListener('click', () => ctx.openBulkCollectionSheet(chosen()))
      root.querySelector('#bulk-delete')?.addEventListener('click', () => ctx.confirmDeleteArtifacts(chosen()))

      root
        .querySelectorAll('#library-bulk-upload, #library-bulk-upload-empty')
        .forEach((button) => button.addEventListener('click', () => ctx.openBulkUploadSheet(activeCollection)))

      // Collection and sort change what the server returns, so both reload.
      root.querySelectorAll('[data-collection-filter]').forEach((button) => {
        button.addEventListener('click', () => {
          ctx.filters.collectionId = button.dataset.collectionFilter || null
          ctx.reload()
        })
      })

      root.querySelector('#library-sort')?.addEventListener('change', (e) => {
        ctx.filters.sort = e.target.value
        ctx.reload()
      })

      root.querySelector('#library-new-collection')?.addEventListener('click', () => ctx.openCollectionCreateSheet())

      root.querySelector('#library-clear')?.addEventListener('click', () => {
        ctx.filters.type = 'all'
        ctx.filters.collectionId = null
        ctx.reload()
      })

      root.querySelector('#library-add')?.addEventListener('click', () => ctx.openAddSheet())

      root.querySelector('#library-menu')?.addEventListener('click', () => {
        sheet({
          title: 'Library options',
          content: `
            <button class="row" id="opt-collections">${icon('folder', 19)} Browse collections</button>
            <button class="row" id="opt-tags">${icon('tag', 19)} Browse tags</button>
          `,
          onMount(handle) {
            handle.body.querySelector('#opt-collections')?.addEventListener('click', () => {
              ctx.openCollectionsSheet()
            })
            handle.body.querySelector('#opt-tags')?.addEventListener('click', () => {
              ctx.openTagsSheet()
            })
          }
        })
      })
    }
  }
}

// ---------------------------------------------------------------
// Search (§83, §84)
// ---------------------------------------------------------------

export function renderSearch(ctx) {
  const state = ctx.state

  return {
    html: `
      ${screenHeader({ title: 'Search', rightId: 'search-filters', rightLabel: 'Filters' })}

      <main class="app-main" style="padding-top:12px">
        <label class="input" style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
          ${icon('search', 18)}
          <input id="search-input" type="search" placeholder="What are you looking for?" autofocus
            aria-label="Search query" value="${esc(ctx.search.query || '')}"
            style="border:0;outline:0;background:transparent;font-size:15px;width:100%;font-family:inherit;color:var(--text)">
        </label>

        ${
          ctx.search.activeFilters.length
            ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px">
                ${ctx.search.activeFilters
                  .map(
                    (f) => `<button class="chip" data-clear-filter="${esc(f.key)}" style="min-height:30px;padding:4px 10px;cursor:pointer">
                      ${esc(f.label)} ${icon('x', 12)}
                    </button>`
                  )
                  .join('')}
               </div>`
            : ''
        }

        ${
          !ctx.search.performed
            ? `
          <section aria-labelledby="recent-searches">
            ${
              state.recentSearches?.length
                ? `<h2 id="recent-searches" style="font-size:14px;font-weight:640;margin:4px 0 8px">Recent searches</h2>
                   <div style="display:flex;flex-direction:column">
                     ${state.recentSearches
                       .map(
                         (q) => `<button class="row" data-recent="${esc(q)}">
                           ${icon('clock', 17)}
                           <span style="flex:1">${esc(q)}</span>
                         </button>`
                       )
                       .join('')}
                   </div>`
                : ''
            }
          </section>

          <section aria-labelledby="search-hints" style="margin-top:20px">
            <h2 id="search-hints" style="font-size:14px;font-weight:640;margin:0 0 8px">Try</h2>
            <div style="display:flex;flex-wrap:wrap;gap:7px">
              ${['Malaysia energy presentation', 'strategy deck about AI', 'proposals for customers', 'updated last month']
                .map((s) => `<button class="chip" data-suggestion="${esc(s)}" style="min-height:34px;padding:7px 12px;cursor:pointer">${esc(s)}</button>`)
                .join('')}
            </div>
          </section>`
            : ctx.search.loading
              ? `<div style="display:flex;flex-direction:column;gap:10px">
                  ${Array.from({ length: 3 })
                    .map(
                      () => `<div class="card" style="padding:12px">
                        <div style="display:flex;gap:11px">
                          <div class="skeleton" style="width:46px;height:46px;border-radius:11px"></div>
                          <div style="flex:1">
                            <div class="skeleton" style="height:13px;width:70%;margin-bottom:8px"></div>
                            <div class="skeleton" style="height:11px;width:40%"></div>
                          </div>
                        </div>
                      </div>`
                    )
                    .join('')}
                 </div>`
              : ctx.search.results.length
                ? `
            <div style="font-size:12.5px;color:var(--text-2);margin-bottom:10px;
              display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span>${ctx.search.total} result${ctx.search.total === 1 ? '' : 's'}</span>
              ${
                // An explicit answer either way. Relying on the badge being
                // absent to mean "it did not run" would be ambiguous — the
                // whole point is to confirm that semantic search actually ran.
                ctx.search.engine?.semantic
                  ? '<span class="chip" title="Results also come from meaning-based search">Meaning search on</span>'
                  : '<span class="chip" title="Keyword search">Keyword search</span>'
              }
            </div>
            <div style="display:flex;flex-direction:column;gap:10px">
              ${ctx.search.results
                .map(
                  (r) => `
                <button class="card" data-artifact="${esc(r.id)}" style="padding:12px;display:block;text-align:left;cursor:pointer">
                  <div style="display:flex;gap:11px;align-items:flex-start">
                    ${fileBadge(r.extension)}
                    <div style="flex:1;min-width:0">
                      <div style="font-size:14.5px;font-weight:600;line-height:1.35;
                        display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">
                        ${esc(r.title)}
                      </div>
                      <div style="font-size:11.5px;color:var(--text-2);margin-top:4px">
                        ${esc(kindLabel(r.extension))} · ${esc(r.workspaceName || '')}
                      </div>
                      ${
                        // How this particular result was found. Plain words, no
                        // engine or index names: the distinction a user cares
                        // about is whether the match is by wording or by meaning.
                        r.matchSource === 'semantic'
                          ? '<div style="margin-top:6px"><span class="chip">Found by meaning</span></div>'
                          : r.matchSource === 'both'
                            ? '<div style="margin-top:6px"><span class="chip">Wording + meaning</span></div>'
                            : ''
                      }
                      <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">Updated ${esc(timeAgo(r.updatedAt))}</div>
                      ${
                        (r.tags || []).length
                          ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:8px">
                              ${r.tags.slice(0, 3).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}
                             </div>`
                          : ''
                      }
                    </div>
                  </div>
                </button>`
                )
                .join('')}
            </div>`
                : `<div class="card" style="padding:4px 0 12px">
                    ${emptyState({
                      iconName: 'search',
                      title: 'No results',
                      message: 'Nothing matched that query within the workspaces you can access.'
                    })}
                   </div>`
        }
        ${ctx.appFooter()}
      </main>
      ${ctx.bottomNav('search')}`,
    mount(root) {
      const input = root.querySelector('#search-input')

      input?.addEventListener('input', (e) => {
        ctx.search.query = e.target.value
        ctx.debouncedSearch()
      })
      input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') ctx.runSearch()
      })

      root.querySelectorAll('[data-recent]').forEach((button) => {
        button.addEventListener('click', () => {
          ctx.search.query = button.dataset.recent
          ctx.runSearch()
        })
      })

      root.querySelectorAll('[data-suggestion]').forEach((button) => {
        button.addEventListener('click', () => {
          ctx.search.query = button.dataset.suggestion
          ctx.runSearch()
        })
      })

      root.querySelectorAll('[data-clear-filter]').forEach((button) => {
        button.addEventListener('click', () => {
          ctx.clearSearchFilter(button.dataset.clearFilter)
        })
      })

      root.querySelector('#search-filters')?.addEventListener('click', () => ctx.openFilterSheet())

      // Restore focus to the query field when re-rendering after a search
      if (ctx.search.performed && ctx.search.query) {
        setTimeout(() => {
          const el = root.querySelector('#search-input')
          if (el && document.activeElement?.tagName !== 'INPUT') el.focus()
        }, 40)
      }
    }
  }
}

// ---------------------------------------------------------------
// Add (§85)
// ---------------------------------------------------------------

export function renderAdd(ctx) {
  return {
    html: `
      ${screenHeader({ title: 'Add to library', onBackId: 'add-back' })}
      <main class="app-main" style="padding-top:8px">
        <div class="card" style="overflow:hidden">
          <button class="row" id="add-upload" style="padding:12px 14px">
            ${icon('upload', 20)} <span style="flex:1">Upload a file</span> ${icon('chevron', 16)}
          </button>
          <button class="row" id="add-html" style="padding:12px 14px">
            ${icon('globe', 20)} <span style="flex:1">Save HTML or text</span> ${icon('chevron', 16)}
          </button>
          <button class="row" id="add-collection" style="padding:12px 14px">
            ${icon('folder', 20)} <span style="flex:1">Create a collection</span> ${icon('chevron', 16)}
          </button>
        </div>

        <h2 style="font-size:14px;font-weight:640;margin:22px 0 9px">Connected AI</h2>
        <div class="card" style="overflow:hidden">
          <button class="row" data-nav="/connect" style="padding:12px 14px">
            ${icon('ai', 20)}
            <span style="flex:1">
              Set up Claude, ChatGPT, Cursor and more
              <span style="display:block;font-size:11.5px;color:var(--text-2)">Step-by-step setup for each AI tool</span>
            </span>
            ${icon('chevron', 16)}
          </button>
          ${
            (ctx.state.integrations || []).length
              ? ctx.state.integrations
                  .map(
                    (i) => `
            <button class="row" data-connect="${esc(i.integrationId)}" style="padding:12px 14px">
              ${icon('ai', 20)}
              <span style="flex:1">
                ${esc(i.name)}
                <span style="display:block;font-size:11.5px;color:var(--text-2)">
                  ${i.connected ? `Connected · ${(i.scopes || []).length} scope(s)` : 'Not connected'}
                </span>
              </span>
              ${
                i.connected
                  ? `<span class="chip" style="background:var(--success-weak);color:var(--success)">${icon('check', 12)} Connected</span>`
                  : `<span class="chip">Connect</span>`
              }
            </button>`
                  )
                  .join('')
              : '<p style="padding:16px;font-size:13px;color:var(--text-2);margin:0">No connectors available.</p>'
          }
        </div>

        <p style="font-size:12px;color:var(--text-3);margin:18px 0 0;line-height:1.6">
          An AI app must be connected before it can save into your library. It never receives more
          access than you have.
        </p>

        ${ctx.appFooter()}
      </main>`,
    mount(root) {
      root.querySelector('#add-back')?.addEventListener('click', () => ctx.navigate('/'))
      root.querySelector('#add-upload')?.addEventListener('click', () => ctx.openUploadSheet())
      root.querySelector('#add-html')?.addEventListener('click', () => ctx.openContentSheet())
      root.querySelector('#add-collection')?.addEventListener('click', () => ctx.openCollectionCreateSheet())

      root.querySelectorAll('[data-connect]').forEach((button) => {
        button.addEventListener('click', () => {
          const id = button.dataset.connect
          const integration = (ctx.state.integrations || []).find((i) => i.integrationId === id)
          if (integration?.connected) ctx.openIntegrationSheet(integration)
          else ctx.openConnectSheet(integration)
        })
      })
    }
  }
}

// ---------------------------------------------------------------
// Profile / settings (§89)
// ---------------------------------------------------------------

export function renderProfile(ctx) {
  const state = ctx.state
  const profile = state.profile || {}
  const usage = profile.usage || { artifacts: 0, bytes: 0, downloads: 0, views: 0 }

  return {
    html: `
      ${screenHeader({ title: 'Profile', rightId: 'profile-menu', rightLabel: 'Settings' })}

      <main class="app-main" style="padding-top:8px">
        <div class="card" style="padding:16px;display:flex;gap:13px;align-items:center">
          <button class="avatar-edit" id="profile-avatar" aria-label="${state.me?.avatarUrl ? 'Change profile picture' : 'Add a profile picture'}">
            ${avatar({ url: state.me?.avatarUrl, name: state.me?.displayName || state.me?.email, size: 56 })}
            <span class="avatar-edit-badge" aria-hidden="true">${icon('upload', 12)}</span>
          </button>
          <div style="min-width:0;flex:1">
            <div style="font-size:15px;font-weight:620;overflow:hidden;text-overflow:ellipsis">${esc(state.me?.displayName || '')}</div>
            <div style="font-size:12.5px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis">${esc(state.me?.email || '')}</div>
          </div>
          <button class="btn btn-ghost" id="profile-edit" style="min-width:44px;padding:0 8px" aria-label="Edit name">${icon('file', 19)}</button>
        </div>

        <div class="stats" style="margin-top:12px">
          <div class="stat-tile">
            <div class="stat-value">${usage.artifacts}</div>
            <div class="stat-label">Artifacts</div>
          </div>
          <div class="stat-tile">
            <div class="stat-value">${esc(formatBytes(usage.bytes))}</div>
            <div class="stat-label">Stored</div>
          </div>
          <div class="stat-tile">
            <div class="stat-value">${usage.views}</div>
            <div class="stat-label">Views</div>
          </div>
          <div class="stat-tile">
            <div class="stat-value">${usage.downloads}</div>
            <div class="stat-label">Downloads</div>
          </div>
        </div>

        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:22px 0 9px">
          <h2 style="font-size:14px;font-weight:640;margin:0">Workspaces</h2>
          <button class="btn btn-secondary" id="profile-new-workspace" style="min-height:36px;padding:0 12px">${icon('plus', 16)} New workspace</button>
        </div>
        <div class="card" style="overflow:hidden">
          ${(state.workspaces || [])
            .map(
              (w) => `
            <button class="row" data-workspace="${esc(w.id)}" style="padding:12px 14px">
              ${icon(w.type === 'PERSONAL' ? 'user' : 'building', 20)}
              <span style="flex:1">
                ${esc(w.name)}
                <span style="display:block;font-size:11.5px;color:var(--text-2)">${esc(
                  w.type === 'PERSONAL' ? 'Personal workspace' : `Shared workspace · ${roleLabel(w.role)}`
                )}</span>
              </span>
              ${icon('chevron', 16)}
            </button>`
            )
            .join('')}
        </div>

        ${
          (state.organizations || []).length
            ? `<h2 style="font-size:14px;font-weight:640;margin:22px 0 9px">Organizations</h2>
               <div class="card" style="overflow:hidden">
                 ${state.organizations
                   .map(
                     (o) => `
                   <button class="row" data-org="${esc(o.id)}" style="padding:12px 14px">
                     ${icon('building', 20)}
                     <span style="flex:1">
                       ${esc(o.name)}
                       <span style="display:block;font-size:11.5px;color:var(--text-2)">${esc(roleLabel(o.role))} · ${esc(o.plan)}</span>
                     </span>
                     ${icon('chevron', 16)}
                   </button>`
                   )
                   .join('')}
               </div>`
            : ''
        }

        <h2 style="font-size:14px;font-weight:640;margin:22px 0 9px">Connected AI apps</h2>
        <div class="card" style="overflow:hidden">
          <button class="row" data-nav="/connect" style="padding:12px 14px">
            ${icon('ai', 20)}
            <span style="flex:1">
              Set up Claude, ChatGPT, Cursor and more
              <span style="display:block;font-size:11.5px;color:var(--text-2)">Step-by-step setup for each AI tool</span>
            </span>
            ${icon('chevron', 16)}
          </button>
          ${
            (state.integrations || []).length
              ? state.integrations
                  .map(
                    (i) => `
            <button class="row" data-manage-integration="${esc(i.integrationId)}" style="padding:12px 14px">
              ${icon('ai', 20)}
              <span style="flex:1">
                ${esc(i.name)}
                <span style="display:block;font-size:11.5px;color:var(--text-2)">
                  ${i.connected ? `${(i.scopes || []).map((s) => esc(s.replace('artifact.', '').replace('.read', ' r').replace('.write', ' w'))).join(' · ')}` : 'Not connected'}
                </span>
              </span>
              ${
                i.connected
                  ? `<span class="chip" style="background:var(--success-weak);color:var(--success)">${icon('check', 12)}</span>`
                  : '<span class="chip">Connect</span>'
              }
            </button>`
                  )
                  .join('')
              : '<p style="padding:16px;font-size:13px;color:var(--text-2);margin:0">No connectors configured.</p>'
          }
        </div>

        <h2 style="font-size:14px;font-weight:640;margin:22px 0 9px">Active shares</h2>
        <div class="card" style="overflow:hidden">
          ${
            (profile.activeShares || []).length
              ? profile.activeShares
                  .map(
                    (s) => `
            <button class="row" data-share-manage="${esc(s.id)}" style="padding:12px 14px">
              ${icon(s.accessType === 'PUBLIC_LINK' ? 'link' : s.accessType === 'DOMAIN' ? 'building' : 'mail', 19)}
              <span style="flex:1;min-width:0">
                <span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.title || s.targetId)}</span>
                <span style="display:block;font-size:11.5px;color:var(--text-2)">
                  ${esc(s.accessType.replace('_', ' ').toLowerCase())} ·
                  ${s.expiresAt ? `expires ${esc(formatDate(s.expiresAt))}` : 'no expiry'}
                </span>
              </span>
              ${s.isExpired ? '<span class="chip">Expired</span>' : '<span class="chip" style="background:var(--success-weak);color:var(--success)">Active</span>'}
            </button>`
                  )
                  .join('')
              : '<p style="padding:16px;font-size:13px;color:var(--text-2);margin:0">You have no active shares.</p>'
          }
        </div>

        ${
          (state.workspaces || []).length
            ? `<div class="card nav-mobile-only" style="overflow:hidden;margin-top:22px">
                 <button class="row" id="profile-workspace" style="padding:12px 14px">
                   ${icon('building', 20)} <span style="flex:1">Workspace settings</span> ${icon('chevron', 16)}
                 </button>
               </div>`
            : ''
        }

        <h2 style="font-size:14px;font-weight:640;margin:22px 0 9px">Help</h2>
        <div class="card" style="overflow:hidden">
          <button class="row" id="profile-guide" style="padding:12px 14px">
            ${icon('file', 20)} <span style="flex:1">User guide &amp; help</span> ${icon('chevron', 16)}
          </button>
          <button class="row" id="profile-shortcuts" style="padding:12px 14px">
            ${icon('search', 20)} <span style="flex:1">Keyboard &amp; tips</span> ${icon('chevron', 16)}
          </button>
        </div>

        <div class="card" style="overflow:hidden;margin-top:22px">
          <button class="row" id="profile-tags" style="padding:12px 14px">${icon('tag', 20)} <span style="flex:1">Tag management</span> ${icon('chevron', 16)}</button>
          <button class="row" id="profile-activity" style="padding:12px 14px">${icon('chart', 20)} <span style="flex:1">Recent activity</span> ${icon('chevron', 16)}</button>
          <button class="row" id="profile-logout" style="padding:12px 14px;color:var(--danger)">
            ${icon('logout', 20)} <span style="flex:1">Sign out</span>
          </button>
        </div>

        <p style="font-size:11.5px;color:var(--text-3);text-align:center;margin:20px 0 0;line-height:1.6">
          ${esc(state.me?.email || '')}<br>
          ${icon('shield', 12)} Artifacts are private unless shared
        </p>

        ${ctx.appFooter()}
      </main>
      ${ctx.bottomNav('profile')}`,
    mount(root) {
      root.querySelector('#profile-edit')?.addEventListener('click', () => ctx.openEditNameSheet())
      root.querySelector('#profile-avatar')?.addEventListener('click', () => ctx.openAvatarSheet())
      root.querySelector('#profile-workspace')?.addEventListener('click', () => ctx.navigate('/workspace'))
      root.querySelector('#profile-guide')?.addEventListener('click', () => ctx.navigate('/guide'))
      root.querySelector('#profile-shortcuts')?.addEventListener('click', () => ctx.openShortcutsSheet())
      root.querySelector('#profile-tags')?.addEventListener('click', () => ctx.openTagsSheet({ manage: true }))
      root.querySelector('#profile-activity')?.addEventListener('click', () => ctx.openActivitySheet())
      root.querySelector('#profile-logout')?.addEventListener('click', () => ctx.signOut())

      root.querySelectorAll('[data-workspace]').forEach((button) => {
        button.addEventListener('click', () => ctx.openWorkspaceSheet(button.dataset.workspace))
      })
      root.querySelector('#profile-new-workspace')?.addEventListener('click', () => ctx.openCreateWorkspaceSheet())
      root.querySelectorAll('[data-org]').forEach((button) => {
        button.addEventListener('click', () => ctx.openOrgSheet(button.dataset.org))
      })
      root.querySelectorAll('[data-manage-integration]').forEach((button) => {
        button.addEventListener('click', () => {
          const integration = (ctx.state.integrations || []).find(
            (i) => i.integrationId === button.dataset.manageIntegration
          )
          if (integration?.connected) ctx.openIntegrationSheet(integration)
          else ctx.openConnectSheet(integration)
        })
      })
      root.querySelectorAll('[data-share-manage]').forEach((button) => {
        button.addEventListener('click', () => ctx.openShareManageSheet(button.dataset.shareManage))
      })
      root.querySelector('#profile-menu')?.addEventListener('click', () => {
        root.querySelector('#profile-tags')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    }
  }
}

// ---------------------------------------------------------------
// Admin (§90) — cards, never wide tables
// ---------------------------------------------------------------

export function renderAdmin(ctx) {
  const state = ctx.state
  const org = state.adminOrg

  if (!org) {
    return {
      html: `
        ${screenHeader({ title: 'Administration', onBackId: 'admin-back' })}
        <main class="app-main">
          <div class="card" style="padding:4px 0 12px">
            ${emptyState({
              iconName: 'building',
              title: 'No administration access',
              message: 'You are not an owner or admin of any organization.',
              action: '<button class="btn btn-secondary" id="admin-create-org">Create an organization</button>'
            })}
          </div>

          ${ctx.appFooter()}
        </main>`,
      mount(root) {
        root.querySelector('#admin-back')?.addEventListener('click', () => ctx.navigate('/profile'))
        root.querySelector('#admin-create-org')?.addEventListener('click', () => ctx.openCreateOrgSheet())
      }
    }
  }

  return {
    html: `
      ${screenHeader({ title: 'Administration', subtitle: org.name, onBackId: 'admin-back', rightId: 'admin-menu' })}

      <main class="app-main" style="padding-top:8px">
        <div class="stats">
          <div class="stat-tile">
            <div class="stat-value">${ctx.adminTotals?.artifacts ?? 0}</div>
            <div class="stat-label">Artifacts</div>
          </div>
          <div class="stat-tile">
            <div class="stat-value">${ctx.adminTotals?.members ?? 0}</div>
            <div class="stat-label">Members</div>
          </div>
          <div class="stat-tile">
            <div class="stat-value">${ctx.adminTotals?.views ?? 0}</div>
            <div class="stat-label">Views · 30d</div>
          </div>
          <div class="stat-tile">
            <div class="stat-value">${ctx.adminTotals?.aiReferences ?? 0}</div>
            <div class="stat-label">AI references</div>
          </div>
        </div>

        <h2 style="font-size:14px;font-weight:640;margin:22px 0 9px">Members</h2>
        <div style="display:flex;flex-direction:column;gap:9px">
          ${
            (state.adminMembers || []).length
              ? state.adminMembers
                  .map(
                    (m) => `
            <div class="list-row">
              ${avatar({ url: m.avatarUrl, name: m.displayName || m.email, size: 38 })}
              <div style="flex:1;min-width:0">
                <div style="font-size:14.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis">${esc(m.displayName || m.email)}</div>
                <div style="font-size:12px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis">${esc(m.email)}</div>
                <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">
                  ${esc(roleLabel(m.role))} · ${m.workspaceCount} workspace${m.workspaceCount === 1 ? '' : 's'}
                </div>
              </div>
              <button class="btn btn-ghost" data-member="${esc(m.userId)}" style="min-width:44px;padding:0 6px" aria-label="Member options">${icon('more', 19)}</button>
            </div>`
                  )
                  .join('')
              : '<p style="font-size:13px;color:var(--text-2)">No members yet.</p>'
          }
        </div>

        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:22px 0 9px">
          <h2 id="admin-workspaces-heading" style="font-size:14px;font-weight:640;margin:0">Workspaces</h2>
          <button class="btn btn-secondary" id="admin-new-workspace" style="min-height:36px;padding:0 12px">${icon('plus', 16)} New workspace</button>
        </div>
        <div class="card" style="overflow:hidden">
          ${
            (state.adminWorkspaces || []).length
              ? state.adminWorkspaces
                  .map(
                    (w) => `
            <button class="row" data-workspace="${esc(w.id)}" style="padding:12px 14px">
              ${icon('building', 19)}
              <span style="flex:1">
                ${esc(w.name)}
                <span style="display:block;font-size:11.5px;color:var(--text-2)">${w.artifacts} artifact(s) · ${w.views} views</span>
              </span>
              ${icon('chevron', 16)}
            </button>`
                  )
                  .join('')
              : '<p style="padding:16px;font-size:13px;color:var(--text-2);margin:0">No workspaces.</p>'
          }
        </div>

        <div class="card" style="padding:14px;margin-top:22px;display:flex;gap:12px;align-items:center">
          ${icon('globe', 19)}
          <p style="flex:1;font-size:13px;color:var(--text-2);margin:0;line-height:1.5">
            Custom share URLs, invitations and access tiers are set per workspace.
          </p>
          <button class="btn btn-secondary" id="admin-open-workspace" style="min-height:36px;padding:0 12px">Workspace settings</button>
        </div>

        <h2 style="font-size:14px;font-weight:640;margin:22px 0 9px">Created with AI</h2>
        <div class="card" style="overflow:hidden">
          ${
            (ctx.adminProviderStats || []).length
              ? ctx.adminProviderStats
                  .map(
                    (p) => `
            <div class="row" style="padding:12px 14px">
              ${icon('sparkle', 19)}
              <span style="flex:1">${esc(p.provider.replace('_', ' '))}</span>
              <span class="chip">${p.count}</span>
            </div>`
                  )
                  .join('')
              : '<p style="padding:16px;font-size:13px;color:var(--text-2);margin:0">No AI-created artifacts.</p>'
          }
        </div>

        ${ctx.appFooter()}
      </main>`,
    mount(root) {
      root.querySelector('#admin-back')?.addEventListener('click', () => ctx.navigate('/profile'))
      root.querySelectorAll('[data-workspace]').forEach((button) => {
        button.addEventListener('click', () => ctx.openWorkspaceSheet(button.dataset.workspace))
      })
      root.querySelectorAll('[data-member]').forEach((button) => {
        button.addEventListener('click', () => ctx.openMemberSheet(button.dataset.member))
      })
      root.querySelector('#admin-new-workspace')?.addEventListener('click', () =>
        ctx.openCreateWorkspaceSheet({ organizationId: org.id, organizationName: org.name })
      )
      root.querySelector('#admin-menu')?.addEventListener('click', () => ctx.openAdminMenuSheet())
      root.querySelector('#admin-open-workspace')?.addEventListener('click', () => ctx.navigate('/workspace'))
    }
  }
}

// ---------------------------------------------------------------
// External share recipient (§42)
// ---------------------------------------------------------------

export function renderShareRecipient(ctx) {
  const view = ctx.share

  if (view.loading) {
    return {
      html: `
        <main class="app-main" style="padding-top:calc(var(--safe-top) + 40px)">
          <div class="card" style="padding:24px;text-align:center">
            <div class="skeleton" style="height:14px;width:50%;margin:0 auto 12px"></div>
            <div class="skeleton" style="height:11px;width:30%;margin:0 auto"></div>
          </div>
        </main>`
    }
  }

  const shell = (inner) => `
    <main class="app-main" style="padding-top:calc(var(--safe-top) + 24px);min-height:100vh">
      <div style="display:flex;align-items:center;gap:9px;margin-bottom:20px;justify-content:center">
        <h1 class="sr-only">Artifactry</h1>
        <!-- Recipients may never have met the brand, so the share page uses
             the full lockup: the kit reserves the bare symbol for places
             where the name already appears nearby. -->
        ${brandLockup(32)}
      </div>
      ${inner}
      ${ctx.appFooter()}
    </main>`

  // Verification gate (§37, §38)
  if (view.requiresVerification && !view.accessible) {
    return {
      html: shell(`
        <div class="card" style="padding:18px">
          <h1 style="font-size:19px;font-weight:640;margin:0 0 6px">Verify your email</h1>
          <p style="font-size:13.5px;color:var(--text-2);margin:0 0 18px;line-height:1.55">
            This item was shared with a specific ${view.accessType === 'DOMAIN' ? 'email domain' : 'email address'}.
            Confirm your address to continue.
          </p>

          ${
            view.stage === 'code'
              ? `
            <label for="share-code" style="font-size:13px;font-weight:600;display:block;margin-bottom:7px">6-digit code</label>
            <input id="share-code" class="input" type="text" inputmode="numeric" autocomplete="one-time-code"
              maxlength="8" placeholder="000000"
              style="letter-spacing:6px;font-size:20px;text-align:center;font-weight:600">
            ${
              ctx.shareDevCode
                ? `<div style="margin-top:12px;padding:11px 13px;border-radius:11px;background:var(--warning-weak);
                     border:1px solid #fedf89;font-size:12.5px">
                     <strong>Development mode.</strong> Your code is
                     <span style="font-family:var(--font-mono);font-weight:700">${esc(ctx.shareDevCode)}</span>
                   </div>`
                : ''
            }
            <button class="btn btn-accent btn-block" id="share-verify" style="margin-top:16px">Verify and open</button>
            <button class="btn btn-ghost btn-block" id="share-change-email" style="margin-top:6px">Use a different email</button>`
              : `
            <label for="share-email" style="font-size:13px;font-weight:600;display:block;margin-bottom:7px">Your email</label>
            <input id="share-email" class="input" type="email" inputmode="email" autocomplete="email"
              placeholder="you@company.com">
            <button class="btn btn-primary btn-block" id="share-send" style="margin-top:16px">Send verification code</button>`
          }
        </div>

        <p style="font-size:11.5px;color:var(--text-3);text-align:center;margin-top:18px;line-height:1.6">
          ${icon('lock', 12)} Your address is only used to confirm access to this item.
        </p>
      `),
      mount(root) {
        root.querySelector('#share-send')?.addEventListener('click', async () => {
          const email = (root.querySelector('#share-email')?.value || '').trim()
          if (!email) {
            toast('Enter your email address', 'error')
            return
          }
          try {
            const result = await ctx.api.shareRequestCode(ctx.shareToken, email)
            ctx.shareEmail = email
            ctx.shareDevCode = result.devCode || null
            view.stage = 'code'
            ctx.refresh()
          } catch (err) {
            toast(err.message, 'error')
          }
        })

        root.querySelector('#share-verify')?.addEventListener('click', async () => {
          const code = (root.querySelector('#share-code')?.value || '').trim()
          if (!/^\d{4,8}$/.test(code)) {
            toast('Enter the numeric code', 'error')
            return
          }
          try {
            await ctx.api.shareVerify(ctx.shareToken, ctx.shareEmail, code)
            ctx.shareDevCode = null
            toast('Verified', 'success')
            await ctx.loadShare()
          } catch (err) {
            toast(err.message, 'error')
          }
        })

        root.querySelector('#share-change-email')?.addEventListener('click', () => {
          view.stage = 'email'
          ctx.refresh()
        })
      }
    }
  }

  // Denied / expired / revoked (§39)
  if (!view.accessible) {
    const reasonCopy = {
      EXPIRED: ['This share has expired', 'The link is no longer valid. Ask the sender for a new share.'],
      REVOKED: ['This share was revoked', 'The sender has withdrawn access to this item.'],
      EMAIL_MISMATCH: ['Not shared with you', 'This item was not shared with that email address.'],
      NOT_STARTED: ['This share is not active yet', 'The sender has scheduled this share to start later.'],
      NOT_FOUND: ['Link not valid', 'This share link does not exist or has been removed.'],
      GONE: ['Item unavailable', 'The shared item is no longer available.']
    }
    const [title, message] = reasonCopy[view.reason] || reasonCopy.NOT_FOUND

    return {
      html: shell(`
        <div class="card" style="padding:4px 0 12px">
          ${emptyState({ iconName: 'alert', title, message })}
        </div>`)
    }
  }

  // Accessible view
  const item = view.view?.item
  const items = view.view?.items || []

  return {
    html: shell(`
      <div style="font-size:12px;color:var(--text-2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">
        Shared with you
      </div>

      ${
        item
          ? `
        <div class="card" style="padding:16px">
          <div style="display:flex;gap:12px;align-items:flex-start">
            ${fileBadge(item.extension)}
            <div style="flex:1;min-width:0">
              <h1 style="font-size:19px;font-weight:640;margin:0;line-height:1.3">${esc(item.title)}</h1>
              <div style="font-size:12.5px;color:var(--text-2);margin-top:5px">
                ${esc(kindLabel(item.extension))} · ${esc(formatBytes(item.sizeBytes))}
              </div>
              <div style="font-size:12px;color:var(--text-3);margin-top:2px">
                Updated ${esc(timeAgo(item.updatedAt))}
              </div>
            </div>
          </div>

          ${
            item.description
              ? `<p style="font-size:13.5px;color:var(--text-2);margin:14px 0 0;line-height:1.55">${esc(item.description)}</p>`
              : ''
          }

          ${
            item.mimeType === 'text/html'
              ? `<div style="margin-top:16px">
                   <iframe class="preview-frame" title="Artifact preview"
                     sandbox="${esc(sharePreviewSandbox(view.view))}"
                     referrerpolicy="no-referrer"
                     loading="lazy"
                     src="${safeUrl(ctx.sharePreviewUrl(item.id, view.view))}"></iframe>
                   ${sharePreviewNote(view.view)}
                 </div>`
              : `<div style="margin-top:16px;padding:14px;border-radius:12px;background:var(--surface-2);
                   font-size:13px;color:var(--text-2);line-height:1.55">
                   ${icon('file', 16)} This ${esc(extLabel(item.extension))} file cannot be previewed in the browser.
                   ${view.view.allowDownload ? 'Use Download to open it.' : 'The sender has disabled downloading.'}
                 </div>`
          }

          <div style="display:flex;gap:9px;margin-top:16px">
            <a class="btn btn-secondary" style="flex:1;text-decoration:none;color:var(--text)"
               href="${safeUrl(ctx.shareOpenUrl(item.id, item.mimeType === 'text/html'))}"
               target="_blank" rel="noopener noreferrer">${item.mimeType === 'text/html' ? 'Open page' : 'Open'}</a>
            ${
              view.view.allowDownload
                ? `<a class="btn btn-primary" style="flex:1;text-decoration:none;color:#fff"
                     href="${safeUrl(ctx.shareContentUrl(item.id, true))}" download>${icon('download', 17)} Download</a>`
                : `<button class="btn btn-secondary" style="flex:1" disabled>Download off</button>`
            }
          </div>
        </div>

        <div class="card" style="padding:14px;margin-top:12px">
          <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--text-2)">
            <span>Shared by</span>
            <span style="color:var(--text);font-weight:560">${esc(view.sharedBy || 'A library user')}</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--text-2);margin-top:8px">
            <span>Expires</span>
            <span style="color:var(--text);font-weight:560">
              ${item.expiresAt || view.view.expiresAt ? esc(formatDateTime(view.view.expiresAt)) : 'No expiry'}
            </span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--text-2);margin-top:8px">
            <span>Permission</span>
            <span style="color:var(--text);font-weight:560">
              ${view.view.allowDownload ? 'View + Download' : 'View only'}
            </span>
          </div>
        </div>`
          : `
        <div class="card" style="padding:16px">
          <h1 style="font-size:19px;font-weight:640;margin:0">${esc(view.view?.name || 'Shared collection')}</h1>
          <div style="font-size:12.5px;color:var(--text-2);margin-top:5px">${items.length} item(s)</div>
          <div style="display:flex;flex-direction:column;gap:9px;margin-top:16px">
            ${items
              .map(
                (it) => `
              <a class="list-row" style="text-decoration:none;color:var(--text)"
                 href="${safeUrl(ctx.shareOpenUrl(it.id, it.extension === 'html' || it.mimeType === 'text/html'))}"
                 target="_blank" rel="noopener noreferrer">
                ${fileBadge(it.extension)}
                <span style="flex:1;min-width:0">
                  <span style="display:block;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.title)}</span>
                  <span style="display:block;font-size:11.5px;color:var(--text-2)">
                    ${esc(extLabel(it.extension))} · ${esc(formatBytes(it.sizeBytes))}
                  </span>
                </span>
              </a>`
              )
              .join('')}
          </div>
        </div>

        <div class="card" style="padding:14px;margin-top:12px">
          <div style="font-size:12.5px;color:var(--text-2);line-height:1.55">
            ${icon('alert', 14)} New items added to this collection are included automatically.
          </div>
        </div>`
      }

      <p style="font-size:11px;color:var(--text-3);text-align:center;margin-top:20px;line-height:1.6">
        You are viewing a shared item.<br>This page shows only what was shared with you.
      </p>
    `)
  }
}

/** Shared with renderAdd / library when a listing needs a plain row. */
export function artifactRow(artifact) {
  return `
    <button class="list-row" data-artifact="${esc(artifact.id)}">
      ${fileBadge(artifact.extension)}
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(artifact.title)}</div>
        <div style="font-size:11.5px;color:var(--text-2)">${esc(extLabel(artifact.extension))} · ${esc(timeAgo(artifact.updatedAt))}</div>
      </div>
    </button>`
}

export { closeSheet, sheet }
