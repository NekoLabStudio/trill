#!/usr/bin/env bash
#
# prepare-release.sh <version>
#
# Makes every file change a release needs, in one pass:
#   - VERSION.txt -> <version>, and the service's SERVICE_VERSION (src/version.ts)
#   - docs/upgrading/next.md -> docs/upgrading/<version>.md (retitled "# Trill <version>",
#     the unreleased intro dropped), a fresh next.md, and the version listed in
#     docs/upgrading/index.md. A next.md still at "Nothing yet." becomes a short page
#     saying the release needs nothing from instances.
#
# No git operations: the Prepare release workflow commits, tags and pushes around it, and
# anyone running it locally stays in charge of their own git.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-}"
if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
	echo "usage: support/prepare-release.sh <MAJOR.MINOR.PATCH>" >&2
	exit 1
fi

# 1. The version (the Release workflow refuses a tag that doesn't match it). The first
#    release's version is already there, so an unchanged version is fine.
echo "$VERSION" > VERSION.txt
sed -i.bak "s/^export const SERVICE_VERSION = \".*\";$/export const SERVICE_VERSION = \"$VERSION\";/" src/version.ts
rm src/version.ts.bak
grep -q "SERVICE_VERSION = \"$VERSION\"" src/version.ts

# 2. The upgrade notes.
NEXT="docs/upgrading/next.md"
PAGE="docs/upgrading/$VERSION.md"
if [ ! -f "$NEXT" ]; then
	echo "$NEXT is missing" >&2
	exit 1
fi
if [ -f "$PAGE" ]; then
	echo "$PAGE already exists" >&2
	exit 1
fi

BODY="$(sed -e '1d' -e '/<!-- unreleased-intro-start/,/<!-- unreleased-intro-end -->/d' "$NEXT" | grep -v '^$' || true)"
if [ "$BODY" = "Nothing yet." ]; then
	cat > "$PAGE" <<ALLCLEAR
# Trill $VERSION

Nothing needs changing in your instance: run `npm run update`.
ALLCLEAR
else
	sed -e "1s/^# Unreleased$/# Trill $VERSION/" \
		-e '/<!-- unreleased-intro-start/,/<!-- unreleased-intro-end -->/d' \
		"$NEXT" > "$PAGE"
fi
grep -q "^# Trill $VERSION$" "$PAGE"

cat > "$NEXT" <<'TEMPLATE'
# Unreleased

<!-- unreleased-intro-start (support/prepare-release.sh drops this block at release) -->
The notes for the next release: everything below is in `main` and ships
together when the version is tagged.
<!-- unreleased-intro-end -->

Nothing yet.
TEMPLATE

# The version list on the upgrading page, newest first (the docs site rebuilds it too).
sed -i.bak "/<!-- newest-first/a\\
- [Trill $VERSION](/upgrading/$VERSION/)
" docs/upgrading/index.md
rm docs/upgrading/index.md.bak
grep -q "(/upgrading/$VERSION/)" docs/upgrading/index.md

echo "Prepared release $VERSION: VERSION.txt, src/version.ts, $PAGE (from next.md, a fresh next.md started), docs/upgrading/index.md"
