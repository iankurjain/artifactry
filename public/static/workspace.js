/**
 * Workspace management (left-rail "Workspace") and the invitation join page.
 *
 * One screen per workspace, in sections:
 *   Identity · Custom URL · Regional · Team directory · Roles & permissions ·
 *   Invitation controls
 *
 * Everything shown comes from the server, which decides who may change what.
 * People who cannot manage the workspace see identity and regional settings
 * read-only, and nothing else.
 */

import {
  esc,
  icon,
  toast,
  sheet,
  closeSheet,
  screenHeader,
  emptyState,
  spinner,
  formatDate,
  formatDatePattern,
  avatar
} from './ui.js'

const PICTURE_MAX_BYTES = 1024 * 1024

const SECTIONS = [
  ['identity', 'Identity'],
  ['custom-url', 'Custom URL'],
  ['regional', 'Regional'],
  ['directory', 'Team'],
  ['roles', 'Roles'],
  ['invitations', 'Invitations']
]

const sectionTitle = (id, title, sub) => `
  <h2 id="wm-${id}" style="font-size:15px;font-weight:660;margin:26px 0 4px;scroll-margin-top:72px">${esc(title)}</h2>
  ${sub ? `<p style="font-size:12.5px;color:var(--text-2);margin:0 0 10px;line-height:1.5">${esc(sub)}</p>` : '<div style="height:6px"></div>'}`

const label = (forId, text) =>
  `<label for="${forId}" style="font-size:13px;font-weight:600;display:block;margin:12px 0 6px">${esc(text)}</label>`

const muted = (text) => `<p style="font-size:13px;color:var(--text-2);margin:0;line-height:1.55">${text}</p>`

/** Disable a button while its async action runs; errors become a toast. */
function busy(button, fn) {
  return async (event) => {
    if (!button || button.disabled) return
    button.disabled = true
    try {
      await fn(event)
    } catch (error) {
      if (error?.status !== 401) toast(error?.message || 'Something went wrong', 'error')
    } finally {
      button.disabled = false
    }
  }
}

/** Ask for a picture; refuse only files over 1 MB, before uploading. */
function pickPicture(onFile) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/png,image/jpeg,image/webp,image/gif'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (!file) return
    if (file.size > PICTURE_MAX_BYTES) {
      toast('The picture must be 1 MB or smaller', 'error')
      return
    }
    onFile(file)
  })
  input.click()
}

export { pickPicture }

// ---------------------------------------------------------------
// Screen
// ---------------------------------------------------------------

export function renderWorkspaceManage(ctx) {
  const wm = ctx.wm || {}
  const allWorkspaces = ctx.state.workspaces || []

  const header = screenHeader({ title: 'Workspace', subtitle: wm.manage?.workspace?.name, onBackId: 'wm-back' })
  const shell = (body) => ({
    html: `${header}<main class="app-main" style="padding-top:8px">${body}${ctx.appFooter()}</main>${ctx.bottomNav('workspace')}`,
    mount(root) {
      root.querySelector('#wm-back')?.addEventListener('click', () => ctx.goBack())
      root.querySelector('#wm-create-org')?.addEventListener('click', () => ctx.openCreateOrgSheet())
    }
  })

  if (wm.loading && !wm.manage) {
    return shell(`<div style="display:flex;justify-content:center;padding:48px 0">${spinner(true)}</div>`)
  }

  if (!wm.manage) {
    return shell(`
      <div class="card" style="padding:4px 0 12px">
        ${emptyState({
          iconName: 'building',
          title: allWorkspaces.length ? 'Workspace not available' : 'No workspace yet',
          message: allWorkspaces.length ? 'You no longer have access to that workspace.' : 'Create a workspace to manage it here.',
          action: ''
        })}
      </div>`)
  }

  const { workspace, settings, tiers, options } = wm.manage
  const personal = workspace.type === 'PERSONAL'
  const canSettings = workspace.canManageSettings
  const canMembers = workspace.canManageMembers && !personal

  const picker =
    allWorkspaces.length > 1
      ? `<div style="margin:2px 0 4px">
           <label for="wm-switch" class="visually-hidden">Workspace</label>
           <select id="wm-switch" class="input">
             ${allWorkspaces
               .map((w) => `<option value="${esc(w.id)}" ${w.id === workspace.id ? 'selected' : ''}>${esc(w.name)}${w.type === 'PERSONAL' ? ' (personal)' : ''}</option>`)
               .join('')}
           </select>
         </div>`
      : ''

  const jump = `
    <nav aria-label="Sections" style="display:flex;gap:7px;overflow-x:auto;padding:6px 0 2px;margin:0 -2px;scrollbar-width:none">
      ${SECTIONS.filter(([id]) => canMembers || ['identity', 'custom-url', 'regional'].includes(id))
        .map(([id, text]) => `<a class="chip" href="#wm-${id}" data-jump="${id}" style="white-space:nowrap;text-decoration:none">${esc(text)}</a>`)
        .join('')}
    </nav>`

  const body = `
    ${picker}
    ${jump}
    ${personal ? `<div class="card" style="padding:14px;margin-top:12px">${muted('This is a personal workspace, so only you use it. Custom URL, team, roles and invitations are available in organization workspaces.')}</div>` : ''}
    ${identitySection(workspace, canSettings)}
    ${customUrlSection(wm.shareDomain, personal, canSettings)}
    ${regionalSection(settings, options, canSettings)}
    ${canMembers ? directorySection(wm.directory, tiers, workspace) : ''}
    ${canMembers ? rolesSection(tiers, options) : ''}
    ${canMembers ? invitationsSection(settings, tiers, wm.lastInvite) : ''}
    ${!canSettings ? `<p style="font-size:12px;color:var(--text-3);margin:18px 0 0">${icon('lock', 12)} Only workspace admins may change these settings.</p>` : ''}`

  return {
    html: `${header}<main class="app-main" style="padding-top:8px">${body}${ctx.appFooter()}</main>${ctx.bottomNav('workspace')}`,
    mount(root) {
      root.querySelector('#wm-back')?.addEventListener('click', () => ctx.goBack())
      root.querySelector('#wm-switch')?.addEventListener('change', (e) => ctx.navigate(`/workspace/${encodeURIComponent(e.target.value)}`))
      root.querySelectorAll('[data-jump]').forEach((a) =>
        a.addEventListener('click', (e) => {
          e.preventDefault()
          root.querySelector(`#wm-${a.dataset.jump}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        })
      )
      mountIdentity(root, ctx, workspace)
      if (!personal) mountShareDomainCard(root, ctx, workspace)
      mountRegional(root, ctx, workspace)
      if (canMembers) {
        mountDirectory(root, ctx, workspace, tiers)
        mountRoles(root, ctx, workspace, tiers, options)
        mountInvitations(root, ctx, workspace, tiers)
      }
    }
  }
}

// ---------------------------------------------------------------
// Identity
// ---------------------------------------------------------------

function identitySection(workspace, canEdit) {
  return `
    ${sectionTitle('identity', 'Workspace identity', 'The name and logo people see in the app and on invitation pages.')}
    <div class="card" style="padding:14px">
      <div style="display:flex;align-items:center;gap:14px">
        ${avatar({ url: workspace.logoUrl, name: workspace.name, size: 64 })}
        <div style="flex:1;min-width:0">
          <div style="font-size:15px;font-weight:620;overflow:hidden;text-overflow:ellipsis">${esc(workspace.name)}</div>
          ${
            canEdit
              ? `<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
                   <button class="btn btn-secondary" id="wm-logo-upload" style="min-height:34px;padding:0 12px">${icon('upload', 15)} ${workspace.logoUrl ? 'Change logo' : 'Upload logo'}</button>
                   ${workspace.logoUrl ? '<button class="btn btn-ghost" id="wm-logo-remove" style="min-height:34px;padding:0 10px">Remove</button>' : ''}
                 </div>
                 <p style="font-size:11.5px;color:var(--text-3);margin:6px 0 0">PNG, JPEG, WebP or GIF, up to 1 MB. Shown in a circle.</p>`
              : ''
          }
        </div>
      </div>
      ${
        canEdit
          ? `${label('wm-name', 'Name')}
             <input id="wm-name" class="input" type="text" maxlength="120" value="${esc(workspace.name)}">
             ${label('wm-description', 'Description')}
             <textarea id="wm-description" class="input" rows="2" maxlength="500" style="height:auto;padding-top:10px">${esc(workspace.description || '')}</textarea>
             <button class="btn btn-primary btn-block" id="wm-identity-save" style="margin-top:12px">Save</button>`
          : workspace.description
            ? `<p style="font-size:13px;color:var(--text-2);margin:12px 0 0">${esc(workspace.description)}</p>`
            : ''
      }
    </div>`
}

function mountIdentity(root, ctx, workspace) {
  const save = root.querySelector('#wm-identity-save')
  save?.addEventListener(
    'click',
    busy(save, async () => {
      const name = root.querySelector('#wm-name').value.trim()
      if (!name) return toast('Enter a name', 'error')
      await ctx.api.updateWorkspaceSettings(workspace.id, { name, description: root.querySelector('#wm-description').value })
      toast('Saved', 'success')
      await ctx.reloadShell()
    })
  )
  const upload = root.querySelector('#wm-logo-upload')
  upload?.addEventListener('click', () =>
    pickPicture(
      busy(upload, async (file) => {
        await ctx.api.uploadWorkspaceLogo(workspace.id, file)
        toast('Logo updated', 'success')
        await ctx.reloadShell()
      })
    )
  )
  const remove = root.querySelector('#wm-logo-remove')
  remove?.addEventListener(
    'click',
    busy(remove, async () => {
      await ctx.api.removeWorkspaceLogo(workspace.id)
      toast('Logo removed', 'success')
      await ctx.reloadShell()
    })
  )
}

// ---------------------------------------------------------------
// Custom URL (share link domain)
// ---------------------------------------------------------------

const SHARE_DOMAIN_STATUS = {
  PENDING_DNS: ['Waiting for DNS', 'Add both records below, then choose Check now.'],
  PENDING_CERT: ['Setting up', 'Ownership confirmed. Waiting for the CNAME record and the certificate.'],
  ACTIVE: ['Active', 'New share links from this workspace use this domain.'],
  ERROR: ['Needs attention', 'Cloudflare could not set up this hostname.']
}

function customUrlSection(info, personal, canEdit) {
  const heading = sectionTitle(
    'custom-url',
    'Custom URL',
    'Share links for every artifact in this workspace use this domain. Artifacts that should keep standard links belong in a different workspace.'
  )
  const card = (inner) => `${heading}<div class="card" style="padding:14px">${inner}</div>`
  const host = esc(window.location.host)

  if (personal) return card(muted(`Share links use ${host}. Custom URLs are available for organization workspaces.`))
  if (!info) return card(muted(`Share links use ${host}.`))
  if (!info.available) {
    return card(muted(`Share links use ${host}. Custom URLs are not set up on this deployment yet.`))
  }

  const domain = info.domain
  if (!domain) {
    if (!canEdit) return card(muted(`Share links use ${host}.`))
    return card(`
      ${muted(`Share links use ${host}. Use a hostname on your own domain instead, like share.yourcompany.com.`)}
      ${label('share-domain-input', 'Hostname')}
      <input id="share-domain-input" class="input" type="text" inputmode="url" autocomplete="off"
        autocapitalize="off" spellcheck="false" placeholder="share.yourcompany.com">
      <button class="btn btn-primary btn-block" id="share-domain-save" style="margin-top:12px">Use this domain</button>`)
  }

  const [statusLabel, detail] = SHARE_DOMAIN_STATUS[domain.status] || SHARE_DOMAIN_STATUS.PENDING_DNS
  const records = (domain.records || [])
    .map(
      (r) => `
        <div style="padding:10px 0;border-top:1px solid var(--border)">
          <div style="font-size:12px;color:var(--text-2)">${esc(r.type)} · ${esc(r.purpose || '')}</div>
          <div style="font-size:12.5px;margin-top:4px;word-break:break-all">
            <span style="color:var(--text-2)">Name</span> <code style="font-family:var(--font-mono)">${esc(r.name)}</code>
          </div>
          <div style="font-size:12.5px;margin-top:2px;word-break:break-all">
            <span style="color:var(--text-2)">Value</span> <code style="font-family:var(--font-mono)">${esc(r.value)}</code>
          </div>
        </div>`
    )
    .join('')

  return card(`
    <div style="display:flex;align-items:center;gap:10px">
      ${icon('globe', 19)}
      <span style="flex:1;min-width:0;font-size:14.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis">${esc(domain.hostname)}</span>
      <span class="chip">${esc(statusLabel)}</span>
    </div>
    <p style="font-size:13px;color:var(--text-2);margin:8px 0 0;line-height:1.55">${esc(detail)}</p>
    ${
      domain.lastError && domain.status !== 'ACTIVE'
        ? `<p style="font-size:12.5px;color:var(--danger);margin:8px 0 0;line-height:1.5">${esc(domain.lastError)}</p>`
        : ''
    }
    ${domain.status === 'ACTIVE' || !canEdit ? '' : `<div style="margin-top:12px">${records}</div>`}
    ${
      canEdit
        ? `<div style="display:flex;gap:9px;margin-top:12px">
             <button class="btn btn-secondary" id="share-domain-check" style="flex:1">${icon('refresh', 16)} Check now</button>
             <button class="btn btn-danger" id="share-domain-remove" style="flex:1">Remove</button>
           </div>`
        : ''
    }`)
}

function mountShareDomainCard(root, ctx, workspace) {
  const save = root.querySelector('#share-domain-save')
  save?.addEventListener(
    'click',
    busy(save, async () => {
      const hostname = (root.querySelector('#share-domain-input')?.value || '').trim()
      if (!hostname) return toast('Enter a hostname', 'error')
      await ctx.api.setShareDomain(workspace.id, hostname)
      toast('Domain added. Add the DNS records next.', 'success')
      await ctx.reload()
    })
  )
  const check = root.querySelector('#share-domain-check')
  check?.addEventListener(
    'click',
    busy(check, async () => {
      const result = await ctx.api.checkShareDomain(workspace.id)
      toast(result?.domain?.status === 'ACTIVE' ? 'Share links now use this domain' : 'Checked', 'success')
      await ctx.reload()
    })
  )
  const remove = root.querySelector('#share-domain-remove')
  remove?.addEventListener(
    'click',
    busy(remove, async () => {
      if (!window.confirm('Stop using this domain? Links already sent with it will stop opening.')) return
      await ctx.api.removeShareDomain(workspace.id)
      toast('Share links use the standard address again', 'success')
      await ctx.reload()
    })
  )
}

// ---------------------------------------------------------------
// Regional
// ---------------------------------------------------------------

function timeZones(current) {
  let zones = []
  try {
    zones = Intl.supportedValuesOf('timeZone')
  } catch {
    zones = []
  }
  if (!zones.includes('UTC')) zones = ['UTC', ...zones]
  if (current && !zones.includes(current)) zones = [current, ...zones]
  return zones
}

function regionalSection(settings, options, canEdit) {
  const { timeZone, dateFormat } = settings.regional
  const today = new Date()
  return `
    ${sectionTitle('regional', 'Regional', 'How dates and times appear for everyone in this workspace.')}
    <div class="card" style="padding:14px">
      ${
        canEdit
          ? `${label('wm-tz', 'Time zone')}
             <select id="wm-tz" class="input">
               ${timeZones(timeZone).map((z) => `<option value="${esc(z)}" ${z === timeZone ? 'selected' : ''}>${esc(z.replace(/_/g, ' '))}</option>`).join('')}
             </select>
             ${label('wm-datefmt', 'Date format')}
             <select id="wm-datefmt" class="input">
               ${(options.dateFormats || [])
                 .map((f) => `<option value="${esc(f)}" ${f === dateFormat ? 'selected' : ''}>${esc(formatDatePattern(today, f))} (${esc(f)})</option>`)
                 .join('')}
             </select>
             <button class="btn btn-primary btn-block" id="wm-regional-save" style="margin-top:12px">Save</button>`
          : `<div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0">
               <span style="color:var(--text-2)">Time zone</span><span style="font-weight:560">${esc(timeZone)}</span>
             </div>
             <div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0">
               <span style="color:var(--text-2)">Date format</span><span style="font-weight:560">${esc(formatDatePattern(today, dateFormat))}</span>
             </div>`
      }
    </div>`
}

function mountRegional(root, ctx, workspace) {
  const save = root.querySelector('#wm-regional-save')
  save?.addEventListener(
    'click',
    busy(save, async () => {
      await ctx.api.updateWorkspaceSettings(workspace.id, {
        regional: { timeZone: root.querySelector('#wm-tz').value, dateFormat: root.querySelector('#wm-datefmt').value }
      })
      toast('Regional settings saved', 'success')
      await ctx.reloadShell()
    })
  )
}

// ---------------------------------------------------------------
// Team directory
// ---------------------------------------------------------------

function tierOptions(tiers, selected, { allowAdmin = true } = {}) {
  const builtIn = (tiers.builtIn || [])
    .filter((t) => t.role !== 'OWNER' && (allowAdmin || t.role !== 'WORKSPACE_ADMIN'))
    .map((t) => `<option value="${esc(t.role)}" ${selected === t.role ? 'selected' : ''}>${esc(t.name)}</option>`)
  const custom = (tiers.custom || []).map(
    (t) => `<option value="${esc(t.id)}" ${selected === t.id ? 'selected' : ''}>${esc(t.name)}</option>`
  )
  return builtIn.join('') + (custom.length ? `<optgroup label="Custom tiers">${custom.join('')}</optgroup>` : '')
}

function personRow(p, right) {
  return `
    <div class="list-row" style="cursor:default">
      ${avatar({ url: p.avatarUrl, name: p.displayName || p.email, size: 38 })}
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.displayName || p.email)}</div>
        <div style="font-size:12px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.email)}</div>
      </div>
      ${right}
    </div>`
}

function group(title, count, inner) {
  return `
    <div style="font-size:11.5px;font-weight:640;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin:16px 0 8px">
      ${esc(title)} <span style="color:var(--text-3)">${count}</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">${inner}</div>`
}

function directorySection(directory, tiers, workspace) {
  if (!directory) {
    return `${sectionTitle('directory', 'Team directory')}<div class="card" style="padding:14px">${spinner(true)}</div>`
  }
  const none = (text) => `<p style="font-size:12.5px;color:var(--text-3);margin:0">${esc(text)}</p>`

  const active = directory.active
    .map((p) =>
      personRow(
        p,
        p.isOwner
          ? '<span class="chip">Owner</span>'
          : `<select class="input" data-tier-for="${esc(p.userId)}" aria-label="Access tier for ${esc(p.displayName || p.email)}"
               style="width:auto;min-height:34px;height:34px;font-size:13px;padding:0 8px">${tierOptions(tiers, p.customRoleId || p.role)}</select>
             <button class="btn btn-ghost" data-deactivate="${esc(p.userId)}" style="min-height:34px;padding:0 8px" aria-label="Deactivate ${esc(p.displayName || p.email)}">${icon('x', 16)}</button>`
      )
    )
    .join('')

  const pending = directory.awaitingApproval
    .map((p) =>
      personRow(
        p,
        `<button class="btn btn-primary" data-approve="${esc(p.userId)}" style="min-height:34px;padding:0 12px">Approve</button>
         <button class="btn btn-ghost" data-decline="${esc(p.userId)}" style="min-height:34px;padding:0 10px">Decline</button>`
      )
    )
    .join('')

  const invites = directory.invitations
    .map(
      (i) => `
      <div class="list-row" style="cursor:default">
        <span style="width:38px;height:38px;border-radius:999px;background:var(--surface-2);display:flex;align-items:center;justify-content:center;flex:none">
          ${icon(i.kind === 'LINK' ? 'link' : 'mail', 18)}
        </span>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${i.kind === 'LINK' ? `Invite link <code style="font-family:var(--font-mono);font-size:12px;color:var(--text-2)">${esc(i.tokenPrefix)}…</code>` : esc(i.email)}
          </div>
          <div style="font-size:12px;color:var(--text-2)">
            ${esc(i.tier)} · ${i.kind === 'LINK' ? `${i.useCount}${i.maxUses ? ` of ${i.maxUses}` : ''} joined · ` : ''}expires ${esc(formatDate(i.expiresAt))}
          </div>
        </div>
        <button class="btn btn-ghost" data-revoke="${esc(i.id)}" style="min-height:34px;padding:0 10px">Revoke</button>
      </div>`
    )
    .join('')

  const deactivated = directory.deactivated
    .map((p) => personRow(p, `<button class="btn btn-secondary" data-reactivate="${esc(p.userId)}" style="min-height:34px;padding:0 12px">Reactivate</button>`))
    .join('')

  return `
    ${sectionTitle('directory', 'Team directory', `Everyone with access to ${workspace.name}, people waiting to join, and people whose access was turned off.`)}
    ${group('Active', directory.active.length, active || none('No members yet.'))}
    ${group('Awaiting approval', directory.awaitingApproval.length, pending || none('Nobody is waiting.'))}
    ${group('Pending invitations', directory.invitations.length, invites || none('No open invitations.'))}
    ${group('Deactivated', directory.deactivated.length, deactivated || none('Nobody has been deactivated.'))}`
}

function mountDirectory(root, ctx, workspace) {
  root.querySelectorAll('[data-tier-for]').forEach((select) =>
    select.addEventListener('change', async () => {
      select.disabled = true
      try {
        await ctx.api.updateWorkspaceMember(workspace.id, select.dataset.tierFor, select.value)
        toast('Access updated', 'success')
        await ctx.reload()
      } catch (error) {
        toast(error?.message || 'Could not change access', 'error')
        select.disabled = false
      }
    })
  )
  const status = (attr, value, message, confirmText) =>
    root.querySelectorAll(`[data-${attr}]`).forEach((button) =>
      button.addEventListener(
        'click',
        busy(button, async () => {
          if (confirmText && !window.confirm(confirmText)) return
          await ctx.api.setMemberStatus(workspace.id, button.getAttribute(`data-${attr}`), value)
          toast(message, 'success')
          await ctx.reload()
        })
      )
    )
  status('deactivate', 'REMOVED', 'Access turned off', 'Turn off this person’s access to this workspace? Their account and other workspaces are not affected.')
  status('approve', 'ACTIVE', 'Approved')
  status('decline', 'REMOVED', 'Declined')
  status('reactivate', 'ACTIVE', 'Access restored')
  root.querySelectorAll('[data-revoke]').forEach((button) =>
    button.addEventListener(
      'click',
      busy(button, async () => {
        await ctx.api.revokeInvitation(workspace.id, button.dataset.revoke)
        toast('Invitation revoked', 'success')
        await ctx.reload()
      })
    )
  )
}

// ---------------------------------------------------------------
// Roles & permissions
// ---------------------------------------------------------------

function rolesSection(tiers, options) {
  const labels = Object.fromEntries((options.permissions || []).map((p) => [p.id, p.label]))
  const builtIn = (tiers.builtIn || [])
    .map(
      (t) => `
      <div class="row" style="padding:11px 14px;cursor:default">
        ${icon(t.role === 'OWNER' ? 'shield' : t.role === 'WORKSPACE_ADMIN' ? 'lock' : t.role === 'CONTRIBUTOR' ? 'user' : 'eye', 18)}
        <span style="flex:1;min-width:0">
          <span style="font-size:14px;font-weight:600">${esc(t.name)}</span>
          <span style="display:block;font-size:12px;color:var(--text-2)">${esc(t.description)}</span>
        </span>
      </div>`
    )
    .join('')
  const custom = (tiers.custom || [])
    .map(
      (t) => `
      <div class="row" style="padding:11px 14px;cursor:default;align-items:flex-start">
        ${icon('tag', 18)}
        <span style="flex:1;min-width:0">
          <span style="font-size:14px;font-weight:600">${esc(t.name)}</span>
          <span style="font-size:12px;color:var(--text-3)"> · ${t.memberCount} ${t.memberCount === 1 ? 'person' : 'people'}</span>
          <span style="display:flex;flex-wrap:wrap;gap:5px;margin-top:6px">
            ${t.permissions.map((p) => `<span class="chip" style="font-size:11px">${esc(labels[p] || p)}</span>`).join('')}
          </span>
        </span>
        <button class="btn btn-ghost" data-edit-tier="${esc(t.id)}" style="min-height:34px;padding:0 10px;flex:none;width:auto">Edit</button>
      </div>`
    )
    .join('')
  return `
    ${sectionTitle('roles', 'Roles & permissions', 'Built-in tiers cover most teams. Custom tiers pick exactly what someone may do.')}
    <div class="card" style="overflow:hidden">${builtIn}</div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin:14px 0 8px">
      <div style="font-size:11.5px;font-weight:640;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em">Custom tiers</div>
      <button class="btn btn-secondary" id="wm-new-tier" style="min-height:34px;padding:0 12px">${icon('plus', 15)} New tier</button>
    </div>
    <div class="card" style="overflow:hidden">
      ${custom || '<p style="padding:14px;font-size:12.5px;color:var(--text-3);margin:0">No custom tiers yet.</p>'}
    </div>`
}

function tierSheet(ctx, workspace, options, tier) {
  const has = new Set(tier?.permissions || ['artifact.read', 'artifact.download'])
  sheet({
    title: tier ? `Edit ${tier.name}` : 'New access tier',
    content: `
      <div>
        <label for="tier-name" style="font-size:13px;font-weight:600;display:block;margin-bottom:6px">Name</label>
        <input id="tier-name" class="input" maxlength="40" placeholder="e.g. Reviewer" value="${esc(tier?.name || '')}">
        <div style="font-size:13px;font-weight:600;margin:16px 0 6px">What this tier allows</div>
        ${(options.permissions || [])
          .map(
            (p) => `
          <label class="row" style="padding:9px 0;gap:10px">
            <input type="checkbox" data-perm="${esc(p.id)}" ${has.has(p.id) ? 'checked' : ''} ${p.id === 'artifact.read' ? 'checked disabled' : ''}>
            <span style="flex:1;font-size:14px">${esc(p.label)}</span>
          </label>`
          )
          .join('')}
        <p style="font-size:11.5px;color:var(--text-2);margin:8px 0 0;line-height:1.5">
          Managing settings and people stays with Admins. Everyone on a tier may view the workspace.
        </p>
      </div>`,
    actions: [
      {
        label: tier ? 'Save' : 'Create tier',
        variant: 'primary',
        keepOpen: true,
        onClick: async () => {
          const panel = document.querySelector('.sheet')
          const name = panel.querySelector('#tier-name').value.trim()
          const permissions = [...panel.querySelectorAll('[data-perm]:checked')].map((c) => c.dataset.perm)
          if (!name) return toast('Give the tier a name', 'error')
          try {
            if (tier) await ctx.api.updateTier(workspace.id, tier.id, { name, permissions })
            else await ctx.api.createTier(workspace.id, name, permissions)
            closeSheet()
            toast(tier ? 'Tier saved' : 'Tier created', 'success')
            await ctx.reload()
          } catch (error) {
            toast(error?.message || 'Could not save the tier', 'error')
          }
        }
      },
      ...(tier
        ? [
            {
              label: 'Delete tier',
              variant: 'danger',
              keepOpen: true,
              onClick: async () => {
                if (!window.confirm(`Delete ${tier.name}? People on it move to Member or Guest, matching what it allowed.`)) return
                try {
                  await ctx.api.deleteTier(workspace.id, tier.id)
                  closeSheet()
                  toast('Tier deleted', 'success')
                  await ctx.reload()
                } catch (error) {
                  toast(error?.message || 'Could not delete the tier', 'error')
                }
              }
            }
          ]
        : [])
    ]
  })
}

function mountRoles(root, ctx, workspace, tiers, options) {
  root.querySelector('#wm-new-tier')?.addEventListener('click', () => tierSheet(ctx, workspace, options, null))
  root.querySelectorAll('[data-edit-tier]').forEach((button) =>
    button.addEventListener('click', () =>
      tierSheet(ctx, workspace, options, (tiers.custom || []).find((t) => t.id === button.dataset.editTier))
    )
  )
}

// ---------------------------------------------------------------
// Invitation controls
// ---------------------------------------------------------------

function invitationsSection(settings, tiers, lastInvite) {
  const inv = settings.invitations
  const defaultTier = inv.defaultCustomRoleId || inv.defaultRole
  return `
    ${sectionTitle('invitations', 'Invitation controls', 'Invite people by email or with a link, and decide who may join and how.')}
    <div class="card" style="padding:14px">
      <div style="font-size:14px;font-weight:620">${icon('mail', 16)} Invite by email</div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <input id="wm-invite-email" class="input" type="email" inputmode="email" placeholder="teammate@company.com" style="flex:2 1 200px">
        <select id="wm-invite-tier" class="input" style="flex:1 1 120px" aria-label="Access tier">${tierOptions(tiers, defaultTier)}</select>
      </div>
      <button class="btn btn-primary btn-block" id="wm-invite-send" style="margin-top:10px">Send invitation</button>

      <div style="height:1px;background:var(--border);margin:16px 0"></div>

      <div style="font-size:14px;font-weight:620">${icon('link', 16)} Invite link</div>
      <p style="font-size:12px;color:var(--text-2);margin:4px 0 0">Anyone with the link may join, subject to the rules below. Links never grant Admin.</p>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <select id="wm-link-tier" class="input" style="flex:1 1 120px" aria-label="Access tier">${tierOptions(tiers, defaultTier === 'WORKSPACE_ADMIN' ? 'VIEWER' : defaultTier, { allowAdmin: false })}</select>
        <select id="wm-link-uses" class="input" style="flex:1 1 110px" aria-label="Uses">
          <option value="">Unlimited uses</option><option value="1">1 use</option><option value="5">5 uses</option>
          <option value="10">10 uses</option><option value="25">25 uses</option><option value="100">100 uses</option>
        </select>
        <select id="wm-link-days" class="input" style="flex:1 1 110px" aria-label="Expires">
          <option value="1">1 day</option><option value="7" selected>7 days</option><option value="30">30 days</option><option value="90">90 days</option>
        </select>
      </div>
      <button class="btn btn-secondary btn-block" id="wm-link-create" style="margin-top:10px">Create link</button>
      ${
        lastInvite
          ? `<div style="margin-top:12px;padding:10px;border-radius:10px;background:var(--surface-2)">
               <div style="font-size:12px;color:var(--text-2);margin-bottom:6px">${esc(lastInvite.note)}</div>
               <div style="display:flex;gap:8px;align-items:center">
                 <code id="wm-last-link" style="flex:1;min-width:0;font-family:var(--font-mono);font-size:12px;word-break:break-all">${esc(lastInvite.url)}</code>
                 <button class="btn btn-secondary" id="wm-copy-link" style="min-height:32px;padding:0 10px">Copy</button>
               </div>
             </div>`
          : ''
      }
    </div>

    <div class="card" style="padding:14px;margin-top:12px">
      <div style="font-size:14px;font-weight:620">${icon('shield', 16)} Who may join</div>
      ${label('wm-domains', 'Allowed email domains')}
      <input id="wm-domains" class="input" type="text" autocapitalize="off" spellcheck="false"
        placeholder="Any domain" value="${esc(inv.allowedDomains.join(', '))}">
      <p style="font-size:11.5px;color:var(--text-2);margin:6px 0 0">Comma separated, like acme.com, acme.co.uk. Empty allows any address.</p>
      <label class="row" style="padding:12px 0 2px;gap:10px">
        <input type="checkbox" id="wm-approval" ${inv.requireApproval ? 'checked' : ''}>
        <span style="flex:1;font-size:14px">Require admin approval for new joiners</span>
      </label>
      ${label('wm-default-tier', 'Default tier for new joiners')}
      <select id="wm-default-tier" class="input">${tierOptions(tiers, defaultTier)}</select>
      <button class="btn btn-primary btn-block" id="wm-invite-rules-save" style="margin-top:12px">Save</button>
    </div>`
}

function mountInvitations(root, ctx, workspace) {
  const tierPayload = (value) => (value.startsWith('wcr_') ? { customRoleId: value } : { role: value })
  const remember = (result, note) => {
    ctx.wm.lastInvite = { url: result.url, note }
  }

  const send = root.querySelector('#wm-invite-send')
  send?.addEventListener(
    'click',
    busy(send, async () => {
      const email = root.querySelector('#wm-invite-email').value.trim()
      if (!email) return toast('Enter an email address', 'error')
      const result = await ctx.api.createInvitation(workspace.id, {
        kind: 'EMAIL',
        email,
        ...tierPayload(root.querySelector('#wm-invite-tier').value)
      })
      if (result.delivered === 'EMAIL') {
        toast(`Invitation sent to ${email}`, 'success')
        ctx.wm.lastInvite = null
      } else {
        remember(result, result.delivered === 'FAILED'
          ? `The email to ${email} could not be sent. Copy this link and send it yourself. It is shown only once.`
          : `Email is not set up here. Send ${email} this link yourself. It is shown only once.`)
        toast('Invitation created', 'success')
      }
      await ctx.reload()
    })
  )

  const create = root.querySelector('#wm-link-create')
  create?.addEventListener(
    'click',
    busy(create, async () => {
      const uses = root.querySelector('#wm-link-uses').value
      const result = await ctx.api.createInvitation(workspace.id, {
        kind: 'LINK',
        ...tierPayload(root.querySelector('#wm-link-tier').value),
        maxUses: uses ? Number(uses) : null,
        expiresInDays: Number(root.querySelector('#wm-link-days').value)
      })
      remember(result, 'Copy this link now. For safety it is shown only once; you can revoke it from the team directory.')
      toast('Invite link created', 'success')
      await ctx.reload()
    })
  )

  root.querySelector('#wm-copy-link')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(root.querySelector('#wm-last-link').textContent)
      toast('Link copied', 'success')
    } catch {
      toast('Select the link and copy it', 'error')
    }
  })

  const save = root.querySelector('#wm-invite-rules-save')
  save?.addEventListener(
    'click',
    busy(save, async () => {
      const tier = root.querySelector('#wm-default-tier').value
      await ctx.api.updateWorkspaceSettings(workspace.id, {
        invitations: {
          allowedDomains: root.querySelector('#wm-domains').value.split(/[,\s]+/).map((d) => d.trim()).filter(Boolean),
          requireApproval: root.querySelector('#wm-approval').checked,
          defaultRole: tier.startsWith('wcr_') ? 'VIEWER' : tier,
          defaultCustomRoleId: tier.startsWith('wcr_') ? tier : null
        }
      })
      toast('Invitation rules saved', 'success')
      await ctx.reload()
    })
  )
}

// ---------------------------------------------------------------
// Join page (/join/:token)
// ---------------------------------------------------------------

export function renderJoin(ctx) {
  const join = ctx.join || {}
  const info = join.info
  const card = (inner) => ({
    html: `<main class="app-main" style="padding-top:48px;max-width:460px;margin:0 auto">
             <div class="card" style="padding:22px;text-align:center">${inner}</div>
           </main>`,
    mount(root) {
      root.querySelector('#join-home')?.addEventListener('click', () => ctx.navigate('/'))
      root.querySelector('#join-open')?.addEventListener('click', () => ctx.navigate(`/workspace/${encodeURIComponent(join.workspaceId)}`))
      const accept = root.querySelector('#join-accept')
      accept?.addEventListener(
        'click',
        busy(accept, async () => {
          const result = await ctx.api.acceptInvitation(join.token)
          join.result = result
          join.workspaceId = result.workspaceId
          if (result.status === 'ACTIVE') {
            await ctx.reloadShell()
            ctx.selectWorkspace(result.workspaceId)
          }
          ctx.refresh()
        })
      )
    }
  })

  if (join.loading) return card(`<div style="padding:24px 0">${spinner(true)}</div>`)

  if (!info?.valid) {
    const copy = {
      EXPIRED: 'This invitation has expired. Ask whoever invited you for a new one.',
      REVOKED: 'This invitation was withdrawn.',
      USED: 'This invitation has already been used.'
    }[info?.reason] || 'This invitation link is not valid.'
    return card(`
      ${icon('alert', 28)}
      <h1 style="font-size:18px;margin:10px 0 6px">Invitation unavailable</h1>
      ${muted(esc(copy))}
      <button class="btn btn-secondary btn-block" id="join-home" style="margin-top:16px">Go to your library</button>`)
  }

  const head = `
    <div style="display:flex;justify-content:center">${avatar({ url: info.workspace.logoUrl, name: info.workspace.name, size: 64 })}</div>
    <h1 style="font-size:19px;margin:12px 0 4px">Join ${esc(info.workspace.name)}</h1>
    ${info.invitedBy ? muted(`${esc(info.invitedBy)} invited you.`) : ''}`

  if (join.result) {
    const pending = join.result.status === 'PENDING_APPROVAL'
    return card(`
      ${head}
      <p style="font-size:14px;margin:14px 0 0;line-height:1.55">${
        pending
          ? 'Thanks. An admin needs to approve your request. You will see the workspace once they do.'
          : join.result.alreadyMember
            ? 'You are already a member of this workspace.'
            : 'You have joined.'
      }</p>
      ${
        pending
          ? '<button class="btn btn-secondary btn-block" id="join-home" style="margin-top:16px">Go to your library</button>'
          : '<button class="btn btn-primary btn-block" id="join-home" style="margin-top:16px">Open the library</button>'
      }`)
  }

  return card(`
    ${head}
    <p style="font-size:13px;color:var(--text-2);margin:12px 0 0;line-height:1.55">
      Signed in as <strong>${esc(ctx.state.me?.email || '')}</strong>.
      ${info.emailHint ? `<br>This invitation is for ${esc(info.emailHint)}.` : ''}
      ${info.allowedDomains?.length ? `<br>Open to ${esc(info.allowedDomains.join(', '))} addresses.` : ''}
      ${info.requiresApproval ? '<br>An admin approves new members.' : ''}
    </p>
    <button class="btn btn-primary btn-block" id="join-accept" style="margin-top:16px">Accept invitation</button>`)
}

