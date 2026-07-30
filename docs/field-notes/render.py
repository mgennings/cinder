#!/usr/bin/env python3
"""Render a field note to styled HTML (for Chrome's print-to-PDF) and to a
structured JSON artifact that Cinder's SvelteKit route renders directly.

Deliberately dependency-free. A field note is a durable artifact and its
renderer should still run in five years without an install step, so this
handles only the Markdown this house style actually uses: headings, bold,
italic, inline code, rules, `Key:` metadata rows, pipe tables, fenced code,
and a closing italic coda.

Refuses to render a note that fails note_contract.validate() — see render()
for why that refusal is the whole enforcement mechanism, not a courtesy.

Usage:
    python3 docs/field-notes/render.py 001-the-vote-to-stay-blind.md
"""

import html
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from note_contract import META_KEYS, Note, parse_note, validate

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
h1{font-size:22pt;line-height:1.16;letter-spacing:-.025em;margin:0 0 6mm;font-weight:700;text-wrap:balance}
h2{font-size:12.5pt;margin:9mm 0 3mm;font-weight:650;color:var(--ember-ink);letter-spacing:-.01em;
 page-break-after:avoid;text-wrap:balance}
h3{font-size:10.5pt;margin:6mm 0 2mm;font-weight:650;text-wrap:balance}
p{margin:0 0 3.4mm;orphans:3;widows:3;text-wrap:pretty}
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


def inline(text: str) -> str:
    """Escape first, then apply the small set of inline marks we allow."""
    out = html.escape(text)
    out = re.sub(r"`([^`]+)`", r"<code>\1</code>", out)
    out = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", out)
    out = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", out)
    return out


def to_html(markdown: str) -> tuple[str, list[dict]]:
    """Return (body_html, blocks). Paragraphs are joined across lines.

    Walks the document exactly once. Every construct gets classified two
    ways in the same pass: appended to `body` as the HTML string Chrome's
    print-to-PDF consumes, and appended to `blocks` as the structured record
    docs/field-notes/{number}.json ships. Doing both here — rather than
    walking the markdown a second time to build the JSON — is the whole
    point: a second walk is a second parser, and this repo has already paid
    for what happens when two derivations of the same document quietly
    disagree (.notes/GOTCHAS.md, "the part locator is derived in TWO
    places").

    See the module-level comment above `render()` for the JSON block
    contract this function's `blocks` return value fills.
    """
    body: list[str] = []
    blocks: list[dict] = []
    paragraph: list[str] = []
    fence: list[bool] = []
    fence_lines: list[str] = []
    table: list[bool] = []
    table_header: list[str] = []
    table_rows: list[list[str]] = []

    def flush() -> None:
        if paragraph:
            text = " ".join(paragraph)
            body.append("<p>" + text + "</p>")
            blocks.append({"kind": "paragraph", "html": text})
            paragraph.clear()

    def close_table() -> None:
        if table:
            body.append("</table>")
            blocks.append(
                {
                    "kind": "table",
                    "header": list(table_header),
                    "rows": [list(row) for row in table_rows],
                }
            )
            table.clear()
            table_header.clear()
            table_rows.clear()

    for raw in markdown.split("\n"):
        line = raw.strip()
        in_fence = bool(fence and fence[-1])
        is_row = line.startswith("|") and line.endswith("|")

        # A table ends at the first line that is not a row. This has to happen
        # before every other branch, because headings and rules `continue` and
        # would otherwise leave the table open and swallow what follows.
        if table and not is_row and not in_fence:
            close_table()

        if not line and not in_fence:
            flush()
            continue
        if line == "---" and not in_fence:
            flush()
            body.append("<hr>")
            blocks.append({"kind": "rule"})
            continue

        heading = None if in_fence else re.match(r"^(#{1,3})\s+(.*)", line)
        if heading:
            flush()
            level = len(heading.group(1))
            heading_html = inline(heading.group(2))
            body.append(f"<h{level}>{heading_html}</h{level}>")
            blocks.append({"kind": "heading", "level": level, "html": heading_html})
            continue

        # `**Key:** value` renders as a metadata row rather than a paragraph.
        if not in_fence and any(line.startswith(f"**{k}:**") for k in META_KEYS):
            flush()
            key, value = line.split(":**", 1)
            key = key.strip("*").strip()
            value = value.strip()
            key_html, value_html = inline(key), inline(value)
            body.append(
                f'<div class="meta"><span class="k">{key_html}</span>'
                f'<span class="v">{value_html}</span></div>'
            )
            blocks.append({"kind": "meta", "key": key_html, "value": value_html})
            continue

        # A wholly-italic line at the end is the coda.
        if not in_fence and line.startswith("*") and line.endswith("*") and not line.startswith("**"):
            flush()
            coda_html = inline(line.strip("*"))
            body.append(f'<p class="coda">{coda_html}</p>')
            blocks.append({"kind": "coda", "html": coda_html})
            continue

        # Fenced code — measurements are quoted verbatim, never reflowed.
        if line.startswith("```"):
            flush()
            opening = not fence[-1] if fence else True
            fence.append(opening)
            if opening:
                body.append("<pre>")
                fence_lines.clear()
            else:
                body.append("</pre>")
                blocks.append({"kind": "code", "lines": list(fence_lines)})
            continue
        if in_fence:
            escaped = html.escape(raw.rstrip())
            body.append(escaped)
            fence_lines.append(escaped)
            continue

        # Pipe tables.
        if is_row:
            cells = [c.strip() for c in line.strip("|").split("|")]
            if all(re.fullmatch(r":?-{2,}:?", c) for c in cells):
                continue  # the --- separator row
            flush()
            inline_cells = [inline(c) for c in cells]
            tag = "th" if not table else "td"
            if not table:
                body.append("<table><tr>")
                table.append(True)
                table_header.extend(inline_cells)
            else:
                body.append("<tr>")
                table_rows.append(inline_cells)
            body.append("".join(f"<{tag}>{c}</{tag}>" for c in inline_cells))
            body.append("</tr>")
            continue

        paragraph.append(inline(line))

    flush()
    close_table()
    return "\n".join(body), blocks


# The JSON contract render() emits at docs/field-notes/{number}.json. Task 3's
# SvelteKit route imports this file directly and renders it with Cinder's own
# design-system components — it never imports this module or note_contract.py,
# so this comment IS the interface.
#
#   {
#     "number": "001",
#     "title": "Field Note 001 — The Vote To Stay Blind",
#     "date": "2026-07-27",
#     "gate": "Cinder / abuse resistance",
#     "verdict": "Stay request-blind. Accept being knocked offline.",
#     "vote": "12 of 12, unanimous.",
#     "blocks": [ ... ]
#   }
#
# The six metadata fields are plain text, straight out of note_contract.Note
# — never markdown, never HTML — because a renderer drops them in as TEXT
# content (a <title> tag, an index-page table cell), where injected markup
# would be wrong. `blocks` is the opposite: it is what a reader actually
# sees, in document order, and every block already carries whatever HTML
# `inline()` produced for it, ready for `{@html}`. Task 3 must never run a
# markdown parser or a bold/italic regex of its own — `inline()` is this
# repo's one boundary between untrusted-shaped text and emitted markup, and
# the entire reason the JSON ships pre-rendered HTML instead of raw markdown
# is so nothing downstream has to reimplement that boundary.
#
# Every block is a flat dict with "kind" plus kind-specific fields:
#
#   heading   {kind, level: 1|2|3, html}
#   paragraph {kind, html}
#   meta      {kind, key, value}       -- a `**Key:** value` row. key/value
#                                          are separate fields, not one
#                                          string, because a renderer draws
#                                          them as two columns and must not
#                                          re-split ":**" to get there.
#   coda      {kind, html}             -- the closing italic line. Its own
#                                          kind, not a paragraph with a flag,
#                                          because it is one specific styled
#                                          element (border, italic, color),
#                                          not prose with a modifier.
#   rule      {kind}                   -- a "---" divider. No other field
#                                          would ever be read, so none exists.
#   table     {kind, header: [html, ...], rows: [[html, ...], ...]}
#   code      {kind, lines: [html, ...]} -- html-escaped only, NEVER run
#                                            through inline(): a fenced block
#                                            is verbatim measurement output,
#                                            and letting `**bold**` fire
#                                            inside a code fence would corrupt
#                                            it.
#
# Determinism is load-bearing, not cosmetic: regenerating this file from an
# unchanged source must produce byte-identical output, which is what lets a
# test assert the committed JSON is not stale. That is why nothing here is
# sorted by anything but document order, and why no timestamp, path, or
# run-specific value is ever written into the payload.


def render(source: pathlib.Path) -> tuple[str, dict]:
    """Parse, gate, and render one field note. Returns (html_document,
    json_payload); raises ValueError naming every violation if the note
    fails note_contract.validate().

    This refusal is the whole enforcement mechanism for the house format,
    so it earns being deliberate rather than a courtesy check: Cinder ships
    no CI and no pre-push hook, so nothing checks a note on its way into
    git. Refusing HERE, at generation time, is the one gate that actually
    holds — no HTML, no PDF, and no committed JSON can exist for a note that
    never passed through this function, because nothing downstream produces
    those artifacts any other way. This is a generation-time gate, not a
    build-enforced one: nothing stops someone from committing a note whose
    HTML/JSON were never regenerated, only from producing NEW artifacts for
    an invalid one.
    """
    note: Note = parse_note(source)
    violations = validate(note)
    if violations:
        raise ValueError(
            f"refusing to render {source.name}: house-format violations\n"
            + "\n".join(f"  - {v}" for v in violations)
        )

    body, blocks = to_html(note.raw)

    html_document = (
        TEMPLATE.replace("__BODY__", body)
        .replace("__TITLE__", html.escape(note.title))
        .replace("__SLUG__", f"Field Note {note.number}")
        .replace("__DATE__", html.escape(note.date))
    )

    json_payload = {
        "number": note.number,
        "title": note.title,
        "date": note.date,
        "gate": note.gate,
        "verdict": note.verdict,
        "vote": note.vote,
        "blocks": blocks,
    }

    return html_document, json_payload


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2

    source = HERE / sys.argv[1]
    if not source.exists():
        print(f"no such field note: {source}")
        return 1

    try:
        html_document, json_payload = render(source)
    except ValueError as exc:
        print(exc)
        return 1

    slug = json_payload["number"]

    BUILD.mkdir(exist_ok=True)
    html_target = BUILD / f"{slug}.html"
    html_target.write_text(html_document)
    print(f"wrote {html_target.relative_to(HERE.parent.parent)}")

    # The JSON sits beside the source markdown, not in build/. build/ is
    # generated-and-gitignored scratch (README.md); this is committed data
    # that Task 3's SvelteKit route imports directly, not an intermediate
    # to regenerate on every visit.
    json_target = HERE / f"{slug}.json"
    json_target.write_text(json.dumps(json_payload, indent=2) + "\n")
    print(f"wrote {json_target.relative_to(HERE.parent.parent)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
