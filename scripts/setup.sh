#!/bin/sh
# Sets up your own instance of Purr's online services, from an empty folder:
#
#   mkdir my-online-services && cd my-online-services
#   curl -fsSL https://oss.nekolab.studio/purr/online/setup.sh | sh
#
# It downloads the online services from Purr's newest stable release (PURR_VERSION=v1.2.3 picks
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

# Each Purr release has the online services on their own, as purr-online.tar.gz.
if [ -n "${PURR_VERSION:-}" ]; then
	url="https://github.com/NekoLabStudio/purr/releases/download/$PURR_VERSION/purr-online.tar.gz"
else
	url="https://github.com/NekoLabStudio/purr/releases/latest/download/purr-online.tar.gz"
fi

echo "Downloading Purr's online services..."
curl -fsSL "$url" | tar -xz || fail "Couldn't download the online services from Purr's releases."
[ -f wrangler.jsonc ] || fail "That release has no online services."
mkdir -p .purr-upstream
cp wrangler.jsonc .purr-upstream/wrangler.jsonc

echo "Installing..."
npm install --no-audit --no-fund --silent
node scripts/setup.mjs
