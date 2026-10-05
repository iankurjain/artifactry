/**
 * Handoffs and projects, for the app (the MCP tools are in lib/mcp-jobs.ts).
 *
 *   GET  /api/v1/handoffs                  → handoffs in readable workspaces (?status=all, ?workspaceId=)
 *   POST /api/v1/handoffs                  → leave a handoff from the app
 *   GET  /api/v1/handoffs/:handoffId       → one handoff with the artifacts the caller may read
 *   POST /api/v1/handoffs/:handoffId/status → close or reopen
 *   GET  /api/v1/projects                  → collections marked as projects
 */

import { Hono } from 'hono'
import type { AppEnv } from '../middleware'
import { guarded, requirePrincipal } from '../middleware'
import { badRequest, ok, readJson } from '../lib/http'
import { can, loadWorkspace } from '../lib/principal'
import {
  MAX_HANDOFF_ARTIFACTS,
  createHandoff,
  handoffArtifacts,
  listHandoffs,
  listProjects,
  loadHandoffFor,
  madeByLabel,
  presentHandoff,
  resolveReadableRefs,
  setHandoffStatus
} from '../lib/handoffs'

const handoffs = new Hono<AppEnv>()

handoffs.get(
  '/handoffs',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const workspaceId = c.req.query('workspaceId')
    const rows = await listHandoffs(c.env.DB, principal, {
      workspaceIds: workspaceId ? [workspaceId] : undefined,
      status: c.req.query('status') === 'all' ? 'ALL' : 'OPEN',
      limit: Number(c.req.query('limit') ?? 20) || 20
    })
    const origin = new URL(c.req.url).origin
    return ok(c, { handoffs: rows.map((r) => presentHandoff(r, origin)) })
  })
)

handoffs.post(
  '/handoffs',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const body = await readJson<{
      artifactIds?: unknown
      brief?: unknown
      title?: unknown
      to?: unknown
      workspaceId?: unknown
    }>(c)

    const refs = Array.isArray(body.artifactIds) ? body.artifactIds : []
    const { artifacts } = await resolveReadableRefs(c.env.DB, principal, refs, MAX_HANDOFF_ARTIFACTS)
    if (!artifacts.length) throw badRequest('Choose at least one artifact you can open.')

    const workspaceId = typeof body.workspaceId === 'string' && body.workspaceId ? body.workspaceId : artifacts[0].workspace_id
    const workspace = await loadWorkspace(c.env.DB, workspaceId)
    if (!workspace) throw badRequest('That workspace does not exist.')

    const handoff = await createHandoff(c.env.DB, principal, {
      workspace,
      artifacts,
      brief: typeof body.brief === 'string' ? body.brief : '',
      title: typeof body.title === 'string' ? body.title : null,
      toTool: typeof body.to === 'string' ? body.to : null
    })
    return ok(c, { handoff: presentHandoff(handoff, new URL(c.req.url).origin) }, 201)
  })
)

handoffs.get(
  '/handoffs/:handoffId',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const { handoff, workspace } = await loadHandoffFor(c.env.DB, principal, c.req.param('handoffId'))
    const { artifacts, hidden } = await handoffArtifacts(c.env.DB, principal, handoff.id)
    const origin = new URL(c.req.url).origin
    return ok(c, {
      handoff: {
        ...presentHandoff(handoff, origin),
        workspaceName: workspace.name,
        canChange: handoff.created_by === principal.userId || can(principal, 'artifact.update', workspace)
      },
      artifacts: artifacts.map((a) => ({
        id: a.id,
        title: a.title,
        extension: a.extension,
        mimeType: a.mime_type,
        madeBy: madeByLabel(a.source_provider, a.source_client),
        updatedAt: a.updated_at,
        canonicalUrl: `${origin}/a/${a.id}`
      })),
      hiddenArtifacts: hidden
    })
  })
)

handoffs.post(
  '/handoffs/:handoffId/status',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const body = await readJson<{ status?: unknown }>(c)
    if (body.status !== 'OPEN' && body.status !== 'CLOSED') throw badRequest('status must be OPEN or CLOSED')
    const { handoff, workspace } = await loadHandoffFor(c.env.DB, principal, c.req.param('handoffId'))
    await setHandoffStatus(c.env.DB, principal, handoff, workspace, body.status)
    return ok(c, { handoff: presentHandoff(handoff, new URL(c.req.url).origin) })
  })
)

handoffs.get(
  '/projects',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const workspaceId = c.req.query('workspaceId')
    const rows = await listProjects(c.env.DB, principal, workspaceId ? [workspaceId] : undefined)
    return ok(c, {
      projects: rows.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        workspaceId: p.workspace_id,
        workspaceName: p.workspace_name,
        artifactCount: p.artifact_count,
        updatedAt: p.updated_at
      }))
    })
  })
)

export default handoffs
