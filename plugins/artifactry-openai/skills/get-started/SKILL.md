---
name: get-started
description: Set up and explain Artifactry the first time the user uses it. Use when the user asks what Artifactry can do, how to connect it, or says "get started with Artifactry".
---

# Get started with Artifactry

Artifactry is the user's library for work made with AI tools. It has three jobs: save work, find it again, and hand it to the next AI tool.

1. **Connect.** The first Artifactry call opens Artifactry sign-in (OAuth). If the user has no account, they can create one at https://app.artifactry.app/signup. No API key is needed.
2. **Check where work goes.** Call `list_workspaces`. If the user has more than one workspace, tell them which ones exist so they can name one when saving.
3. **Show the three jobs** in one short list, with an example prompt for each:
   - Save: "Save this to my Artifactry library."
   - Find: "Find last week's launch plan in Artifactry."
   - Hand off: "Hand this work off in Artifactry with a brief for the next AI tool."
4. **Offer a first save.** If there is work in the conversation, offer to save it (see the `save` skill).

Only what the user's Artifactry account can access is ever returned, and sharing outside their organization always asks them first. Help is at https://docs.artifactry.app.
