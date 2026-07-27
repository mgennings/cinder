#!/usr/bin/env python3
"""Render a field note to styled HTML, ready for Chrome's print-to-PDF.

Deliberately dependency-free. A field note is a durable artifact and its
renderer should still run in five years without an install step, so this
handles only the Markdown this house style actually uses: headings, bold,
italic, inline code, rules, `Key:` metadata rows, and a closing italic coda.

Usage:
    python3 docs/field-notes/render.py 001-the-vote-to-stay-blind.md
"""

import html
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).parent
BUILD = HERE / "build"

# Cinder's own palette, not a generic dark theme. Warm near-blacks and one
# ember accent — the same tokens src/app.css ships, so the PDF and the product
# read as one thing.
TEMPLATE = """<!doctype html><html><head><meta charset="utf-8"><title>__TITLE__</title><style>
@page { size: letter; margin: 0; }
:root{--ink:#0d0b0a;--soft:#151210;--line:#2a231e;--body:#f1ece4;--mist:#a69d93;--ghost:#918880;--ember:#ff6b4a;--ember-ink:#ff8f73;}
*{box-sizing:border-box}
html{background:var(--ink)}
body{margin:0;background:var(--ink);min-height:100%;padding:0 18mm;color:var(--body);
 font-family:"Inter","Helvetica Neue",Arial,sans-serif;font-size:10.5pt;line-height:1.62;
 -webkit-print-color-adjust:exact;print-color-adjust:exact;}
.wrap{max-width:150mm;margin:0 auto;padding:20mm 0 18mm}
.crest{display:flex;align-items:baseline;justify-content:space-between;
 border-bottom:1px solid var(--line);padding-bottom:5mm;margin-bottom:7mm}
.crest .brand{font-size:15pt;font-weight:700;letter-spacing:-.02em}
.crest .brand span{color:var(--ember)}
.crest .file{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:7.5pt;
 letter-spacing:.16em;text-transform:uppercase;color:var(--ghost)}
h1{font-size:22pt;line-height:1.16;letter-spacing:-.025em;margin:0 0 6mm;font-weight:700}
h2{font-size:12.5pt;margin:9mm 0 3mm;font-weight:650;color:var(--ember-ink);letter-spacing:-.01em;
 page-break-after:avoid}
h3{font-size:10.5pt;margin:6mm 0 2mm;font-weight:650}
p{margin:0 0 3.4mm;orphans:3;widows:3}
strong{color:#fff;font-weight:650}
em{color:var(--mist);font-style:italic}
code{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:8.8pt;
 background:var(--soft);border:1px solid var(--line);border-radius:3px;padding:.5mm 1.4mm;color:var(--ember-ink)}
hr{border:0;border-top:1px solid var(--line);margin:8mm 0}
.meta{display:flex;gap:4mm;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:8pt;
 padding:1.6mm 0;border-bottom:1px solid var(--line)}
.meta .k{color:var(--ghost);text-transform:uppercase;letter-spacing:.12em;min-width:34mm}
.meta .v{color:var(--body)}
.meta:first-of-type{border-top:1px solid var(--line)}
.coda{color:var(--ghost);font-size:9pt;font-style:italic;border-left:2px solid var(--ember);
 padding-left:4mm;margin-top:7mm}
.plain{background:var(--soft);border:1px solid var(--line);border-left:2px solid var(--ember);
 border-radius:2mm;padding:5mm 6mm;margin:0 0 4mm}
table{width:100%;border-collapse:collapse;margin:0 0 4mm;font-size:9pt;page-break-inside:avoid}
th{text-align:left;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:7.5pt;
 letter-spacing:.1em;text-transform:uppercase;color:var(--ghost);font-weight:400;
 border-bottom:1px solid var(--line);padding:1.8mm 3mm 1.8mm 0;vertical-align:bottom}
td{border-bottom:1px solid var(--line);padding:2.2mm 3mm 2.2mm 0;vertical-align:top;color:var(--mist)}
td:first-child{color:var(--body)}
pre{background:var(--soft);border:1px solid var(--line);border-radius:2mm;padding:4mm 5mm;
 font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:8.2pt;line-height:1.5;
 color:var(--ember-ink);white-space:pre-wrap;margin:0 0 4mm;page-break-inside:avoid}
.foot{margin-top:10mm;padding-top:4mm;border-top:1px solid var(--line);
 font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:7pt;letter-spacing:.14em;
 text-transform:uppercase;color:var(--ghost);display:flex;justify-content:space-between}
</style></head><body><div class="wrap">
<div class="crest"><div class="brand">Cinder<span>.</span></div>
<div class="file">__SLUG__ &middot; Decision Gate</div></div>
__BODY__
<div class="foot"><span>uxuiai.org</span><span>Cinder &middot; __DATE__</span></div>
</div></body></html>"""

META_KEYS = ("Decision gate", "Date", "Verdict", "Vote")


def inline(text: str) -> str:
    """Escape first, then apply the small set of inline marks we allow."""
    out = html.escape(text)
    out = re.sub(r"`([^`]+)`", r"<code>\1</code>", out)
    out = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", out)
    out = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", out)
    return out


def to_html(markdown: str) -> tuple[str, str, str]:
    """Return (body_html, title, date). Paragraphs are joined across lines."""
    body, paragraph, title, date = [], [], "Field Note", ""
    fence, table = [], []

    def flush() -> None:
        if paragraph:
            body.append("<p>" + " ".join(paragraph) + "</p>")
            paragraph.clear()

    for raw in markdown.split("\n"):
        line = raw.strip()
        in_fence = bool(fence and fence[-1])
        is_row = line.startswith("|") and line.endswith("|")

        # A table ends at the first line that is not a row. This has to happen
        # before every other branch, because headings and rules `continue` and
        # would otherwise leave the table open and swallow what follows.
        if table and not is_row and not in_fence:
            body.append("</table>")
            table.clear()

        if not line and not in_fence:
            flush()
            continue
        if line == "---" and not in_fence:
            flush()
            body.append("<hr>")
            continue

        heading = None if in_fence else re.match(r"^(#{1,3})\s+(.*)", line)
        if heading:
            flush()
            level = len(heading.group(1))
            if level == 1:
                title = heading.group(2)
            body.append(f"<h{level}>{inline(heading.group(2))}</h{level}>")
            continue

        # `**Key:** value` renders as a metadata row rather than a paragraph.
        if not in_fence and any(line.startswith(f"**{k}:**") for k in META_KEYS):
            flush()
            key, value = line.split(":**", 1)
            key = key.strip("*").strip()
            value = value.strip()
            if key == "Date":
                date = value
            body.append(
                f'<div class="meta"><span class="k">{inline(key)}</span>'
                f'<span class="v">{inline(value)}</span></div>'
            )
            continue

        # A wholly-italic line at the end is the coda.
        if not in_fence and line.startswith("*") and line.endswith("*") and not line.startswith("**"):
            flush()
            body.append(f'<p class="coda">{inline(line.strip("*"))}</p>')
            continue

        # Fenced code — measurements are quoted verbatim, never reflowed.
        if line.startswith("```"):
            flush()
            fence.append(not fence[-1] if fence else True)
            body.append("<pre>" if fence[-1] else "</pre>")
            continue
        if in_fence:
            body.append(html.escape(raw.rstrip()))
            continue

        # Pipe tables.
        if is_row:
            cells = [c.strip() for c in line.strip("|").split("|")]
            if all(re.fullmatch(r":?-{2,}:?", c) for c in cells):
                continue  # the --- separator row
            flush()
            tag = "th" if not table else "td"
            if not table:
                body.append('<table><tr>')
                table.append(True)
            else:
                body.append("<tr>")
            body.append("".join(f"<{tag}>{inline(c)}</{tag}>" for c in cells))
            body.append("</tr>")
            continue

        paragraph.append(inline(line))

    flush()
    if table:
        body.append("</table>")
    return "\n".join(body), title, date


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2

    source = HERE / sys.argv[1]
    if not source.exists():
        print(f"no such field note: {source}")
        return 1

    body, title, date = to_html(source.read_text())
    slug = source.stem.split("-")[0]

    BUILD.mkdir(exist_ok=True)
    target = BUILD / f"{slug}.html"
    target.write_text(
        TEMPLATE.replace("__BODY__", body)
        .replace("__TITLE__", html.escape(title))
        .replace("__SLUG__", f"Field Note {slug}")
        .replace("__DATE__", html.escape(date))
    )
    print(f"wrote {target.relative_to(HERE.parent.parent)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
