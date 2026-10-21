#!/usr/bin/env bash
# Package plugins/artifactry-openai for the OpenAI plugin directory (ChatGPT + Codex):
#   dist-plugin/artifactry-openai-plugin.zip        portable Agent Plugins layout (upload this)
#   dist-plugin/artifactry-openai-plugin-codex.zip  Codex layout, if the portal rejects the first
# Both are checked by scripts/validate-openai-plugin.py.
set -euo pipefail
cd "$(dirname "$0")/.."
src=plugins/artifactry-openai
out=dist-plugin
mkdir -p "$out"
rm -f "$out/artifactry-openai-plugin.zip" "$out/artifactry-openai-plugin-codex.zip"

(cd "$src" && zip -qrX "../../$out/artifactry-openai-plugin.zip" . -x '.DS_Store' '*/.DS_Store')

# Codex layout: .codex-plugin/plugin.json with interface at the root, .mcp.json with only the URL.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp -R "$src"/. "$tmp"/
rm "$tmp/plugin.json" "$tmp/mcp.json"
mkdir "$tmp/.codex-plugin"
python3 - "$src" "$tmp" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
m = json.load(open(f'{src}/plugin.json'))
m.pop('$schema')
ext = m.pop('extensions')['com.openai']
m['skills'] = './skills/'
m['mcpServers'] = './.mcp.json'
m['interface'] = ext.pop('interface')
m['extensions'] = {'com.openai': ext}
json.dump(m, open(f'{dst}/.codex-plugin/plugin.json', 'w'), indent=2, ensure_ascii=False)
servers = json.load(open(f'{src}/mcp.json'))['mcpServers']
json.dump({'mcpServers': {k: {'url': v['url']} for k, v in servers.items()}},
          open(f'{dst}/.mcp.json', 'w'), indent=2)
PY
(cd "$tmp" && zip -qrX "$OLDPWD/$out/artifactry-openai-plugin-codex.zip" . -x '.DS_Store' '*/.DS_Store')

for z in "$out/artifactry-openai-plugin.zip" "$out/artifactry-openai-plugin-codex.zip"; do
  echo "== $z"
  python3 scripts/validate-openai-plugin.py "$z"
done
