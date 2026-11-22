#!/bin/sh
# Sets up your own instance of Trill, from an empty folder:
#
#   mkdir my-online-services && cd my-online-services
#   curl -fsSL https://oss.nekolab.studio/trill/setup.sh | sh
#
# It downloads Trill's newest stable release (TRILL_VERSION=v1.2.3 picks
# another), installs them and runs their setup, which asks a few questions and deploys them to
# your Cloudflare account. You need Node.js 20 or later and git.
set -eu

fail() {
	echo "$1" >&2
	exit 1
}

for tool in node npm git curl tar; do
	command -v "$tool" >/dev/null 2>&1 || fail "$tool is missing. Install Node.js 20 or later (https://nodejs.org) and git, then run this again."
done
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || fail "Node.js 20 or later is needed (this is $(node --version))."
if [ -n "$(ls -A | grep -v -e '^\.git$' -e '^\.DS_Store$' || true)" ]; then
	fail "Run this in an empty folder: the online services' files go straight into it."
fi

# Each Trill release has the service packaged as trill.tar.gz.
if [ -n "${TRILL_VERSION:-}" ]; then
	url="https://github.com/NekoLabStudio/trill/releases/download/$TRILL_VERSION/trill.tar.gz"
else
	url="https://github.com/NekoLabStudio/trill/releases/latest/download/trill.tar.gz"
fi

echo "Downloading Trill..."
curl -fsSL "$url" | tar -xz || fail "Couldn't download Trill from its releases."
[ -f wrangler.jsonc ] || fail "That release has no online services."
mkdir -p .trill-upstream
cp wrangler.jsonc .trill-upstream/wrangler.jsonc

echo "Installing..."
npm install --no-audit --no-fund --silent
node scripts/setup.mjs
