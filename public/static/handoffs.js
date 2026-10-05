/**
 * Moving work between AI tools: the Connect screen, handoffs, lineage and the
 * first-run checklist.
 *
 *   /connect     one card per AI tool, with the MCP URL and its setup steps
 *   /handoffs    handoffs waiting in your workspaces
 *   /h/:id       one handoff: its brief, its artifacts, the prompt to paste
 *
 * Plus fragments other screens embed: the first-run card and handoff list on
 * Home, the "Built from / Used in" card on an artifact, and the sheet that
 * leaves a handoff from an artifact.
 */

import { esc, icon, screenHeader, emptyState, timeAgo, fileBadge, extLabel, sheet, toast, spinner } from './ui.js'

// ---------------------------------------------------------------
// The tools, and how to connect each one
// ---------------------------------------------------------------

/**
 * `label` is the name the server reports in connectedTools / madeBy, so a card
 * can show "Connected". Steps are short on purpose; `docs` links to the full
 * guide for each tool.
 */
const TOOLS = [
  {
    id: 'claude',
    label: 'Claude',
    title: 'Claude',
    where: 'claude.ai, Claude Desktop and the mobile apps',
    steps: [
      'In Claude, open <strong>Settings → Connectors</strong> and choose <strong>Add custom connector</strong>.',
      'Name it <strong>Artifactry</strong> and paste the server URL below. Leave the OAuth fields empty.',
      'Choose <strong>Add</strong>, then <strong>Connect</strong>. Sign in here and choose <strong>Allow</strong>.'
    ],
    snippet: (url) => `Name: Artifactry\nRemote MCP server URL: ${url}`,
    docs: 'mcp-claude'
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    title: 'ChatGPT',
    where: 'chatgpt.com and the desktop app (Plus, Pro, Business or Enterprise)',
    steps: [
      'In ChatGPT settings, turn on <strong>Developer mode</strong>, then open <strong>Apps &amp; Connectors → Create</strong>.',
      'Name it <strong>Artifactry</strong>, paste the server URL below and pick <strong>OAuth</strong>.',
      'Choose <strong>Create</strong>, sign in here and choose <strong>Allow</strong>. In a chat, switch Artifactry on from the <strong>+</strong> menu.'
    ],
    snippet: (url) => `Name: Artifactry\nMCP Server URL: ${url}\nAuthentication: OAuth`,
    docs: 'mcp-chatgpt'
  },
  {
    id: 'cursor',
    label: 'Cursor',
    title: 'Cursor',
    where: 'the Cursor editor',
    steps: [
      'Open <strong>Cursor Settings → MCP &amp; Integrations</strong> and choose <strong>New MCP server</strong>. This opens <code>~/.cursor/mcp.json</code>.',
      'Paste the config below (merge it with anything already there) and save the file.',
      'Back in Cursor Settings, choose <strong>Login</strong> next to Artifactry, sign in here and choose <strong>Allow</strong>.'
    ],
    snippet: (url) => JSON.stringify({ mcpServers: { artifactry: { url } } }, null, 2),
    docs: 'mcp-others'
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    title: 'Claude Code',
    where: 'the terminal',
    steps: [
      'Run the command below in a terminal.',
      'Start <code>claude</code> and type <code>/mcp</code>.',
      'Choose <strong>artifactry → Authenticate</strong>, sign in here and choose <strong>Allow</strong>.'
    ],
    snippet: (url) => `claude mcp add --transport http --scope user artifactry ${url}`,
    docs: 'mcp-claude-code'
  },
  {
    id: 'gemini',
    label: 'Gemini',
    title: 'Gemini CLI',
    where: 'the terminal (the Gemini web app does not support connectors yet)',
    steps: [
      'Install the Gemini CLI and run <code>gemini</code> once to sign in.',
      'Run the command below.',
      'Start <code>gemini</code>, run <code>/mcp auth artifactry</code>, sign in here and choose <strong>Allow</strong>.'
    ],
    snippet: (url) => `gemini mcp add --transport http --scope user artifactry ${url}`,
    docs: 'mcp-gemini'
  },
  {
    id: 'copilot',
    label: 'Copilot',
    title: 'Copilot and other tools',
    where: 'Copilot Studio, Codex, Windsurf and any MCP client',
    steps: [
      'Find the MCP or Connectors setting in the tool.',
      'Add a remote (HTTP) MCP server named <strong>Artifactry</strong> with the URL below.',
      'If it supports OAuth, sign in here when it asks. If not, create a token under <strong>Add → Connected AI</strong>.'
    ],
    snippet: (url) => url,
    docs: 'mcp-others'
  }
]

const DOCS_BASE = 'https://docs.artifactry.app/'

export function mcpUrl(ctx) {
  return ctx.state.mcpEndpoint || `${window.location.origin}/api/v1/mcp`
}

function connectedLookup(ctx) {
  const map = new Map()
  for (const t of ctx.state.connectedTools || []) map.set(t.name, t.lastUsedAt)
  return map
}

function codeBlock(id, text) {
  return `
    <div class="code-snippet">
      <pre id="${esc(id)}">${esc(text)}</pre>
      <button class="btn btn-secondary" data-copy="${esc(id)}" style="min-height:34px;padding:0 12px;font-size:12.5px">
        ${icon('link', 14)} Copy
      </button>
    </div>`
}

function wireCopy(root, ctx) {
  root.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', () => {
      const node = root.querySelector(`#${CSS.escape(button.dataset.copy)}`)
      if (node) ctx.copyText(node.textContent)
    })
  })
}

// ---------------------------------------------------------------
// /connect
// ---------------------------------------------------------------

export function renderConnect(ctx) {
  const url = mcpUrl(ctx)
  const connected = connectedLookup(ctx)
  const open = ctx.connectOpen || null

  const cards = TOOLS.map((tool) => {
    const isConnected = connected.has(tool.label)
    const lastUsed = connected.get(tool.label)
    const expanded = open === tool.id
    return `
      <section class="card" style="padding:0;overflow:hidden;margin-bottom:10px" aria-labelledby="tool-${esc(tool.id)}">
        <button class="row" data-tool="${esc(tool.id)}" aria-expanded="${expanded}" style="padding:13px 14px">
          ${icon('ai', 20)}
          <span style="flex:1;min-width:0">
            <span id="tool-${esc(tool.id)}" style="font-weight:600">${esc(tool.title)}</span>
            <span style="display:block;font-size:11.5px;color:var(--text-2)">${esc(tool.where)}</span>
          </span>
          ${
            isConnected
              ? `<span class="chip" style="background:var(--success-weak);color:var(--success)">${icon('check', 12)} Connected</span>`
              : `<span class="chip">Set up</span>`
          }
          ${icon(expanded ? 'chevronUp' : 'chevronDown', 16)}
        </button>
        ${
          expanded
            ? `<div style="padding:2px 16px 16px">
                <ol class="connect-steps">
                  ${tool.steps.map((s) => `<li>${s}</li>`).join('')}
                </ol>
                ${codeBlock(`snippet-${tool.id}`, tool.snippet(url))}
                <p style="font-size:12.5px;color:var(--text-2);margin:12px 0 0;line-height:1.55">
                  ${isConnected && lastUsed ? `Last used ${esc(timeAgo(lastUsed))}. ` : ''}
                  Then try: <em>"Save a short note called Connection test to Artifactry."</em>
                  <a href="${DOCS_BASE}#${esc(tool.docs)}" target="_blank" rel="noopener">Full guide</a>
                </p>
              </div>`
            : ''
        }
      </section>`
  }).join('')

  return {
    html: `
      ${screenHeader({ title: 'Connect an AI tool', onBackId: 'connect-back', subtitle: 'Let your AI tools save, find and hand off work here' })}
      <main class="app-main" style="padding-top:10px">
        <div class="card" style="padding:14px 16px;margin-bottom:14px">
          <div style="font-size:12.5px;color:var(--text-2);margin-bottom:6px">Artifactry server URL</div>
          ${codeBlock('mcp-url', url)}
          <p style="font-size:12.5px;color:var(--text-2);margin:10px 0 0;line-height:1.55">
            Every tool uses this one URL and signs in with your Artifactry account. A tool never gets more
            access than you have, and you can disconnect it any time under <strong>Profile</strong>.
          </p>
        </div>
        ${cards}
        ${ctx.appFooter()}
      </main>
      ${ctx.bottomNav('')}`,
    mount(root) {
      root.querySelector('#connect-back')?.addEventListener('click', () => ctx.goBack())
      root.querySelectorAll('[data-tool]').forEach((button) => {
        button.addEventListener('click', () => {
          ctx.connectOpen = ctx.connectOpen === button.dataset.tool ? null : button.dataset.tool
          ctx.refresh()
        })
      })
      wireCopy(root, ctx)
    }
  }
}

// ---------------------------------------------------------------
// Home fragments
// ---------------------------------------------------------------

/**
 * Shown until an AI tool has saved something: three steps from signup to a
 * first AI-saved artifact.
 */
export function firstRunCard(ctx) {
  const anyConnected = (ctx.state.connectedTools || []).length > 0
  const anyAiSaved = (ctx.state.artifacts || []).some((a) => a.madeBy)
  if (anyAiSaved) return ''

  const step = (done, n, title, body) => `
    <li style="display:flex;gap:11px;align-items:flex-start;padding:9px 0">
      <span class="first-run-dot${done ? ' is-done' : ''}" aria-hidden="true">${done ? icon('check', 13) : n}</span>
      <span style="flex:1">
        <span style="font-weight:600;font-size:14px${done ? ';color:var(--text-2);text-decoration:line-through' : ''}">${title}</span>
        <span style="display:block;font-size:12.5px;color:var(--text-2);margin-top:2px;line-height:1.5">${body}</span>
      </span>
      ${done ? '<span class="sr-only">Done</span>' : ''}
    </li>`

  return `
    <section class="card" style="padding:14px 16px;margin-top:14px" aria-labelledby="first-run-title">
      <h2 id="first-run-title" style="font-size:15px;font-weight:640;margin:0">Get your AI tools saving here</h2>
      <ol style="list-style:none;padding:0;margin:6px 0 4px">
        ${step(anyConnected, 1, 'Connect an AI tool', 'Claude, ChatGPT, Cursor or Gemini. It takes about a minute.')}
        ${step(false, 2, 'Ask it to save something', '"Save a one-page summary of this chat to Artifactry."')}
        ${step(false, 3, 'Find it here', 'It shows up in your library with the tool that made it.')}
      </ol>
      <button class="btn btn-primary btn-block" data-nav="/connect">${icon('ai', 17)} Connect an AI tool</button>
    </section>`
}

function handoffRow(h) {
  const status =
    h.status === 'PICKED_UP'
      ? `Picked up by ${esc(h.pickedUpBy || 'a tool')}`
      : h.status === 'CLOSED'
        ? 'Closed'
        : 'Waiting'
  return `
    <button class="row" data-nav="/h/${encodeURIComponent(h.id)}" style="padding:12px 14px">
      ${icon('share', 19)}
      <span style="flex:1;min-width:0">
        <span style="font-weight:600;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(h.title)}</span>
        <span style="display:block;font-size:11.5px;color:var(--text-2)">
          From ${esc(h.from)}${h.toTool ? ` for ${esc(h.toTool)}` : ''} · ${esc(String(h.artifactCount ?? ''))} artifact(s) · ${status} · ${esc(timeAgo(h.createdAt))}
        </span>
      </span>
      ${icon('chevron', 16)}
    </button>`
}

export function handoffsSection(ctx) {
  const list = (ctx.state.handoffs || []).slice(0, 3)
  if (!list.length) return ''
  return `
    <section aria-labelledby="home-handoffs">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin:22px 0 10px">
        <h2 id="home-handoffs" style="font-size:15px;font-weight:640;margin:0">Handoffs</h2>
        <button class="btn btn-ghost" data-nav="/handoffs" style="min-height:32px;padding:0 6px;font-size:13px">See all</button>
      </div>
      <div class="card" style="overflow:hidden">${list.map(handoffRow).join('')}</div>
    </section>`
}

// ---------------------------------------------------------------
// /handoffs
// ---------------------------------------------------------------

export function renderHandoffs(ctx) {
  const list = ctx.state.handoffs || []
  return {
    html: `
      ${screenHeader({ title: 'Handoffs', onBackId: 'handoffs-back', subtitle: 'Work one AI tool left for the next' })}
      <main class="app-main" style="padding-top:10px">
        ${
          list.length
            ? `<div class="card" style="overflow:hidden">${list.map(handoffRow).join('')}</div>`
            : `<div class="card">${emptyState({
                iconName: 'share',
                title: 'No handoffs yet',
                message:
                  'Ask one AI tool to hand its work to another, e.g. "Hand this research and the spec to Cursor to build." Or open an artifact and choose Hand off.'
              })}</div>`
        }
        <label style="display:flex;gap:8px;align-items:center;font-size:13px;color:var(--text-2);margin-top:14px">
          <input type="checkbox" id="handoffs-closed" ${ctx.handoffsShowClosed ? 'checked' : ''}> Show closed handoffs
        </label>
        ${ctx.appFooter()}
      </main>
      ${ctx.bottomNav('')}`,
    mount(root) {
      root.querySelector('#handoffs-back')?.addEventListener('click', () => ctx.goBack())
      root.querySelector('#handoffs-closed')?.addEventListener('change', (e) => {
        ctx.handoffsShowClosed = e.target.checked
        ctx.reload()
      })
    }
  }
}

// ---------------------------------------------------------------
// /h/:id
// ---------------------------------------------------------------

export function renderHandoff(ctx) {
  const view = ctx.handoffView || {}
  if (view.loading || !view.handoff) {
    return {
      html: `
        ${screenHeader({ title: 'Handoff', onBackId: 'handoff-back' })}
        <main class="app-main" style="padding-top:24px;text-align:center">${view.error ? esc(view.error) : spinner(true)}</main>
        ${ctx.bottomNav('')}`,
      mount(root) {
        root.querySelector('#handoff-back')?.addEventListener('click', () => ctx.goBack())
      }
    }
  }

  const h = view.handoff
  const status =
    h.status === 'PICKED_UP'
      ? `Picked up by ${esc(h.pickedUpBy || 'an AI tool')} ${esc(timeAgo(h.pickedUpAt))}`
      : h.status === 'CLOSED'
        ? 'Closed'
        : `Waiting${h.toTool ? ` for ${esc(h.toTool)}` : ''}`

  const artifacts = (view.artifacts || [])
    .map(
      (a, n) => `
      <button class="row" data-artifact="${esc(a.id)}" style="padding:11px 14px">
        <span style="font-size:12px;color:var(--text-3);width:16px">${n + 1}</span>
        ${fileBadge(a.extension)}
        <span style="flex:1;min-width:0">
          <span style="font-weight:600;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(a.title)}</span>
          <span style="display:block;font-size:11.5px;color:var(--text-2)">${esc(extLabel(a.extension))}${a.madeBy ? ` · made by ${esc(a.madeBy)}` : ''}</span>
        </span>
        ${icon('chevron', 16)}
      </button>`
    )
    .join('')

  return {
    html: `
      ${screenHeader({ title: h.title, onBackId: 'handoff-back', subtitle: `From ${h.from} · ${h.workspaceName || ''}` })}
      <main class="app-main" style="padding-top:10px">
        <div class="card" style="padding:14px 16px">
          <div style="font-size:12.5px;color:var(--text-2)">${status}</div>
          <h2 style="font-size:14px;font-weight:640;margin:12px 0 6px">Brief</h2>
          <p style="white-space:pre-wrap;font-size:14px;line-height:1.55;margin:0">${esc(h.brief)}</p>
        </div>

        <div class="card" style="padding:14px 16px;margin-top:12px">
          <h2 style="font-size:14px;font-weight:640;margin:0 0 4px">Paste this into the next tool</h2>
          <p style="font-size:12.5px;color:var(--text-2);margin:0 0 8px;line-height:1.5">
            The tool needs Artifactry connected. <button class="guide-inline-link" data-nav="/connect">Connect a tool</button>
          </p>
          ${codeBlock('handoff-prompt', h.pickupPrompt)}
        </div>

        <h2 style="font-size:14px;font-weight:640;margin:20px 0 9px">Artifacts</h2>
        <div class="card" style="overflow:hidden">${artifacts || '<p style="padding:14px;margin:0;font-size:13px;color:var(--text-2)">None you can open.</p>'}</div>
        ${view.hiddenArtifacts ? `<p style="font-size:12px;color:var(--text-3);margin:8px 0 0">${esc(String(view.hiddenArtifacts))} more you don't have access to.</p>` : ''}

        ${
          h.canChange
            ? `<button class="btn btn-secondary btn-block" id="handoff-status" style="margin-top:16px">
                ${h.status === 'CLOSED' ? 'Reopen handoff' : 'Close handoff'}
              </button>`
            : ''
        }
        ${ctx.appFooter()}
      </main>
      ${ctx.bottomNav('')}`,
    mount(root) {
      root.querySelector('#handoff-back')?.addEventListener('click', () => ctx.goBack())
      wireCopy(root, ctx)
      root.querySelector('#handoff-status')?.addEventListener('click', async () => {
        try {
          await ctx.api.setHandoffStatus(h.id, h.status === 'CLOSED' ? 'OPEN' : 'CLOSED')
          toast(h.status === 'CLOSED' ? 'Handoff reopened' : 'Handoff closed', 'success')
          ctx.reload()
        } catch (error) {
          toast(error.message || 'Could not change the handoff', 'error')
        }
      })
    }
  }
}

// ---------------------------------------------------------------
// Artifact detail: lineage and "Hand off"
// ---------------------------------------------------------------

function lineageRows(entries, artifactId, canEdit) {
  return entries
    .map(
      (e) => `
      <div class="row" style="padding:10px 14px">
        ${fileBadge(e.extension)}
        <button data-artifact="${esc(e.artifactId)}" style="flex:1;min-width:0;text-align:left;background:none;border:0;padding:0;cursor:pointer;color:inherit">
          <span style="font-weight:600;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(e.title)}</span>
          <span style="display:block;font-size:11.5px;color:var(--text-2)">
            ${e.madeBy ? `Made by ${esc(e.madeBy)} · ` : ''}${e.origin === 'INFERRED' ? 'Linked automatically' : e.origin === 'USER' ? 'Linked by a person' : 'Declared by the tool'}
          </span>
        </button>
        ${
          canEdit
            ? `<button class="btn btn-ghost" data-unlink="${esc(e.linkId)}" data-unlink-artifact="${esc(artifactId)}"
                 aria-label="Remove link to ${esc(e.title)}" title="Remove this link" style="min-width:40px;padding:0 8px">${icon('x', 16)}</button>`
            : ''
        }
      </div>`
    )
    .join('')
}

/** "Built from" and "Used in", shown on an artifact when either has entries. */
export function lineageCard(artifact) {
  const lineage = artifact.lineage || { builtFrom: [], usedIn: [] }
  if (!lineage.builtFrom.length && !lineage.usedIn.length) return ''
  const canEdit = Boolean(artifact.canUpdate || artifact.isOwner)
  return `
    <section class="card" style="padding:0;overflow:hidden;margin-top:12px" aria-label="Lineage">
      ${
        lineage.builtFrom.length
          ? `<h2 style="font-size:13.5px;font-weight:640;margin:0;padding:13px 14px 4px">Built from</h2>
             ${lineageRows(lineage.builtFrom, artifact.id, canEdit)}`
          : ''
      }
      ${
        lineage.usedIn.length
          ? `<h2 style="font-size:13.5px;font-weight:640;margin:0;padding:13px 14px 4px">Used in</h2>
             ${lineageRows(lineage.usedIn, artifact.id, canEdit)}`
          : ''
      }
    </section>`
}

export function wireLineage(root, ctx) {
  root.querySelectorAll('[data-unlink]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation()
      try {
        await ctx.api.removeLink(button.dataset.unlinkArtifact, button.dataset.unlink)
        toast('Link removed', 'success')
        ctx.reload()
      } catch (error) {
        toast(error.message || 'Could not remove the link', 'error')
      }
    })
  })
}

/** Leave a handoff for another tool, starting from one artifact. */
export function openHandoffSheet(ctx, artifact) {
  sheet({
    title: 'Hand off to another AI tool',
    content: `
      <div style="padding:4px 16px 0">
        <p style="font-size:13px;color:var(--text-2);margin:0 0 12px;line-height:1.5">
          Leave <strong>${esc(artifact.title)}</strong> with a brief. You'll get a line to paste into the next tool,
          which opens it with everything it needs.
        </p>
        <label class="label" for="handoff-to">For which tool? (optional)</label>
        <input class="input" id="handoff-to" placeholder="e.g. Cursor" maxlength="60" style="margin-bottom:12px">
        <label class="label" for="handoff-brief">What should it do?</label>
        <textarea class="input" id="handoff-brief" rows="5" maxlength="8000"
          placeholder="e.g. Build the pricing page described in this spec. Use our existing button styles."></textarea>
      </div>`,
    actions: [
      {
        label: 'Create handoff',
        variant: 'primary',
        keepOpen: true,
        onClick: async () => {
          const brief = document.getElementById('handoff-brief')?.value || ''
          const to = document.getElementById('handoff-to')?.value || ''
          if (!brief.trim()) {
            toast('Write a short brief first', 'error')
            return
          }
          try {
            const result = await ctx.api.createHandoff({ artifactIds: [artifact.id], brief, to })
            ctx.closeSheet()
            ctx.navigate(`/h/${encodeURIComponent(result.handoff.id)}`)
          } catch (error) {
            toast(error.message || 'Could not create the handoff', 'error')
          }
        }
      }
    ]
  })
}
