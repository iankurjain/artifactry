#!/usr/bin/env bash
# Package plugins/artifactry as an uploadable zip: dist-plugin/artifactry-plugin.zip
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist-plugin
rm -f dist-plugin/artifactry-plugin.zip
(cd plugins/artifactry && zip -qr ../../dist-plugin/artifactry-plugin.zip . -x '.DS_Store')
echo "dist-plugin/artifactry-plugin.zip"
