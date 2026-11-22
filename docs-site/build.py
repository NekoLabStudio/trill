#!/usr/bin/env python3
from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path

# The docs are published with GitHub Pages as this repository's project site,
# so every page lives under ROOT on SITE_ORIGIN.
SITE_ORIGIN = "https://oss.nekolab.studio"
ROOT = "/trill"
PRODUCT = "Trill"
REPOSITORY_URL = "https://github.com/NekoLabStudio/trill"
STUDIO_URL = "https://nekolab.studio"
STATIC = Path(__file__).resolve().parent / "static"


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the Trill documentation site.")
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, default=Path("dist/docs-site"))
    args = parser.parse_args()

    repo = args.repo.resolve()
    output = args.output.resolve()
    if output == repo or repo.is_relative_to(output):
        raise SystemExit("Refusing to write the generated site over the repository.")

    reset_output(output)
    copy_static(repo, output)
    build_all_versions(repo, output)
    write_not_found(output)


def build_all_versions(repo: Path, output: Path) -> None:
    """Edge (the working tree) at ROOT, plus one set per released minor series.

    Versions come from the repo's vX.Y.Z tags, newest patch per X.Y series, and a
    series only qualifies if its docs use the current layout. Edge builds from the
    docs directory as it is on disk, so local previews show uncommitted work.
    """
    series = discover_doc_series(repo)
    latest_series = series[0][0] if series else None
    built_series = {label for label, _ in series}
    with tempfile.TemporaryDirectory() as scratch:
        edge_docs = Path(scratch) / "edge" / "docs"
        shutil.copytree(repo / "docs", edge_docs)
        check_nav_covers_docs(edge_docs)
        sources: list[tuple[str, str, Path]] = [("edge", f"{ROOT}/", edge_docs)]
        for label, tag in series:
            extracted = Path(scratch) / label
            extracted.mkdir(parents=True)
            archive = subprocess.run(
                ["git", "-C", str(repo), "archive", tag, "docs"],
                check=True, capture_output=True,
            )
            subprocess.run(["tar", "-x", "-C", str(extracted)], input=archive.stdout, check=True)
            sources.append((label, f"{ROOT}/{label}/", extracted / "docs"))

        all_releases = release_versions(edge_docs / "upgrading")
        products = {version: release_product(edge_docs / "upgrading" / f"{version}.md") for version in all_releases}
        for label, _, docs in sources:
            set_series = latest_series if label == "edge" else label
            synthesise_changelog(docs, set_series, products)
            rewrite_upgrading_index(docs, all_releases, set_series, built_series, ROOT, products)

        versions = [
            DocsVersion(
                label=label,
                display="Edge" if label == "edge" else label,
                base=base,
                slugs={page["slug"] for page in docs_pages(docs)} if docs.exists() else set(),
            )
            for label, base, docs in sources
        ]
        for (label, base, docs), version in zip(sources, versions):
            destination = output if label == "edge" else output / label
            build_docs_set(docs, destination, version, versions)

    write_release_redirects(output, all_releases, latest_series, built_series, ROOT)


def check_nav_covers_docs(docs: Path) -> None:
    """Every current page must be reachable: a page missing from the nav fails the build."""
    listed = {file_name for _, entries in docs_nav_groups() for _, file_name in entries}
    pages = {path.relative_to(docs).as_posix() for path in docs.rglob("*.md")}
    missing = sorted(page for page in pages - listed if not page.startswith("upgrading/"))
    if missing:
        raise SystemExit("Add these pages to docs_nav_groups() in docs-site/build.py: " + ", ".join(missing))


def release_versions(upgrading: Path) -> list[str]:
    """Every released version with an upgrade note, newest first."""
    versions = [
        path.stem
        for path in upgrading.glob("*.md")
        if re.fullmatch(r"\d+\.\d+\.\d+", path.stem)
    ] if upgrading.exists() else []
    return sorted(versions, key=lambda v: tuple(int(part) for part in v.split(".")), reverse=True)


def release_product(note: Path) -> str:
    """The product a release note is titled for ("# Trill 1.0.0")."""
    title = markdown_title(note.read_text()) or ""
    return title.rsplit(" ", 1)[0] if " " in title else PRODUCT


def version_series(version: str) -> str:
    major, minor, _ = version.split(".")
    return f"{major}.{minor}"


def changelog_anchor(version: str) -> str:
    return version.replace(".", "")


def synthesise_changelog(docs: Path, set_series: str | None, products: dict[str, str]) -> None:
    """One generated page per docs set, aggregating that series' upgrade notes."""
    upgrading = docs / "upgrading"
    if set_series is None or not upgrading.exists():
        return
    notes = [v for v in release_versions(upgrading) if version_series(v) == set_series]
    if not notes:
        return
    product = products.get(notes[0], PRODUCT)
    parts = [f"# Changelog\n\nRelease notes for the {product} {set_series} series, newest first.\n"]
    for version in notes:
        parts.append(f"\n## {version}\n")
        parts.append(demote_headings(strip_note_title((upgrading / f"{version}.md").read_text())))
    (upgrading / "changelog.md").write_text("".join(parts))


def strip_note_title(markdown: str) -> str:
    lines = markdown.splitlines()
    for index, line in enumerate(lines):
        if line.startswith("# "):
            return "\n".join(lines[index + 1 :]).lstrip("\n") + "\n"
    return markdown


def demote_headings(markdown: str) -> str:
    output = []
    in_fence = False
    for line in markdown.splitlines():
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
        if not in_fence and re.match(r"^#{1,3}\s", line):
            line = "#" + line
        output.append(line)
    return "\n".join(output) + "\n"


def rewrite_upgrading_index(
    docs: Path,
    all_releases: list[str],
    set_series: str | None,
    built_series: set[str],
    root: str,
    products: dict[str, str],
) -> None:
    """Replace the index's version list with one covering every release, always."""
    index = docs / "upgrading" / "index.md"
    if not index.exists():
        return
    bullets = []
    for version in all_releases:
        series = version_series(version)
        anchor = changelog_anchor(version)
        if series == set_series:
            target = f"changelog.md#{anchor}"
        elif series in built_series:
            target = f"{root}/{series}/upgrading/changelog/#{anchor}"
        else:
            continue
        bullets.append(f"- [{products.get(version, PRODUCT)} {version}]({target})")
    listing = "\n".join(bullets)

    text = index.read_text()
    is_version_bullet = re.compile(r"^- \[[^\]]+\]\((?:\d+\.\d+\.\d+\.md|/upgrading/\d+\.\d+\.\d+/)\)\s*$")
    lines = [line for line in text.splitlines() if not is_version_bullet.match(line)]
    text = "\n".join(lines)
    if "## Versions" in text:
        text = text.replace("## Versions", "## Versions\n\n" + listing, 1)
    else:
        text = text.rstrip() + "\n\n## Versions\n\n" + listing + "\n"
    index.write_text(text)


def write_release_redirects(
    output: Path,
    all_releases: list[str],
    latest_series: str | None,
    built_series: set[str],
    root: str,
) -> None:
    """The one-page-per-version URLs are linked from GitHub releases; keep them alive."""
    for version in all_releases:
        series = version_series(version)
        anchor = changelog_anchor(version)
        if series == latest_series:
            target = f"{root}/upgrading/changelog/#{anchor}"
        elif series in built_series:
            target = f"{root}/{series}/upgrading/changelog/#{anchor}"
        else:
            continue
        write_text(
            output / "upgrading" / version / "index.html",
            f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="refresh" content="0; url={html.escape(target)}">
    <link rel="canonical" href="{SITE_ORIGIN}{html.escape(target)}">
    <title>Moved</title>
  </head>
  <body>
    <p>This page moved to <a href="{html.escape(target)}">the changelog</a>.</p>
  </body>
</html>
""",
        )


class DocsVersion:
    def __init__(self, label: str, display: str, base: str, slugs: set[str]) -> None:
        self.label = label
        self.display = display
        self.base = base
        self.slugs = slugs


def discover_doc_series(repo: Path) -> list[tuple[str, str]]:
    """Newest patch tag per X.Y series, newest series first, docs layout required."""
    listing = subprocess.run(
        ["git", "-C", str(repo), "tag", "--list", "v*"],
        check=True, capture_output=True, text=True,
    )
    newest: dict[tuple[int, int], tuple[int, str]] = {}
    for tag in listing.stdout.split():
        match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", tag)
        if not match:
            continue
        major, minor, patch = (int(part) for part in match.groups())
        if (major, minor) not in newest or newest[(major, minor)][0] < patch:
            newest[(major, minor)] = (patch, tag)
    series = []
    for (major, minor), (_, tag) in sorted(newest.items(), reverse=True):
        probe = subprocess.run(
            ["git", "-C", str(repo), "cat-file", "-e", f"{tag}:docs/start/getting-started.md"],
            capture_output=True,
        )
        if probe.returncode == 0:
            series.append((f"{major}.{minor}", tag))
    return series


def reset_output(output: Path) -> None:
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)


def copy_static(repo: Path, output: Path) -> None:
    """The site's own files (styles, font, studio cat) plus Trill's logo, under /static/."""
    shutil.copytree(STATIC, output / "static")
    for name in ("trill-logo.svg", "trill-wordmark.svg", "trill-wordmark-light.svg"):
        shutil.copy2(repo / "branding" / name, output / "static" / name)
    # The documented setup command is `curl -fsSL <origin>/trill/setup.sh | sh`.
    shutil.copy2(repo / "scripts" / "setup.sh", output / "setup.sh")


def build_docs_set(docs: Path, output: Path, version: DocsVersion, versions: list[DocsVersion]) -> None:
    if not docs.exists():
        raise SystemExit(f"Missing documentation source: {docs}")

    output.mkdir(parents=True, exist_ok=True)
    copy_docs_assets(docs, output)
    pages = docs_pages(docs)
    if not pages:
        raise SystemExit(f"No documentation pages found in {docs}")

    search_entries = [
        write_docs_page(docs, output / page["slug"] / "index.html", pages, page, version, versions)
        for page in pages
    ]
    write_docs_page(docs, output / "index.html", pages, pages[0], version, versions)
    write_text(output / "search-index.json", json.dumps(search_entries, ensure_ascii=False))


def copy_docs_assets(docs: Path, output: Path) -> None:
    assets = docs / "assets"
    if assets.exists():
        shutil.copytree(assets, output / "assets", dirs_exist_ok=True)


def write_docs_page(
    docs: Path,
    destination: Path,
    pages: list[dict[str, str]],
    page: dict[str, str],
    version: DocsVersion,
    versions: list[DocsVersion],
) -> dict[str, object]:
    nav = docs_nav(pages, page["slug"], version.base)
    headings: list[tuple[int, str, str]] = []
    slug_by_source = {(docs / entry["file"]).resolve(): entry["slug"] for entry in pages}
    resolver = docs_link_resolver(docs / page["file"], slug_by_source, version.base.rstrip("/"))
    body = markdown_to_html(
        (docs / page["file"]).read_text(),
        url_prefix=version.base.rstrip("/"),
        url_resolver=resolver,
        toc_out=headings,
    )
    index = pages.index(page)
    previous_page = pages[index - 1] if index > 0 else None
    next_page = pages[index + 1] if index + 1 < len(pages) else None
    write_text(
        destination,
        docs_page_html(
            title=page["title"],
            nav=nav,
            body=body,
            section_label=page["section"],
            toc=docs_toc(headings),
            pager=docs_pager(previous_page, next_page, version.base),
            version_picker=version_picker_html(versions, version, page["slug"]),
            search_index=f"{version.base}search-index.json",
            canonical=canonical_url(versions, version, page["slug"]),
        ),
    )
    return {
        "title": page["title"],
        "section": page["section"],
        "url": docs_href(page["slug"], version.base),
        "parts": search_sections((docs / page["file"]).read_text(), headings),
    }


def version_picker_html(versions: list[DocsVersion], current: DocsVersion, slug: str) -> str:
    options = []
    for version in versions:
        href = docs_href(slug, version.base) if slug in version.slugs else version.base
        selected = " selected" if version.label == current.label else ""
        options.append(f'<option value="{html.escape(href)}"{selected}>{html.escape(version.display)}</option>')
    return (
        '<div class="docs-version-picker">'
        '<select aria-label="Documentation version">' + "".join(options) + "</select></div>"
    )


def canonical_url(versions: list[DocsVersion], current: DocsVersion, slug: str) -> str:
    """Old-version pages point search engines at their Edge equivalent."""
    if current.label == "edge":
        return ""
    edge = versions[0]
    if slug not in edge.slugs:
        return ""
    return SITE_ORIGIN + docs_href(slug, edge.base)


def docs_href(slug: str, base: str) -> str:
    return base if slug == "index" else f"{base}{slug}/"


def docs_toc(headings: list[tuple[int, str, str]]) -> str:
    if len(headings) < 2:
        return ""
    links = "".join(
        f'<a class="toc-h{level}" href="#{html.escape(slug)}">{inline_markup(text)}</a>'
        for level, text, slug in headings
    )
    return f'<aside class="docs-toc" aria-label="On this page"><p>On this page</p>{links}</aside>'


def docs_pager(previous_page: dict[str, str] | None, next_page: dict[str, str] | None, base: str) -> str:
    if previous_page is None and next_page is None:
        return ""
    parts = ['<nav class="docs-pager" aria-label="Pages">']
    if previous_page is not None:
        parts.append(
            f'<a class="pager-previous" href="{html.escape(docs_href(previous_page["slug"], base))}">'
            f'<span>Previous</span><strong>{html.escape(previous_page["title"])}</strong></a>'
        )
    else:
        parts.append("<span></span>")
    if next_page is not None:
        parts.append(
            f'<a class="pager-next" href="{html.escape(docs_href(next_page["slug"], base))}">'
            f'<span>Next</span><strong>{html.escape(next_page["title"])}</strong></a>'
        )
    parts.append("</nav>")
    return "".join(parts)


def docs_pages(docs: Path) -> list[dict[str, str]]:
    pages: list[dict[str, str]] = []
    for section, entries in docs_nav_groups_with_upgrading(docs):
        for slug, file_name in entries:
            source = docs / file_name
            if source.exists():
                pages.append(
                    {
                        "slug": slug,
                        "file": file_name,
                        "title": markdown_title(source.read_text()) or titleize(slug),
                        "section": section,
                    }
                )
    return pages


def docs_nav_groups() -> list[tuple[str, list[tuple[str, str]]]]:
    return [
        (
            "Start",
            [
                ("index", "index.md"),
                ("getting-started", "getting-started.md"),
                ("connecting", "connecting.md"),
            ],
        ),
        (
            "Running an instance",
            [
                ("settings", "settings.md"),
                ("updating", "updating.md"),
                ("email", "email.md"),
                ("secrets", "secrets.md"),
                ("manual-setup", "manual-setup.md"),
            ],
        ),
        (
            "Features",
            [
                ("turn", "turn.md"),
                ("ownership", "ownership.md"),
                ("moderation", "moderation.md"),
                ("crash-reports", "crash-reports.md"),
            ],
        ),
        (
            "Reference",
            [
                ("protocol", "protocol.md"),
                ("privacy", "privacy.md"),
            ],
        ),
    ]


def docs_nav_groups_with_upgrading(docs: Path) -> list[tuple[str, list[tuple[str, str]]]]:
    """The curated nav plus the Upgrading section.

    The section holds the index (whose release list the build regenerates to
    cover every version across every docs set) and the generated Changelog
    page for this set's series, so the sidebar stays two entries no matter how
    many releases exist. next.md (unreleased working notes) deliberately never
    builds — the site documents what people can install.
    """
    groups = docs_nav_groups()
    upgrading = docs / "upgrading"
    if not upgrading.exists():
        return groups

    entries: list[tuple[str, str]] = []
    if (upgrading / "index.md").exists():
        entries.append(("upgrading", "upgrading/index.md"))
    if (upgrading / "changelog.md").exists():
        entries.append(("upgrading/changelog", "upgrading/changelog.md"))
    if entries:
        groups.append(("Upgrading", entries))
    return groups


def docs_nav(pages: list[dict[str, str]], current_slug: str, base: str) -> str:
    # Grouped from the pages themselves (which already carry their section, in
    # nav order) so discovered sections like Upgrading render like curated ones.
    sections: list[str] = []
    by_section: dict[str, list[dict[str, str]]] = {}
    for page in pages:
        section = page["section"]
        if section not in by_section:
            sections.append(section)
            by_section[section] = []
        by_section[section].append(page)
    html_groups: list[str] = []
    for title in sections:
        links = [
            docs_nav_link(docs_href(page["slug"], base), page["title"], page["slug"] == current_slug)
            for page in by_section[title]
        ]
        html_groups.append(f'<div class="nav-group"><p>{html.escape(title)}</p>{"".join(links)}</div>')
    return '<nav class="docs-nav" id="docs-nav" aria-label="Trill documentation">' + "".join(html_groups) + "</nav>"


def docs_link_resolver(source: Path, slug_by_source: dict[Path, str], url_prefix: str) -> Callable[[str], str]:
    def resolve(value: str) -> str:
        target, separator, fragment = value.partition("#")
        if not target.endswith(".md"):
            return value

        source_path = (source.parent / target).resolve()
        slug = slug_by_source.get(source_path)
        if not slug:
            return value

        href = f"{url_prefix}/" if slug == "index" else f"{url_prefix}/{slug}/"
        return href + (separator + fragment if separator else "")

    return resolve


def docs_nav_link(href: str, title: str, is_current: bool) -> str:
    current = ' aria-current="page"' if is_current else ""
    return f'<a href="{html.escape(href)}"{current}>{html.escape(title)}</a>'


def docs_page_html(
    title: str,
    nav: str,
    body: str,
    section_label: str,
    toc: str = "",
    pager: str = "",
    version_picker: str = "",
    search_index: str = "",
    canonical: str = "",
) -> str:
    canonical_html = f'\n    <link rel="canonical" href="{html.escape(canonical)}">' if canonical else ""
    search_html = (
        f'<div class="docs-search" data-index="{html.escape(search_index)}">'
        '<input type="search" placeholder="Search docs" aria-label="Search documentation">'
        '</div>\n        <div class="docs-search-results" hidden></div>'
    ) if search_index else ""
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{html.escape(title)} | Trill</title>
{site_head()}{canonical_html}
  </head>
  <body>
    <header class="docs-topbar">
      {brand_html()}
      {version_picker}
      <nav class="docs-top-nav" aria-label="Primary">
        <a href="{REPOSITORY_URL}" target="_blank" rel="noopener">GitHub ↗</a>
      </nav>
    </header>
    <div class="docs-shell">
      <aside class="docs-sidebar">
        <button class="mobile-nav-toggle" type="button" aria-controls="docs-nav" aria-expanded="false">Menu</button>
        {search_html}
        {nav}
      </aside>
      <main class="docs-main">
        <article class="docs-content" data-section="{html.escape(section_label)}">
          {body}
        </article>
        {pager}
        {made_by_html()}
      </main>
      {toc}
    </div>
    <script>
      const toggle = document.querySelector(".mobile-nav-toggle");
      const nav = document.querySelector(".docs-nav");
      const searchBox = document.querySelector(".docs-search");
      const searchInput = document.querySelector(".docs-search input");
      const searchResults = document.querySelector(".docs-search-results");
      let searching = false;
      const syncNav = function() {{
        if (!toggle || !nav) return;
        const compact = window.matchMedia("(max-width: 840px)").matches;
        const menuOpen = !compact || toggle.getAttribute("aria-expanded") === "true";
        if (searchBox) searchBox.hidden = !menuOpen;
        if (searchResults) searchResults.hidden = !menuOpen || !searching;
        nav.hidden = !menuOpen || searching;
      }};
      toggle?.addEventListener("click", function() {{
        toggle.setAttribute("aria-expanded", toggle.getAttribute("aria-expanded") === "true" ? "false" : "true");
        syncNav();
      }});
      window.addEventListener("resize", syncNav);
      syncNav();

      document.querySelectorAll(".docs-version-picker select").forEach(function(select) {{
        select.addEventListener("change", function() {{
          window.location.href = select.value;
        }});
      }});

      if (searchInput && searchResults) {{
        let indexPromise = null;
        const loadIndex = function() {{
          indexPromise = indexPromise || fetch(searchBox.dataset.index).then((r) => r.json()).catch(() => []);
          return indexPromise;
        }};
        const escapeHtml = function(text) {{
          return text.replace(/[&<>"]/g, (c) => ({{"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}}[c]));
        }};
        const snippet = function(text, at, length) {{
          const start = Math.max(0, at - 40);
          const end = Math.min(text.length, at + length + 70);
          return (start > 0 ? "…" : "") + escapeHtml(text.slice(start, at)) +
            "<mark>" + escapeHtml(text.slice(at, at + length)) + "</mark>" +
            escapeHtml(text.slice(at + length, end)) + (end < text.length ? "…" : "");
        }};
        const render = function(pages) {{
          const query = searchInput.value.trim().toLowerCase();
          searching = query.length >= 2;
          if (searching) {{
            const items = [];
            for (const page of pages) {{
              const inTitle = page.title.toLowerCase().includes(query);
              let best = null;
              for (const part of page.parts) {{
                const inHeading = part.heading.toLowerCase().includes(query);
                const at = part.text.toLowerCase().indexOf(query);
                if (!inHeading && at === -1) continue;
                const score = (inTitle ? 4 : 0) + (inHeading ? 2 : 0) + (at !== -1 ? 1 : 0);
                if (!best || score > best.score) best = {{ part: part, score: score, at: at }};
              }}
              if (!best && inTitle) best = {{ part: null, score: 4, at: -1 }};
              if (best) items.push({{ page: page, part: best.part, score: best.score, at: best.at }});
            }}
            items.sort((a, b) => b.score - a.score);
            searchResults.innerHTML = items.slice(0, 12).map(function(item) {{
              const anchor = item.part && item.part.anchor ? "#" + item.part.anchor : "";
              const heading = item.part && item.part.heading ? "<span>" + escapeHtml(item.part.heading) + "</span>" : "";
              const excerpt = item.at !== -1 ? "<p>" + snippet(item.part.text, item.at, query.length) + "</p>" : "";
              return '<a href="' + escapeHtml(item.page.url + anchor) + '"><strong>' + escapeHtml(item.page.title) + "</strong>" + heading + excerpt + "</a>";
            }}).join("") || '<p class="search-empty">No matches.</p>';
          }}
          syncNav();
        }};
        searchInput.addEventListener("focus", loadIndex);
        searchInput.addEventListener("input", function() {{
          loadIndex().then(render);
        }});
        searchInput.addEventListener("keydown", function(event) {{
          if (event.key === "Escape") {{
            searchInput.value = "";
            searching = false;
            syncNav();
          }} else if (event.key === "Enter") {{
            const first = searchResults.querySelector("a");
            if (first) window.location.href = first.href;
          }}
        }});
      }}

      const tocLinks = Array.from(document.querySelectorAll(".docs-toc a"));
      if (tocLinks.length) {{
        const linkFor = new Map(tocLinks.map((link) => [link.getAttribute("href").slice(1), link]));
        const headings = Array.from(document.querySelectorAll(".docs-content h2[id], .docs-content h3[id]"))
          .filter((heading) => linkFor.has(heading.id));
        const setCurrent = function(id) {{
          tocLinks.forEach((link) => link.removeAttribute("aria-current"));
          const link = linkFor.get(id);
          if (link) link.setAttribute("aria-current", "true");
        }};
        const update = function() {{
          let current = headings[0];
          for (const heading of headings) {{
            if (heading.getBoundingClientRect().top <= 120) current = heading;
          }}
          if (current) setCurrent(current.id);
        }};
        window.addEventListener("scroll", update, {{ passive: true }});
        window.addEventListener("resize", update);
        update();
      }}
    </script>
  </body>
</html>
"""


def site_head() -> str:
    """Styles, icons and theme colours shared by every page."""
    return f"""    <meta name="theme-color" content="#f5f1e6" media="(prefers-color-scheme: light)">
    <meta name="theme-color" content="#17161b" media="(prefers-color-scheme: dark)">
    <link rel="stylesheet" href="{ROOT}/static/styles.css?v=2">
    <link rel="icon" href="{ROOT}/static/trill-logo.svg" type="image/svg+xml">"""


def brand_html() -> str:
    return f"""<a class="docs-top-brand" href="{ROOT}/">
        <picture class="brand-logo">
          <img src="{ROOT}/static/trill-logo.svg" alt="" width="36" height="36">
        </picture>
        <picture class="brand-wordmark">
          <source srcset="{ROOT}/static/trill-wordmark-light.svg" media="(prefers-color-scheme: dark)">
          <img src="{ROOT}/static/trill-wordmark.svg" alt="Trill" width="52" height="26">
        </picture>
      </a>"""


def made_by_html() -> str:
    """The studio's sign-off, as on nekolab.studio's product pages."""
    return f"""<p class="made-by">
          <img src="{ROOT}/static/nekolab-cat.svg" alt="" width="40" height="46">
          <span>Trill is a NekoLab project. <a href="{STUDIO_URL}">See everything we make</a></span>
        </p>"""


def write_not_found(output: Path) -> None:
    write_text(
        output / "404.html",
        f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Not found | Trill</title>
{site_head()}
  </head>
  <body>
    <header class="docs-topbar">
      {brand_html()}
    </header>
    <main class="not-found">
      <h1>Not found</h1>
      <p>This page doesn't exist. Try the <a href="{ROOT}/">Trill documentation</a> instead.</p>
      {made_by_html()}
    </main>
  </body>
</html>
""",
    )


def markdown_title(markdown: str) -> str | None:
    for line in markdown.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return None


def strip_html_comments(markdown: str) -> str:
    """Remove <!-- --> comments outside fenced code blocks."""
    output: list[str] = []
    in_fence = False
    in_comment = False
    for line in markdown.splitlines():
        if not in_comment and line.lstrip().startswith("```"):
            in_fence = not in_fence
            output.append(line)
            continue
        if in_fence:
            output.append(line)
            continue
        while line:
            if in_comment:
                end = line.find("-->")
                if end == -1:
                    line = ""
                    break
                line = line[end + 3 :]
                in_comment = False
            else:
                start = line.find("<!--")
                if start == -1:
                    break
                end = line.find("-->", start + 4)
                if end == -1:
                    line = line[:start]
                    in_comment = True
                else:
                    line = line[:start] + line[end + 3 :]
        if line.strip() or not in_comment:
            output.append(line)
    return "\n".join(output)


def heading_slug(text: str, used: set[str]) -> str:
    """GitHub-style anchor slug: lowercase, punctuation stripped, spaces to hyphens."""
    plain = re.sub(r"[`*_]", "", text)
    plain = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", plain)
    slug = re.sub(r"[^\w\- ]", "", plain.strip().lower(), flags=re.UNICODE)
    slug = slug.replace(" ", "-")
    candidate = slug
    counter = 1
    while candidate in used:
        candidate = f"{slug}-{counter}"
        counter += 1
    used.add(candidate)
    return candidate


def search_plain(text: str) -> str:
    """One markdown line reduced to plain text for the search index."""
    text = re.sub(r"^#{1,6}\s+", "", text)
    text = re.sub(r"^>\s?", "", text)
    text = re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"(?<!\w)_([^_]+)_(?!\w)", r"\1", text)  # emphasis only; keep snake_case intact
    text = re.sub(r"[`*]", "", text)
    return re.sub(r"\s+", " ", text).strip()


def search_sections(markdown: str, headings: list[tuple[int, str, str]]) -> list[dict[str, str]]:
    """Split a page into plain-text chunks per h2/h3, anchors matching the rendered page.

    Walks the source the same way markdown_to_html does (fences, heading levels)
    and pairs each h2/h3 with the anchor the renderer gave it via toc_out.
    """
    remaining = list(headings)
    parts: list[dict[str, str]] = [{"heading": "", "anchor": "", "text": ""}]
    chunks: list[list[str]] = [[]]
    in_code = False
    for raw_line in strip_html_comments(markdown).splitlines():
        line = raw_line.rstrip()
        if line.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            if line.strip():
                chunks[-1].append(line.strip())
            continue
        if line.startswith("# "):
            continue
        if re.match(r"^#{2,3}\s+.+$", line) and remaining:
            _, text, anchor = remaining.pop(0)
            parts.append({"heading": search_plain(text), "anchor": anchor, "text": ""})
            chunks.append([])
            continue
        cleaned = search_plain(line)
        if cleaned:
            chunks[-1].append(cleaned)
    for part, chunk in zip(parts, chunks):
        part["text"] = " ".join(chunk)
    return [part for part in parts if part["heading"] or part["text"]]


def markdown_to_html(
    markdown: str,
    url_prefix: str = "",
    url_resolver: Callable[[str], str] | None = None,
    toc_out: list[tuple[int, str, str]] | None = None,
) -> str:
    lines = strip_html_comments(markdown).splitlines()
    used_slugs: set[str] = set()
    output: list[str] = []
    paragraph: list[str] = []
    list_open: str | None = None
    list_item: list[str] = []
    code_open = False
    code_language = ""
    code_lines: list[str] = []
    quote: list[str] = []
    table_rows: list[str] = []

    def table_cells(row: str) -> list[str]:
        # Escaped \| must not split; restore the literal pipe afterwards.
        placeholder = "\x00PIPE\x00"
        prepared = row.strip().strip("|").replace("\\|", placeholder)
        return [cell.strip().replace(placeholder, "|") for cell in prepared.split("|")]

    def flush_table() -> None:
        nonlocal table_rows
        if not table_rows:
            return
        rows = table_rows
        table_rows = []
        if len(rows) < 2 or not re.match(r"^[\s|:-]+$", rows[1]):
            # Not a real table (no separator row): fall back to paragraph text.
            for row in rows:
                paragraph.append(row)
            flush_paragraph()
            return
        header = table_cells(rows[0])
        body = [table_cells(row) for row in rows[2:]]
        parts = ['<div class="table-wrap"><table>', "<thead><tr>"]
        for cell in header:
            parts.append(f"<th>{inline_markup(cell, url_prefix, url_resolver)}</th>")
        parts.append("</tr></thead><tbody>")
        for row in body:
            parts.append("<tr>")
            for cell in row:
                parts.append(f"<td>{inline_markup(cell, url_prefix, url_resolver)}</td>")
            parts.append("</tr>")
        parts.append("</tbody></table></div>")
        output.append("".join(parts))

    def flush_paragraph() -> None:
        nonlocal paragraph
        if paragraph:
            output.append(f"<p>{inline_markup(' '.join(paragraph), url_prefix, url_resolver)}</p>")
            paragraph = []

    def flush_list_item() -> None:
        nonlocal list_item
        if list_item:
            output.append(f"<li>{inline_markup(' '.join(list_item), url_prefix, url_resolver)}</li>")
            list_item = []

    def close_list() -> None:
        nonlocal list_open
        flush_list_item()
        if list_open:
            output.append(f"</{list_open}>")
            list_open = None

    def flush_quote() -> None:
        nonlocal quote
        if not quote:
            return
        text = " ".join(quote)
        quote = []
        body = inline_markup(text, url_prefix, url_resolver)
        callout = re.match(r"\*\*(Note|Tip|Warning):\*\*", text)
        if callout:
            kind = callout.group(1).lower()
            output.append(f'<div class="callout callout-{kind}"><p>{body}</p></div>')
        else:
            output.append(f"<blockquote><p>{body}</p></blockquote>")

    def close_code() -> None:
        nonlocal code_open, code_lines, code_language
        if code_open:
            output.append(code_block("\n".join(code_lines), code_language))
            code_open = False
            code_language = ""
            code_lines = []

    for raw_line in lines:
        line = raw_line.rstrip()
        if code_open:
            if line.startswith("```"):
                close_code()
            else:
                code_lines.append(raw_line)
            continue
        if line.startswith("```"):
            flush_paragraph()
            close_list()
            flush_quote()
            code_open = True
            code_language = line[3:].strip()
            code_lines = []
            continue
        if line.lstrip().startswith("|"):
            flush_paragraph()
            close_list()
            flush_quote()
            table_rows.append(line)
            continue
        flush_table()
        if not line.strip():
            flush_paragraph()
            close_list()
            flush_quote()
            continue
        heading = re.match(r"^(#{1,4})\s+(.+)$", line)
        if heading:
            flush_paragraph()
            close_list()
            flush_quote()
            level = len(heading.group(1))
            text = heading.group(2).strip()
            slug = heading_slug(text, used_slugs)
            if toc_out is not None and level in (2, 3):
                toc_out.append((level, text, slug))
            output.append(
                f'<h{level} id="{html.escape(slug)}">{inline_markup(text, url_prefix, url_resolver)}</h{level}>'
            )
            continue
        image = re.match(r"^!\[([^\]]*)\]\(([^)]+)\)$", line.strip())
        if image:
            flush_paragraph()
            close_list()
            flush_quote()
            output.append(
                f'<img src="{html.escape(rewrite_markdown_url(image.group(2), url_prefix, url_resolver))}" alt="{html.escape(image.group(1))}">'
            )
            continue
        if line.startswith(">"):
            flush_paragraph()
            close_list()
            quote.append(line[1:].strip())
            continue
        if line.startswith("- "):
            flush_paragraph()
            flush_quote()
            if list_open != "ul":
                close_list()
                output.append("<ul>")
                list_open = "ul"
            else:
                flush_list_item()
            list_item = [line[2:].strip()]
            continue
        ordered_item = re.match(r"^\d+[.)]\s+(.+)$", line)
        if ordered_item:
            flush_paragraph()
            flush_quote()
            if list_open != "ol":
                close_list()
                output.append("<ol>")
                list_open = "ol"
            else:
                flush_list_item()
            list_item = [ordered_item.group(1).strip()]
            continue
        # Lazy continuation: an unmarked line extends the open quote or list item.
        if quote:
            quote.append(line.strip())
            continue
        if list_item:
            list_item.append(line.strip())
            continue
        paragraph.append(line.strip())

    flush_table()
    flush_paragraph()
    close_list()
    flush_quote()
    close_code()
    return "\n".join(output)


def inline_markup(text: str, url_prefix: str = "", url_resolver: Callable[[str], str] | None = None) -> str:
    escaped = html.escape(text)
    escaped = re.sub(r"`([^`]+)`", r"<code>\1</code>", escaped)
    escaped = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", escaped)

    def replace_link(match: re.Match[str]) -> str:
        href = rewrite_markdown_url(html.unescape(match.group(2)), url_prefix, url_resolver)
        attrs = ' target="_blank" rel="noopener noreferrer"' if href.startswith(("http://", "https://")) else ""
        return f'<a href="{html.escape(href)}"{attrs}>{match.group(1)}</a>'

    escaped = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", replace_link, escaped)
    return escaped


def rewrite_markdown_url(value: str, url_prefix: str = "", url_resolver: Callable[[str], str] | None = None) -> str:
    if url_resolver:
        resolved = url_resolver(value)
        if resolved != value:
            return resolved
    if not url_prefix or not value.startswith("/") or value.startswith("//"):
        return value
    return value if value.startswith(f"{url_prefix}/") else f"{url_prefix}{value}"


def code_block(code: str, language: str) -> str:
    language = language.strip() or "text"
    if language in {"bash", "sh", "shell", "terminal", "zsh"}:
        lines = "".join(
            f'<span class="terminal-line"><span class="terminal-prompt">$</span><span>{html.escape(line)}</span></span>'
            for line in code.split("\n")
        )
        return (
            f'<figure class="code-block terminal-block" data-language="{html.escape(language)}">'
            '<figcaption><span class="window-dots"><span></span><span></span><span></span></span><span>Terminal</span></figcaption>'
            f"<pre><code>{lines}</code></pre></figure>"
        )

    return (
        f'<figure class="code-block source-block" data-language="{html.escape(language)}">'
        f"<figcaption><span>{html.escape(language.upper())}</span></figcaption>"
        f'<pre><code class="language-{html.escape(language)}">{highlight_code(code, language)}</code></pre></figure>'
    )


def highlight_code(code: str, language: str) -> str:
    language = language.lower()
    escaped = html.escape(code)
    if language in {"gdscript", "gd"}:
        return highlight_gdscript(escaped)
    if language in {"json", "jsonc", "yaml", "yml", "ts", "typescript"}:
        return highlight_basic_code(escaped)
    return escaped


def highlight_basic_code(source: str) -> str:
    highlighter = CodeHighlighter(source)
    highlighter.apply(r"(&quot;[^\n]*?&quot;|'[^']*')", "syntax-string")
    highlighter.apply(r"\b(true|false|null|let|var|func|import|return|try)\b", "syntax-keyword")
    highlighter.apply(r"(?<![\w-])-?\d+(?:\.\d+)?(?![\w-])", "syntax-number")
    return highlighter.render()


def highlight_gdscript(source: str) -> str:
    highlighter = CodeHighlighter(source)
    highlighter.apply(r"(&quot;[^\n]*?&quot;|'[^'\n]*')", "syntax-string")
    highlighter.apply(r"(?m)#.*$", "syntax-comment")
    highlighter.apply(
        r"\b(func|var|const|if|elif|else|for|while|in|return|await|extends|class_name|signal|match|and|or|not|true|false|null|self)\b",
        "syntax-keyword",
    )
    highlighter.apply(r"(?<![\w-])-?\d+(?:\.\d+)?(?![\w-])", "syntax-number")
    return highlighter.render()


class CodeHighlighter:
    def __init__(self, source: str) -> None:
        self.source = source
        self.placeholders: list[str] = []

    def apply(self, pattern: str, class_name: str) -> None:
        def replace(match: re.Match[str]) -> str:
            self.placeholders.append(f'<span class="{class_name}">{match.group(0)}</span>')
            return chr(0xE000 + len(self.placeholders) - 1)

        self.source = re.sub(pattern, replace, self.source)

    def render(self) -> str:
        output = self.source
        for index, value in enumerate(self.placeholders):
            output = output.replace(chr(0xE000 + index), value)
        return output


def titleize(slug: str) -> str:
    return slug.replace("-", " ").title()


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


if __name__ == "__main__":
    main()
