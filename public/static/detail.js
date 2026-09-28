/**
 * Artifact detail (§82), version history (§14) and artifact analytics (§46, §88).
 *
 * Detail is the screen where the mobile-first rules matter most: primary
 * actions (Share, Download) live in a sticky bottom bar inside the thumb zone,
 * and secondary actions live in a bottom sheet rather than a top-right menu.
 */

import {
  esc,
  icon,
  toast,
  sheet,
  emptyState,
  screenHeader,
  formatBytes,
  timeAgo,
  formatDate,
  formatDateTime,
  kindLabel,
  extLabel,
  fileBadge,
  safeUrl
} from './ui.js'

// ---------------------------------------------------------------
// Artifact detail (§82)
// ---------------------------------------------------------------

export function renderArtifactDetail(ctx) {
  const detail = ctx.detail

  if (detail.loading) {
    return {
      html: `
        ${screenHeader({ title: 'Artifact', onBackId: 'detail-back' })}
        <main class="app-main">
          <div class="card" style="padding:14px">
            <div class="skeleton" style="height:200px;border-radius:10px"></div>
            <div class="skeleton" style="height:16px;width:65%;margin-top:16px"></div>
            <div class="skeleton" style="height:12px;width:35%;margin-top:10px"></div>
            <div class="skeleton" style="height:48px;margin-top:18px;border-radius:12px"></div>
          </div>
        </main>`
    }
  }

  const artifact = detail.artifact
  if (!artifact) {
    return {
      html: `
        ${screenHeader({ title: 'Artifact', onBackId: 'detail-back' })}
        <main class="app-main">
          <div class="card" style="padding:4px 0 12px">
            ${emptyState({
              iconName: 'alert',
              title: 'Artifact unavailable',
              message: 'It may have been deleted, or you no longer have access.'
            })}
          </div>
        </main>`,
      mount(root) {
        root.querySelector('#detail-back')?.addEventListener('click', () => ctx.goBack())
      }
    }
  }

  const a = artifact
  const analytics = detail.analytics
  const tags = a.tags || []
  const versions = detail.versions || []
  const isHtml = a.mimeType === 'text/html'
  const isImage = ['image/png', 'image/jpeg', 'image/bmp', 'image/gif'].includes(a.mimeType)
  const processing = ['UPLOADING', 'PROCESSING'].includes(a.status)
  const failed = ['PROCESSING_FAILED', 'QUARANTINED'].includes(a.status)

  const statusBanner = failed
    ? `<div class="card" style="padding:13px;margin-bottom:12px;background:var(--danger-weak);border-color:#fecdca">
         <div style="display:flex;gap:9px;align-items:flex-start;font-size:13px;color:var(--danger);line-height:1.5">
           ${icon('alert', 17)}
           <div>
             <strong>${esc(a.status === 'QUARANTINED' ? 'Quarantined' : 'Processing failed')}</strong><br>
             ${esc(a.statusDetail || 'This file could not be processed.')}
           </div>
         </div>
       </div>`
    : processing
      ? `<div class="card" style="padding:13px;margin-bottom:12px;background:var(--warning-weak);border-color:#fedf89">
           <div style="display:flex;gap:9px;align-items:center;font-size:13px;color:var(--warning)">
             ${icon('refresh', 16)} Processing — indexing and validation in progress.
           </div>
         </div>`
      : ''

  return {
    html: `
      ${screenHeader({ title: a.title, onBackId: 'detail-back', rightId: 'detail-more', rightLabel: 'More actions' })}

      <main class="app-main" id="detail-main" style="padding-top:12px">
        ${statusBanner}

        ${
          isHtml
            ? `<div class="card" style="padding:0;overflow:hidden;margin-bottom:14px">
                 <iframe class="preview-frame" title="Preview of ${esc(a.title)}"
                   sandbox="allow-scripts" referrerpolicy="no-referrer" loading="lazy"
                   src="${safeUrl(`/api/v1/artifacts/${encodeURIComponent(a.id)}/preview`)}"></iframe>
               </div>`
            : isImage
              ? `<div class="card" style="padding:10px;margin-bottom:14px;text-align:center">
                   <img alt="Preview of ${esc(a.title)}" loading="lazy"
                     src="${safeUrl(`/api/v1/artifacts/${encodeURIComponent(a.id)}/content`)}"
                     style="max-width:100%;height:auto;border-radius:10px;display:block;margin:0 auto">
                 </div>`
              : `<div class="card" style="padding:18px;margin-bottom:14px;display:flex;gap:14px;align-items:center">
                   <div style="transform:scale(1.35);transform-origin:left center">${fileBadge(a.extension)}</div>
                   <div style="flex:1;min-width:0">
                     <div style="font-size:13.5px;font-weight:600">${esc(kindLabel(a.extension))}</div>
                     <div style="font-size:12px;color:var(--text-2);margin-top:3px">
                       Preview not available for ${esc(extLabel(a.extension))} in the browser
                     </div>
                   </div>
                 </div>`
        }

        <div class="card" style="padding:16px">
          <h1 style="font-size:19px;font-weight:650;margin:0;line-height:1.3;letter-spacing:-0.01em">${esc(a.title)}</h1>
          <div style="font-size:12.5px;color:var(--text-2);margin-top:6px">
            ${esc(extLabel(a.extension))} · ${esc(formatBytes(a.sizeBytes))} ·
            ${a.versionCount > 1 ? `${a.versionCount} versions · ` : ''}Updated ${esc(timeAgo(a.updatedAt))}
          </div>

          ${
            a.description
              ? `<p style="font-size:13.5px;color:var(--text-2);margin:12px 0 0;line-height:1.55">${esc(a.description)}</p>`
              : ''
          }

          ${
            tags.length
              ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:13px">
                  ${tags.map((t) => `<button class="chip" data-tag-manage style="min-height:28px;cursor:pointer">${esc(t)}</button>`).join('')}
                 </div>`
              : ''
          }

          <div style="font-size:12.5px;color:var(--text-2);margin-top:13px;display:flex;align-items:center;gap:7px">
            ${icon('folder', 15)} ${esc(a.workspace?.name || 'Workspace')}
          </div>
        </div>

        <div class="card" style="padding:16px;margin-top:12px">
          <div style="display:flex;justify-content:space-between;gap:8px;text-align:center">
            <div style="flex:1">
              <div style="font-size:19px;font-weight:640">${analytics?.permitted ? analytics.views : '—'}</div>
              <div style="font-size:11.5px;color:var(--text-2);margin-top:2px">Views</div>
            </div>
            <div style="flex:1">
              <div style="font-size:19px;font-weight:640">${analytics?.permitted ? analytics.uniqueViewers : '—'}</div>
              <div style="font-size:11.5px;color:var(--text-2);margin-top:2px">Viewers</div>
            </div>
            <div style="flex:1">
              <div style="font-size:19px;font-weight:640">${analytics?.permitted ? analytics.downloads : '—'}</div>
              <div style="font-size:11.5px;color:var(--text-2);margin-top:2px">Downloads</div>
            </div>
            <div style="flex:1">
              <div style="font-size:19px;font-weight:640">${analytics?.permitted ? analytics.aiReferences : '—'}</div>
              <div style="font-size:11.5px;color:var(--text-2);margin-top:2px">AI uses</div>
            </div>
          </div>

          ${
            analytics?.permitted
              ? `<button class="btn btn-secondary btn-block" id="detail-analytics" style="margin-top:14px">
                   ${icon('chart', 17)} View analytics
                 </button>`
              : `<p style="font-size:11.5px;color:var(--text-3);margin:13px 0 0;text-align:center;line-height:1.5">
                   ${esc(analytics?.reason || 'Analytics are visible to the owner and workspace admins.')}
                 </p>`
          }
        </div>

        <div class="card" style="padding:16px;margin-top:12px">
          <h2 style="font-size:13px;font-weight:640;margin:0 0 12px;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em">
            Details
          </h2>
          ${detailRow('Created through', a.sourceProvider && a.sourceProvider !== 'WEB' ? a.sourceProvider : 'Web upload')}
          ${detailRow('Created', formatDate(a.createdAt))}
          ${detailRow('Owner', a.isOwner ? 'You' : 'Someone else')}
          ${detailRow('Status', a.status)}
          ${detailRow('Versions', String(a.versionCount || versions.length))}
          ${detailRow('Search index', indexStateLabel(detail.indexState))}
          ${
            // Why that state was reached, in the artifact's own words: "no
            // extractable text" or "3 chunks indexed". The server strips model,
            // index and vector-detail wording before it reaches here.
            detail.indexState?.reason
              ? `<div style="font-size:11.5px;color:var(--text-2);padding:0 0 7px 0;margin-top:-2px">${esc(detail.indexState.reason)}</div>`
              : ''
          }
          ${a.checksum ? detailRow('Checksum', `${a.checksum.slice(0, 16)}…`) : ''}
          ${detailRow('Artifact ID', a.id)}
        </div>

        ${
          versions.length > 1
            ? `<button class="btn btn-secondary btn-block" id="detail-versions" style="margin-top:12px">
                 ${icon('clock', 17)} Version history (${versions.length})
               </button>`
            : ''
        }

        ${ctx.appFooter()}
      </main>

      <!-- Sticky bottom actions: thumb-accessible (§75, §82) -->
      <div style="position:fixed;left:50%;transform:translateX(-50%);bottom:0;width:100%;max-width:430px;
        padding:12px 16px calc(var(--safe-bottom) + 12px);box-sizing:border-box;
        background:linear-gradient(to top, var(--bg) 65%, rgba(246,247,249,0));z-index:30">
        <div style="display:flex;gap:9px">
          <button class="btn btn-secondary" id="detail-share" style="flex:1">
            ${icon('share', 18)} Share
          </button>
          ${
            a.canDownload
              ? `<a class="btn btn-primary" id="detail-download" style="flex:1;text-decoration:none;color:#fff"
                   href="${safeUrl(`/api/v1/artifacts/${encodeURIComponent(a.id)}/content?download=1`)}" download>
                   ${icon('download', 18)} Download
                 </a>`
              : `<button class="btn btn-secondary" style="flex:1" disabled>Download off</button>`
          }
        </div>
      </div>`,
    mount(root) {
      root.querySelector('#detail-back')?.addEventListener('click', () => ctx.goBack())
      root.querySelector('#detail-more')?.addEventListener('click', () => ctx.openArtifactMenuSheet(a))
      root.querySelector('#detail-share')?.addEventListener('click', () => ctx.openShareCreateSheet(a))
      root.querySelector('#detail-analytics')?.addEventListener('click', () => ctx.openAnalyticsScreen(a.id))
      root.querySelector('#detail-versions')?.addEventListener('click', () => ctx.openVersionsSheet(a))
      root.querySelectorAll('[data-tag-manage]').forEach((button) => {
        button.addEventListener('click', () => ctx.openTagsSheet({ artifact: a }))
      })
    }
  }
}

/**
 * Plain-language indexing state for the detail screen.
 *
 * Deliberately abstract: a user cares whether their document is findable by
 * meaning, not which model or index backs it. No model name, vector id or
 * dimension is shown here — the API does not even return them to this screen.
 *
 * `PARTIAL` is the honest answer for a document we understood but that held
 * nothing embeddable (a scan, or a file with no text layer), which is
 * different from a failure and is labelled as such.
 */
function indexStateLabel(indexState) {
  if (!indexState) return '—'
  switch (indexState.state) {
    case 'INDEXED':
      return 'Indexed'
    case 'PARTIAL':
      return 'Partial'
    case 'FAILED':
      return 'Failed'
    case 'SKIPPED':
      return 'Not indexed'
    default:
      return 'Processing'
  }
}

function detailRow(label, value) {
  return `
    <div style="display:flex;justify-content:space-between;gap:12px;padding:7px 0;font-size:13px">
      <span style="color:var(--text-2);flex:none">${esc(label)}</span>
      <span style="font-weight:550;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        font-family:${label === 'Artifact ID' || label === 'Checksum' ? 'ui-monospace,monospace' : 'inherit'};
        font-size:${label === 'Artifact ID' || label === 'Checksum' ? '11.5px' : '13px'}">${esc(value)}</span>
    </div>`
}

// ---------------------------------------------------------------
// Analytics screen (§46, §88)
// ---------------------------------------------------------------

export function renderAnalytics(ctx) {
  const view = ctx.analyticsView

  if (view.loading) {
    return {
      html: `
        ${screenHeader({ title: 'Analytics', onBackId: 'analytics-back' })}
        <main class="app-main">
          <div class="stats">
            ${Array.from({ length: 4 })
              .map(() => '<div class="skeleton" style="height:74px;border-radius:14px"></div>')
              .join('')}
          </div>
        </main>`
    }
  }

  const data = view.data
  if (!data?.permitted) {
    return {
      html: `
        ${screenHeader({ title: 'Analytics', onBackId: 'analytics-back' })}
        <main class="app-main">
          <div class="card" style="padding:4px 0 12px">
            ${emptyState({
              iconName: 'lock',
              title: 'Analytics unavailable',
              message: data?.reason || 'Only the owner and workspace admins can see analytics.'
            })}
          </div>
        </main>`,
      mount(root) {
        root.querySelector('#analytics-back')?.addEventListener('click', () => ctx.goBack())
      }
    }
  }

  const periods = [
    ['7d', 'Last 7 days'],
    ['30d', 'Last 30 days'],
    ['90d', 'Last 90 days'],
    ['all', 'All time']
  ]

  const maxViews = Math.max(1, ...data.series.map((s) => s.views))

  const sourceRows = [
    ['Internal', data.sources.internal, data.sourcePercentages.internal],
    ['Public link', data.sources.publicLink, data.sourcePercentages.publicLink],
    ['Email share', data.sources.email, data.sourcePercentages.email],
    ['Domain share', data.sources.domain, data.sourcePercentages.domain],
    ['AI', data.sources.ai, data.sourcePercentages.ai]
  ]

  const eventLabel = {
    artifact_viewed: 'Viewed',
    artifact_downloaded: 'Downloaded',
    artifact_ai_referenced: 'Referenced',
    artifact_version_created: 'New version'
  }

  return {
    html: `
      ${screenHeader({
        title: 'Analytics',
        subtitle: view.title,
        onBackId: 'analytics-back'
      })}

      <main class="app-main" style="padding-top:12px">
        <button class="input" id="analytics-period"
          style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;cursor:pointer;text-align:left">
          <span style="font-size:14px;font-weight:560">
            ${esc(periods.find((p) => p[0] === data.period)?.[1] || 'Last 30 days')}
          </span>
          ${icon('back', 16, 'rotate-270')}
        </button>

        <div class="stats">
          <div class="stat-tile">
            <div class="stat-value">${data.views}</div>
            <div class="stat-label">Views</div>
          </div>
          <div class="stat-tile">
            <div class="stat-value">${data.uniqueViewers}</div>
            <div class="stat-label">Unique viewers</div>
          </div>
          <div class="stat-tile">
            <div class="stat-value">${data.downloads}</div>
            <div class="stat-label">Downloads</div>
          </div>
          <div class="stat-tile">
            <div class="stat-value">${data.aiReferences}</div>
            <div class="stat-label">AI references</div>
          </div>
        </div>

        ${
          data.series.length
            ? `<div class="card" style="padding:16px;margin-top:12px">
                <h2 style="font-size:14px;font-weight:640;margin:0 0 14px">View trend</h2>
                <div style="display:flex;align-items:flex-end;gap:3px;height:78px" role="img"
                  aria-label="Daily views chart, peak ${maxViews} views">
                  ${data.series
                    .map((point) => {
                      const height = Math.max(3, Math.round((point.views / maxViews) * 72))
                      return `<div style="flex:1;min-width:3px;background:var(--accent);border-radius:2px 2px 0 0;height:${height}px"
                        title="${esc(point.date)}: ${point.views} views"></div>`
                    })
                    .join('')}
                </div>
                <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-3);margin-top:7px">
                  <span>${esc(data.series[0]?.date || '')}</span>
                  <span>${esc(data.series[data.series.length - 1]?.date || '')}</span>
                </div>
              </div>`
            : ''
        }

        <div class="card" style="padding:16px;margin-top:12px">
          <h2 style="font-size:14px;font-weight:640;margin:0 0 12px">Access source</h2>
          ${sourceRows
            .map(
              ([label, count, pct]) => `
            <div style="margin-bottom:11px">
              <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:5px">
                <span style="color:var(--text-2)">${esc(label)}</span>
                <span style="font-weight:560">${count}${count ? ` · ${pct}%` : ''}</span>
              </div>
              <div style="height:6px;background:var(--surface-2);border-radius:999px;overflow:hidden">
                <div style="height:100%;width:${pct}%;background:var(--text);border-radius:999px"></div>
              </div>
            </div>`
            )
            .join('')}
          ${
            data.views === 0 && data.aiReferences === 0
              ? `<p style="font-size:12px;color:var(--text-3);margin:6px 0 0">No activity in this period yet.</p>`
              : ''
          }
        </div>

        <div class="card" style="padding:16px;margin-top:12px">
          <h2 style="font-size:14px;font-weight:640;margin:0 0 12px">Sharing</h2>
          <div style="display:flex;justify-content:space-between;font-size:13px;padding:5px 0">
            <span style="color:var(--text-2)">Active shares</span><span style="font-weight:560">${data.shares.active} of ${data.shares.total}</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:13px;padding:5px 0">
            <span style="color:var(--text-2)">Share link opens</span><span style="font-weight:560">${data.shareOpens}</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:13px;padding:5px 0">
            <span style="color:var(--text-2)">Denied attempts</span><span style="font-weight:560">${data.deniedRequests}</span>
          </div>
        </div>

        <div class="card" style="padding:16px;margin-top:12px">
          <h2 style="font-size:14px;font-weight:640;margin:0 0 4px">Top activity</h2>
          ${
            data.activity.length
              ? data.activity
                  .map(
                    (row) => `
            <div style="display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--border)">
              <div style="min-width:0">
                <div style="font-size:13px;font-weight:550">${esc(eventLabel[row.event] || row.event)}</div>
                <div style="font-size:11.5px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                  ${esc(row.actor)}
                </div>
              </div>
              <div style="font-size:11.5px;color:var(--text-3);flex:none;text-align:right">
                ${esc(timeAgo(row.at))}
                ${row.channel && row.channel !== 'INTERNAL' ? `<div>${esc(row.channel.replace('_', ' ').toLowerCase())}</div>` : ''}
              </div>
            </div>`
                  )
                  .join('')
              : '<p style="font-size:12.5px;color:var(--text-3);margin:8px 0 0">No activity recorded yet.</p>'
          }
        </div>

        <p style="font-size:11px;color:var(--text-3);text-align:center;margin:18px 0 0;line-height:1.6">
          Anonymous viewers are never identified.<br>Counts are deduplicated per viewer per day.
        </p>

        ${ctx.appFooter()}
      </main>`,
    mount(root) {
      root.querySelector('#analytics-back')?.addEventListener('click', () => ctx.goBack())
      root.querySelector('#analytics-period')?.addEventListener('click', () => {
        sheet({
          title: 'Time period',
          content: periods
            .map(
              ([value, label]) => `
            <button class="row" data-period="${value}" style="padding:12px 2px">
              <span style="flex:1">${esc(label)}</span>
              ${data.period === value ? icon('check', 18) : ''}
            </button>`
            )
            .join(''),
          onMount(handle) {
            handle.body.querySelectorAll('[data-period]').forEach((button) => {
              button.addEventListener('click', () => {
                ctx.loadAnalytics(view.artifactId, button.dataset.period)
              })
            })
          }
        })
      })
    }
  }
}

// ---------------------------------------------------------------
// Sheets owned by detail/analytics
// ---------------------------------------------------------------

export function versionsSheet(ctx, artifact, versions) {
  const rows = versions
    .map(
      (v) => `
    <div style="display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--border)">
      <div style="width:34px;height:34px;border-radius:9px;background:${v.isCurrent ? 'var(--accent-weak)' : 'var(--surface-2)'};
        display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:650;
        color:${v.isCurrent ? '#1d4ed8' : 'var(--text-2)'};flex:none">
        v${v.versionNumber}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13.5px;font-weight:560;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${esc(v.filename)}
        </div>
        <div style="font-size:11.5px;color:var(--text-2);margin-top:2px">
          ${esc(formatBytes(v.sizeBytes))} · ${esc(formatDate(v.createdAt))}${
            v.sourceProvider ? ` · ${esc(v.sourceProvider)}` : ''
          }
        </div>
        ${v.changeSummary ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:2px">${esc(v.changeSummary)}</div>` : ''}
        ${v.hasExtractedText ? `<div style="font-size:11px;color:var(--success);margin-top:2px">Text indexed</div>` : ''}
      </div>
      ${
        v.isCurrent
          ? '<span class="chip" style="background:var(--success-weak);color:var(--success)">Current</span>'
          : artifact.canWrite
            ? `<button class="btn btn-ghost" data-restore="${esc(v.id)}" style="min-height:36px;padding:0 10px;font-size:12.5px">Restore</button>`
            : ''
      }
    </div>`
    )
    .join('')

  sheet({
    title: `Version history`,
    content: `
      <div>${rows}</div>
      ${
        artifact.canWrite
          ? `<button class="btn btn-secondary btn-block" id="version-add" style="margin-top:14px">
               ${icon('upload', 17)} Upload a new version
             </button>`
          : ''
      }
      <p style="font-size:11.5px;color:var(--text-3);margin:12px 0 0;line-height:1.55">
        Adding a version preserves every previous one. The artifact's URL and identity never change.
      </p>`,
    onMount(handle) {
      handle.body.querySelectorAll('[data-restore]').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            await ctx.api.restoreVersion(artifact.id, button.dataset.restore)
            toast('Version restored', 'success')
            ctx.refresh()
          } catch (err) {
            toast(err.message, 'error')
          }
        })
      })
      handle.body.querySelector('#version-add')?.addEventListener('click', () => {
        ctx.openVersionUploadSheet(artifact)
      })
    }
  })
}

/** Share creation (§86) */
export function shareCreateSheet(ctx, target, onCreated) {
  let accessType = 'PUBLIC_LINK'
  let allowDownload = false
  let expiresChoice = 'never'
  let recipients = ''

  const bodyHtml = () => `
    <div>
      <div style="font-size:12.5px;font-weight:640;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">
        Who can access
      </div>

      ${[
        ['PUBLIC_LINK', 'Anyone with the link', 'No verification required'],
        ['EMAIL', 'Specific people', 'They verify their email to open it'],
        ['DOMAIN', 'Email domain', 'Anyone with a verified address on that domain']
      ]
        .map(
          ([value, label, hint]) => `
        <label class="row" style="gap:11px;align-items:flex-start;padding:11px 0;cursor:pointer">
          <input type="radio" name="access-type" value="${value}" ${accessType === value ? 'checked' : ''}
            style="margin-top:3px;accent-color:var(--accent);width:18px;height:18px;flex:none">
          <span style="flex:1">
            <span style="display:block;font-size:14px;font-weight:560">${esc(label)}</span>
            <span style="display:block;font-size:11.5px;color:var(--text-2);margin-top:2px">${esc(hint)}</span>
          </span>
        </label>`
        )
        .join('')}

      ${
        accessType !== 'PUBLIC_LINK'
          ? `<div id="recipients-field" style="margin-top:12px">
               <label for="share-recipients" style="font-size:12.5px;font-weight:600;display:block;margin-bottom:6px">
                 ${accessType === 'EMAIL' ? 'Email addresses' : 'Email domains'}
               </label>
               <input id="share-recipients" class="input" type="text"
                 placeholder="${accessType === 'EMAIL' ? 'alice@example.com, bob@example.com' : 'xyz.com'}"
                 value="${esc(recipients)}">
               <p style="font-size:11.5px;color:var(--text-2);margin:7px 0 0;line-height:1.5">
                 Separate multiple entries with commas.
                 ${accessType === 'DOMAIN' ? 'Recipients must verify an address on this domain — merely typing one grants nothing.' : ''}
               </p>
             </div>`
          : ''
      }

      <div style="margin-top:20px">
        <div style="font-size:12.5px;font-weight:640;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">
          Expiration
        </div>
        ${[
          ['never', 'Never'],
          ['7', 'In 7 days'],
          ['30', 'In 30 days'],
          ['custom', 'Pick a date']
        ]
          .map(
            ([value, label]) => `
          <label class="row" style="gap:11px;padding:11px 0;cursor:pointer">
            <input type="radio" name="expiry" value="${value}" ${expiresChoice === value ? 'checked' : ''}
              style="accent-color:var(--accent);width:18px;height:18px;flex:none">
            <span style="flex:1;font-size:14px">${esc(label)}</span>
          </label>`
          )
          .join('')}
        <input id="share-custom-date" type="date" class="input" style="margin-top:8px;${expiresChoice === 'custom' ? '' : 'display:none'}"
          min="${new Date().toISOString().slice(0, 10)}">
      </div>

      <div style="margin-top:20px">
        <div style="font-size:12.5px;font-weight:640;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">
          Permission
        </div>
        <label class="row" style="gap:11px;padding:11px 0">
          ${icon('eye', 19)} <span style="flex:1;font-size:14px">View in browser</span>
          <span class="chip" style="background:var(--success-weak);color:var(--success)">Always on</span>
        </label>
        <label class="row" style="gap:11px;padding:11px 0;cursor:pointer">
          ${icon('download', 19)} <span style="flex:1;font-size:14px">Allow download</span>
          <input type="checkbox" id="share-allow-download" ${allowDownload ? 'checked' : ''}
            style="accent-color:var(--accent);width:20px;height:20px;flex:none">
        </label>
      </div>

      ${
        'name' in target && target.name
          ? `<div style="margin-top:16px;padding:12px;border-radius:11px;background:var(--surface-2);font-size:12.5px;line-height:1.55;color:var(--text-2)">
               New artifacts added to this collection will be included automatically.
             </div>`
          : ''
      }
    </div>`

  sheet({
    title: `Share "${target.title || target.name}"`,
    content: bodyHtml(),
    actions: [
      {
        label: 'Create link',
        variant: 'primary',
        keepOpen: true,
        onClick: async () => {
          const handle = document.querySelector('.sheet')
          const type = handle?.querySelector('input[name="access-type"]:checked')?.value || 'PUBLIC_LINK'
          const expiry = handle?.querySelector('input[name="expiry"]:checked')?.value || 'never'
          const download = handle?.querySelector('#share-allow-download')?.checked || false
          const recipientRaw = handle?.querySelector('#share-recipients')?.value || ''
          const customDate = handle?.querySelector('#share-custom-date')?.value || ''

          const recipients = recipientRaw
            .split(',')
            .map((r) => r.trim())
            .filter(Boolean)
            .map((value) => ({ type: type === 'DOMAIN' ? 'DOMAIN' : 'EMAIL', value }))

          if (type !== 'PUBLIC_LINK' && !recipients.length) {
            toast(type === 'EMAIL' ? 'Add at least one email address' : 'Add at least one domain', 'error')
            return
          }

          let expiresAt = null
          if (expiry === '7') expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString()
          else if (expiry === '30') expiresAt = new Date(Date.now() + 30 * 86400_000).toISOString()
          else if (expiry === 'custom' && customDate) {
            expiresAt = new Date(`${customDate}T23:59:59`).toISOString()
          } else if (expiry === 'custom') {
            toast('Choose an expiry date', 'error')
            return
          }

          try {
            const result = await ctx.api.createShare({
              targetType: 'id' in target && target.name ? 'COLLECTION' : 'ARTIFACT',
              targetId: target.id,
              accessType: type,
              allowView: true,
              allowDownload: download,
              expiresAt,
              recipients,
              includeNewItems: true
            })

            ctx.refresh()
            onCreated?.(result)
            ctx.openShareResultSheet(result, target)
          } catch (err) {
            toast(err.message, 'error')
          }
        }
      }
    ],
    onMount(handle) {
      const rerenderBody = () => {
        handle.body.innerHTML = bodyHtml()
        bindBody()
      }

      const bindBody = () => {
        handle.body.querySelectorAll('input[name="access-type"]').forEach((input) => {
          input.addEventListener('change', () => {
            accessType = input.value
            rerenderBody()
          })
        })
        handle.body.querySelectorAll('input[name="expiry"]').forEach((input) => {
          input.addEventListener('change', () => {
            expiresChoice = input.value
            const dateField = handle.body.querySelector('#share-custom-date')
            if (dateField) dateField.style.display = expiresChoice === 'custom' ? '' : 'none'
          })
        })
        handle.body.querySelector('#share-recipients')?.addEventListener('input', (e) => {
          recipients = e.target.value
        })
        handle.body.querySelector('#share-allow-download')?.addEventListener('change', (e) => {
          allowDownload = e.target.checked
        })
      }

      bindBody()
    }
  })
}

/** Share result (§87) — the one moment the raw link is shown. */
export function shareResultSheet(ctx, result, target) {
  const url = result.url || `${window.location.origin}/s/${result.token}`

  sheet({
    title: 'Share created',
    content: `
      <div>
        <div style="padding:12px;border-radius:11px;background:var(--surface-2);
          font-family:ui-monospace,monospace;font-size:11.5px;word-break:break-all;line-height:1.6">
          ${esc(url)}
        </div>

        <div style="margin-top:16px;display:flex;flex-direction:column;gap:9px">
          <div style="display:flex;justify-content:space-between;font-size:13px">
            <span style="color:var(--text-2)">Access</span>
            <span style="font-weight:560">${esc(result.share.accessType.replace('_', ' ').toLowerCase())}</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:13px">
            <span style="color:var(--text-2)">Permission</span>
            <span style="font-weight:560">${result.share.allowDownload ? 'View + download' : 'View only'}</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:13px">
            <span style="color:var(--text-2)">Expires</span>
            <span style="font-weight:560">
              ${result.share.expiresAt ? esc(formatDate(result.share.expiresAt)) : 'Never'}
            </span>
          </div>
        </div>

        <div style="margin-top:16px;padding:11px 13px;border-radius:11px;background:var(--warning-weak);
          border:1px solid #fedf89;font-size:12px;line-height:1.55;color:#93370d">
          ${icon('alert', 13)} This link cannot be shown again. Revoke it and create a new one if you lose it.
        </div>
      </div>`,
    actions: [
      {
        label: 'Copy link',
        variant: 'primary',
        keepOpen: true,
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(url)
            toast('Link copied', 'success')
          } catch {
            // Clipboard API needs a secure context; fall back to selection
            const area = document.createElement('textarea')
            area.value = url
            document.body.appendChild(area)
            area.select()
            document.execCommand('copy')
            area.remove()
            toast('Link copied', 'success')
          }
        }
      },
      {
        label: 'Share via device',
        onClick: async () => {
          if (navigator.share) {
            try {
              await navigator.share({ title: target?.title || 'Shared artifact', url })
            } catch {
              /* user dismissed */
            }
          } else {
            toast('Sharing is not available on this device')
          }
        }
      }
    ]
  })
}
