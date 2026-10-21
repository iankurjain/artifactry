---
name: handoff
description: Hand work to another AI tool or a teammate through Artifactry with a written brief, or open a handoff someone left. Use when the user says "hand this off for the deck", "open my Artifactry handoff" or pastes a hof_ id.
---

# Hand off through Artifactry

## Leaving a handoff

1. Save every artifact the next tool needs first (see the `save` skill). A handoff carries up to 20.
2. Write the brief **to the next tool, not to the user**: the goal, what's done, what's left, any constraints, and which artifact to read first.
3. Call `handoff` with the artifacts in reading order, the brief, a short title, and `to` (the tool) if the user named one.
4. Give the user the one-line prompt it returns to paste into the next tool. Everyone in the workspace can see the handoff.

## Opening a handoff

1. Call `get_handoff` with the `hof_…` id or link, or with nothing for the newest open one. Use `list_handoffs` if the user wants to choose.
2. Read the brief and the inlined artifacts, then do the work it asks for.
3. Save what you make. It's linked to the handoff's artifacts as sources automatically.
