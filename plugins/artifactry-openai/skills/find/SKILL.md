---
name: find
description: Find and open past work in the user's Artifactry library by topic, type, tag, collection, project, owner, date or the AI tool that made it. Use when the user says "find last week's launch plan", "what do we have on pricing" or wants to build from saved material.
---

# Find in Artifactry

1. **Search first.** Call `search` with a natural-language query. Add filters only when the user gives them: `type` (pptx, pdf, md…), `tags`, `collection`, `project`, `workspace`, `owner`, `made_by`, and created or updated dates (turn "last week" into ISO dates).
2. **Show a short list**: title, type, who or which tool made it, when it was updated, and the link. Don't dump excerpts.
3. **Open the right one** with `get` before you use its contents. Text and code files come back whole, and other formats return extracted text.
4. **Build on it.** When you then save something made from it, the source is linked automatically.

Only artifacts the user can access are returned. If nothing matches, say so and suggest a broader query, and never invent results.
