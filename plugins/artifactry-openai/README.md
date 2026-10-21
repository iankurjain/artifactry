# Artifactry plugin for ChatGPT and Codex

The second brain for multi-AI work. This plugin connects ChatGPT and Codex to your Artifactry library and teaches them the three jobs:

| Skill | Say | Tools used |
|---|---|---|
| `get-started` | "Get started with Artifactry." | list_workspaces |
| `save` | "Save this to my Artifactry library." | save, create_version, upload_part, update_tags |
| `find` | "Find last week's launch plan in Artifactry." | search, get |
| `handoff` | "Hand this work off in Artifactry with a brief for the next AI tool." | handoff, get_handoff, list_handoffs |

It bundles the remote MCP server `https://app.artifactry.app/api/v1/mcp` (streamable HTTP, OAuth 2.1). The AI only ever sees what your Artifactry account can access, and sharing outside your organization always asks you first.

Build the directory upload with `scripts/build-openai-plugin.sh`, which validates the package against OpenAI's published submission rules and writes `dist-plugin/artifactry-openai-plugin.zip` (portable Agent Plugins layout) and `dist-plugin/artifactry-openai-plugin-codex.zip` (Codex layout, a fallback).

This plugin folder (skills and manifest) is MIT licensed; the Artifactry service itself is not.

Docs: https://docs.artifactry.app · Support: admin@artifactry.app
