---
name: save
description: Save what Claude just made (a doc, deck, page, code or media file) to the user's Artifactry library, or add a new version to something already there. Use when the user says "save this to Artifactry", "put this in the library" or "update the saved version".
---

# Save to Artifactry

Use the Artifactry tools from this plugin's `artifactry` server.

1. **New or revision?** If the work revises something already in the library (you opened it with `get` or `get_handoff`, or the user names it), call `create_version` on that artifact instead of `save`, so earlier versions are kept.
2. **Pick a file name with the right extension**, such as `q4-launch-plan.md`, `pricing-page.html` or `deck.pptx`. HTML is stored verbatim, so pass a complete document.
3. **Choose where it goes.** If the user names a workspace, collection or project, pass it. If not, and they have several workspaces, call `list_workspaces` and ask which one. Use `list_projects` when they mention a piece of work like "Q4 launch".
4. **Large files:** if the content is too big for one call, or it's a binary file on disk, use `upload_part` and then `save` with the returned `upload_id`.
5. **Lineage:** artifacts you read shortly before are linked as sources automatically. Pass `derived_from` only to name different sources, or `[]` to link none.
6. **Tags:** after saving, show the suggested tags and offer to confirm them with `update_tags`.

Reply with the artifact's title and link, and don't paste the content back.
