#!/usr/bin/env python3
"""Parse and validate a Cinder field note against the house format in
docs/field-notes/README.md.

Deliberately dependency-free, for the same reason render.py is: a field
note is a durable artifact, and the tooling that checks it should still run
in five years with no install step. This module does not import render.py
and does not render anything — it only reads a note's markdown and reports
what is wrong with it, so it can run in CI or a pre-commit hook long before
a note ever reaches Chrome's print-to-pdf.

Usage:
    from note_contract import parse_note, validate
    note = parse_note("001-the-vote-to-stay-blind.md")
    violations = validate(note)
"""

import pathlib
import re
from dataclasses import dataclass


@dataclass
class Section:
    """One heading-delimited chunk of a note's body (an H2 or H3)."""

    level: int
    heading: str


@dataclass
class MediaRef:
    """One `![alt](src)` image reference found anywhere in a note's body."""

    alt: str
    src: str


@dataclass
class Note:
    """A parsed field note. Plain data all the way down — every field is a
    str, int, or a list of one of these dataclasses — so
    `json.dumps(dataclasses.asdict(note))` works with no custom encoder.
    That matters because a renderer downstream can serialize a note once
    and work from that, instead of re-deriving the same facts from the
    markdown a second time.
    """

    number: str
    title: str
    date: str
    gate: str
    verdict: str
    vote: str
    sections: list[Section]
    media: list[MediaRef]
    raw: str


_HEADING_RE = re.compile(r"^(#{1,3})\s+(.*)")
_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")

# The note's metadata block is four `**Key:** value` lines right after the
# H1, immediately before the first "---". This is not YAML front matter —
# there is none in this house style — it is the same hand-rolled key list
# render.py:77 already parses for its own <div class="meta"> rows. Restated
# here rather than imported, because render.py is a different task's
# surface and this module must never reach into it; if that key list ever
# changes, both places have to change on purpose.
META_KEYS = ("Decision gate", "Date", "Verdict", "Vote")


def _iter_lines(text: str):
    """Classify each source line the way render.py's to_html loop does, so
    parse_note and validate share one definition of "what kind of line is
    this" instead of drifting apart over time.

    Yields (kind, payload) pairs. kind is one of "fence", "code" (inside a
    fenced block), "blank", "hr", "heading" (payload: (level, text)),
    "meta" (payload: (key, value)), "table", "coda", or "plain" (an
    ordinary prose line).
    """
    fence = False
    for raw in text.split("\n"):
        line = raw.strip()

        if line.startswith("```"):
            fence = not fence
            yield ("fence", raw)
            continue
        if fence:
            yield ("code", raw)
            continue
        if not line:
            yield ("blank", raw)
            continue
        if line == "---":
            yield ("hr", raw)
            continue

        heading = _HEADING_RE.match(line)
        if heading:
            yield ("heading", (len(heading.group(1)), heading.group(2)))
            continue

        meta_key = next((k for k in META_KEYS if line.startswith(f"**{k}:**")), None)
        if meta_key:
            _, value = line.split(":**", 1)
            yield ("meta", (meta_key, value.strip()))
            continue

        if line.startswith("|") and line.endswith("|"):
            yield ("table", raw)
            continue

        # A wholly-italic line (and not a bold one, which also starts and
        # ends with `*` characters) is the closing coda.
        if line.startswith("*") and line.endswith("*") and not line.startswith("**"):
            yield ("coda", raw)
            continue

        yield ("plain", raw)


def parse_note(path) -> Note:
    """Read a field note's markdown source and return its parsed Note.

    `path` accepts a str or a pathlib.Path. The note number comes from the
    filename (e.g. "001-the-vote-to-stay-blind.md" -> "001"), mirroring the
    same slug convention render.py:193 already uses.
    """
    path = pathlib.Path(path)
    text = path.read_text(encoding="utf-8")

    number = path.stem.split("-")[0]
    title = ""
    metadata = {key: "" for key in META_KEYS}
    sections: list[Section] = []
    media: list[MediaRef] = []

    # The metadata block ends at the FIRST "---". Notes use "---" again
    # later, as an ordinary visual divider between body sections, so only
    # that first one marks the front-matter boundary. A `**Key:** value`
    # line stated after it (in the body, by accident or by design) is not
    # metadata and must not be captured as if it were.
    seen_first_hr = False

    for kind, payload in _iter_lines(text):
        if kind == "hr":
            seen_first_hr = True
        elif kind == "heading":
            level, heading_text = payload
            if level == 1:
                title = heading_text
            else:
                sections.append(Section(level=level, heading=heading_text))
        elif kind == "meta" and not seen_first_hr:
            key, value = payload
            metadata[key] = value
        elif kind in ("plain", "coda"):
            for alt, src in _IMAGE_RE.findall(payload):
                media.append(MediaRef(alt=alt.strip(), src=src.strip()))

    return Note(
        number=number,
        title=title,
        date=metadata["Date"],
        gate=metadata["Decision gate"],
        verdict=metadata["Verdict"],
        vote=metadata["Vote"],
        sections=sections,
        media=media,
        raw=text,
    )


# The two halves README.md mandates, matched against the exact H2 text note
# 001 uses for them. README describes the halves in prose ("In plain
# words." / "The technical record.") without prescribing different wording,
# and the one shipped note uses these two headings literally, so that is
# the contract until a second note proves otherwise.
PLAIN_HALF_HEADING = "in plain words"
TECHNICAL_HALF_HEADING = "the technical record"


def validate(note: Note) -> list[str]:
    """Return a list of house-format violations. Empty means clean.

    Each string names the rule category (house format / metadata / media /
    typography / prose) and quotes enough of the offending text to fix it
    without re-reading the whole note.
    """
    violations: list[str] = []

    # Rule 1 — both halves present, in order. README: "Never invert the
    # order, and never publish only one half. A note with only the plain
    # half is marketing; a note with only the technical half is a
    # changelog."
    headings = [s.heading.strip().lower() for s in note.sections]
    plain_at = headings.index(PLAIN_HALF_HEADING) if PLAIN_HALF_HEADING in headings else None
    technical_at = headings.index(TECHNICAL_HALF_HEADING) if TECHNICAL_HALF_HEADING in headings else None

    if plain_at is None:
        violations.append("house format: missing the 'In plain words' half")
    if technical_at is None:
        violations.append("house format: missing 'The technical record' half")
    if plain_at is not None and technical_at is not None and plain_at > technical_at:
        violations.append(
            "house format: 'The technical record' appears before 'In plain words'; "
            "the plain-words half must come first"
        )

    # Rule 2 — metadata completeness. Every META_KEYS value, plus the
    # number and title the record row needs, must be present and
    # non-empty. A key stated after the note's first "---" was never
    # captured by parse_note, so it shows up here exactly as if it were
    # absent — position is part of the contract, not just presence
    # somewhere in the file.
    required = {
        "number": note.number,
        "title": note.title,
        "date": note.date,
        "gate": note.gate,
        "verdict": note.verdict,
        "vote": note.vote,
    }
    for field_name, value in required.items():
        if not value.strip():
            violations.append(f"metadata: '{field_name}' is missing or empty")

    # Rule 3 — every image carries alt text. README doesn't say this in so
    # many words, but a field note is written for someone with no
    # technical background, and an image with no alt text excludes exactly
    # that reader.
    for ref in note.media:
        if not ref.alt.strip():
            violations.append(f"media: image '{ref.src}' has no alt text")

    # Rule 4 — no literal non-breaking space (U+00A0) in the source. A
    # U+00A0 byte is invisible in nearly every editor and can be silently
    # stripped or mangled in transit (a shell heredoc, a lossy paste), so
    # it is unfit to be load-bearing in a markdown file that has to survive
    # being copied, piped, and diffed. Line-wrap and orphan protection for
    # a rendered heading or paragraph belongs at render time, where an
    # actual line box exists to measure — see app.css's "NO ORPHANS" block
    # (`text-wrap: pretty` / `balance`) for the pattern already shipped on
    # Cinder's web surface. This check only guards the byte hiding in a
    # note's source; it does not try to predict where a line will wrap.
    for line_number, line in enumerate(note.raw.split("\n"), start=1):
        if "\u00a0" in line:
            violations.append(
                f"typography: line {line_number} contains a literal non-breaking space "
                f"(U+00A0); it is invisible and can vanish in transit, remove it: {line.strip()!r}"
            )

    # Rule 5 — prose is one unbroken line per paragraph in the source; the
    # renderer handles wrapping. Two consecutive "plain" lines with no
    # blank line between them means a paragraph was hard-wrapped by hand.
    previous_was_plain = False
    for kind, payload in _iter_lines(note.raw):
        if kind == "plain":
            if previous_was_plain:
                violations.append(
                    f"prose: paragraph is hard-wrapped across source lines near {payload.strip()[:60]!r}"
                )
            previous_was_plain = True
        else:
            previous_was_plain = False

    return violations
