# Artifactry plugin for Claude

The second brain for multi-AI work. This plugin connects Claude to your Artifactry library and teaches it the three jobs:

| Skill | Say | Tools used |
|---|---|---|
| `save` | "Save this to Artifactry." | save, create_version, upload_part, update_tags |
| `find` | "Find last week's launch plan." | search, get |
| `handoff` | "Hand this to Gemini for the deck." | handoff, get_handoff, list_handoffs |

It bundles the remote MCP server `https://app.artifactry.app/api/v1/mcp`. On first use Claude opens Artifactry sign-in (OAuth 2.1, so no API key is needed), and Claude only ever sees what your account can access. Sharing outside your organization always asks you first.

## Install (Claude Code)

```
/plugin marketplace add iankurjain/artifactry
/plugin install artifactry@artifactry
```

Then run `/mcp` and authenticate `artifactry`.

## Install (Claude desktop / Cowork)

Build `dist-plugin/artifactry-plugin.zip` with `scripts/build-plugin.sh` and upload it where your Claude app accepts plugin files.

This plugin folder (skills and manifest) is MIT licensed; the Artifactry service itself is not.

Docs: https://docs.artifactry.app · Support: admin@artifactry.app
