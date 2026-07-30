#!/usr/bin/env python3
"""Tests for render.py.

Run directly:

    python3 docs/field-notes/test_render.py

Plain asserts, no framework, matching test_note_contract.py. `render()` is
pure — it takes a path, returns (html_document, json_payload), and performs
no I/O itself — so most tests here call it directly and never touch the
filesystem beyond writing the throwaway fixture note `_note()` builds.

The one exception is the "artifact is not stale" check: that has to compare
against something real, so it renders note 001 and pins its output.
"""

import hashlib
import inspect
import json
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from note_contract import parse_note
from render import render, to_html

HERE = pathlib.Path(__file__).parent
NOTE_001 = HERE / "001-the-vote-to-stay-blind.md"

# Captured by running the UNMODIFIED render.py (before this file's own
# subject existed — before the note_contract gate, before the JSON emit,
# before the four text-wrap lines) against 001-the-vote-to-stay-blind.md:
#
#   python3 docs/field-notes/render.py 001-the-vote-to-stay-blind.md
#   shasum -a 256 docs/field-notes/build/001.html
#
# 15271 bytes, sha256 0587e1f2611e97bb32f288682dd3ffcc03fee75c5d2b668b9cb-
# 784774ace74e9. A hash rather than the 15KB literal, because the point is
# proof, not a fixture to eyeball — and unlike a structural count (how many
# <h2> tags, how many <table> tags), a hash cannot pass while the actual
# bytes inside a tag are wrong. That gap is not hypothetical: an earlier
# draft of this test checked only tag counts and stayed green when
# inline()'s bold substitution was deliberately corrupted from <strong> to
# <b> — the count of "things that are bold" didn't change, only which tag
# wrapped them. Hashing the real bytes catches that.
_BASELINE_SHA256 = "0587e1f2611e97bb32f288682dd3ffcc03fee75c5d2b668b9cb784774ace74e9"
_BASELINE_LENGTH = 15271

# Part 1 (the gate) and Part 2 (the JSON emit, built by extending to_html's
# single walk) must not move a single byte of the baseline above. Part 3
# deliberately does: it adds `text-wrap:pretty` to `p{}` and
# `text-wrap:balance` to `h1{}`/`h2{}`/`h3{}` in the static template CSS, so
# those four lines are reverted before hashing rather than pretending the
# artifact never changed.
_BASELINE_CSS_LINES = {
    'h1{font-size:22pt;line-height:1.16;letter-spacing:-.025em;margin:0 0 6mm;font-weight:700}': (
        'h1{font-size:22pt;line-height:1.16;letter-spacing:-.025em;margin:0 0 6mm;'
        'font-weight:700;text-wrap:balance}'
    ),
    ' page-break-after:avoid}': ' page-break-after:avoid;text-wrap:balance}',
    'h3{font-size:10.5pt;margin:6mm 0 2mm;font-weight:650}': (
        'h3{font-size:10.5pt;margin:6mm 0 2mm;font-weight:650;text-wrap:balance}'
    ),
    'p{margin:0 0 3.4mm;orphans:3;widows:3}': 'p{margin:0 0 3.4mm;orphans:3;widows:3;text-wrap:pretty}',
}


def _note(body: str = "", filename: str = "999-test-note.md"):
    """Write a small, otherwise-valid note (metadata + both required
    halves, plus whatever `body` supplies) to a throwaway temp file and
    return its path. Mirrors test_note_contract.py's `_parse` helper, one
    level up: that one hands back a parsed Note, this one hands back a
    path, because render() takes a path (it calls parse_note itself)."""
    text = (
        "# Field Note 999 — Test Note\n\n"
        "**Decision gate:** Test / fixture\n"
        "**Date:** 2026-01-01\n"
        "**Verdict:** Ship it.\n"
        "**Vote:** 3 of 3, unanimous.\n\n"
        "---\n\n"
        "## In plain words\n\n"
        "A plain paragraph for a reader with no technical background.\n\n"
        "---\n\n"
        "## The technical record\n\n" + body
    )
    tmpdir = tempfile.mkdtemp()
    path = pathlib.Path(tmpdir) / filename
    path.write_text(text, encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Part 1 — refuse to render an invalid note.
# ---------------------------------------------------------------------------

def test_refuses_invalid_note():
    """A note missing the Vote line fails note_contract.validate(), and
    render() must refuse rather than produce a half-valid artifact."""
    text = (
        "# Field Note 999 — No Vote\n\n"
        "**Decision gate:** Test / fixture\n"
        "**Date:** 2026-01-01\n"
        "**Verdict:** Ship it.\n\n"
        "---\n\n"
        "## In plain words\n\nA paragraph.\n\n"
        "---\n\n"
        "## The technical record\n\nA paragraph.\n"
    )
    tmpdir = tempfile.mkdtemp()
    path = pathlib.Path(tmpdir) / "999-no-vote.md"
    path.write_text(text, encoding="utf-8")

    try:
        render(path)
        raised = False
    except ValueError as exc:
        raised = True
        message = str(exc)

    assert raised, "render() must raise on a note that fails validate()"
    assert "'vote'" in message, message


def test_valid_note_renders_clean():
    """The mirror image of the refusal test — a note that DOES satisfy
    note_contract.validate() must render without raising."""
    html_document, json_payload = render(_note("A technical paragraph.\n"))
    assert "<h1>Field Note 999" in html_document
    assert json_payload["gate"] == "Test / fixture"


# ---------------------------------------------------------------------------
# Part 2 — every block kind survives the round trip into JSON.
# ---------------------------------------------------------------------------

def test_every_block_kind_round_trips():
    body = (
        "### A subhead\n\n"
        "A paragraph with **bold**, *italic*, and `code`.\n\n"
        "| Col A | Col B |\n"
        "| --- | --- |\n"
        "| one | two |\n\n"
        "```\nverbatim line one\nverbatim line two\n```\n\n"
        "---\n\n"
        "*A closing coda.*\n"
    )
    html_document, json_payload = render(_note(body))
    blocks = json_payload["blocks"]
    kinds = [b["kind"] for b in blocks]

    for expected in ("heading", "meta", "paragraph", "table", "code", "rule", "coda"):
        assert expected in kinds, (expected, kinds)

    # Every block is plain JSON-native data: str, int, list, dict. No
    # dataclass, no custom type — so json.dumps needs no encoder, and a
    # renderer can json.loads this back with zero glue code.
    payload = json.dumps(json_payload)
    reloaded = json.loads(payload)
    assert reloaded == json_payload

    table = next(b for b in blocks if b["kind"] == "table")
    assert table["header"] == ["Col A", "Col B"]
    assert table["rows"] == [["one", "two"]]

    code = next(b for b in blocks if b["kind"] == "code")
    assert code["lines"] == ["verbatim line one", "verbatim line two"]

    coda = next(b for b in blocks if b["kind"] == "coda")
    assert coda["html"] == "A closing coda."

    heading = next(b for b in blocks if b["kind"] == "heading" and b["level"] == 3)
    assert heading["html"] == "A subhead"

    para = next(b for b in blocks if b["kind"] == "paragraph" and "bold" in b["html"])
    assert "<strong>bold</strong>" in para["html"]
    assert "<em>italic</em>" in para["html"]
    assert "<code>code</code>" in para["html"]


def test_code_block_is_escaped_not_inline_processed():
    """A fenced block is verbatim measurement output. **bold** markers
    inside a fence must stay literal text, never become <strong>."""
    body = "```\nnot **bold**, just measured\n```\n"
    _, json_payload = render(_note(body))
    code = next(b for b in json_payload["blocks"] if b["kind"] == "code")
    assert code["lines"] == ["not **bold**, just measured"]


# ---------------------------------------------------------------------------
# Determinism — regenerating from an unchanged source is byte-identical.
# ---------------------------------------------------------------------------

def test_json_is_byte_identical_across_two_generations():
    first_html, first_json = render(NOTE_001)
    second_html, second_json = render(NOTE_001)

    first_bytes = json.dumps(first_json, indent=2).encode("utf-8")
    second_bytes = json.dumps(second_json, indent=2).encode("utf-8")
    assert first_bytes == second_bytes, "same source must produce byte-identical JSON"
    assert first_html == second_html, "same source must produce byte-identical HTML"


# ---------------------------------------------------------------------------
# Note 001 — the one real note. Renders and produces the expected sequence.
# ---------------------------------------------------------------------------

def test_note_001_renders_expected_block_sequence():
    _, json_payload = render(NOTE_001)
    assert json_payload["number"] == "001"
    assert json_payload["title"] == "Field Note 001 — The Vote To Stay Blind"
    assert json_payload["date"] == "2026-07-27"
    assert json_payload["gate"] == "Cinder / abuse resistance"
    assert json_payload["verdict"] == "Stay request-blind. Accept being knocked offline."
    assert json_payload["vote"] == "12 of 12, unanimous."

    blocks = json_payload["blocks"]
    kinds = [b["kind"] for b in blocks]

    # The four **Key:** metadata rows come first, in source order.
    assert kinds[:4] == ["heading", "meta", "meta", "meta"]
    assert [b["key"] for b in blocks[1:4]] == ["Decision gate", "Date", "Verdict"]
    # Vote is a fourth meta row directly after (blocks[4]); checked via count.
    assert kinds.count("meta") == 4

    # The house format's own contract: three H2 sections, "In plain words"
    # first, "The technical record" last.
    h2s = [b["html"] for b in blocks if b["kind"] == "heading" and b["level"] == 2]
    assert h2s == [
        "In plain words",
        "Why this document is also the test",
        "The technical record",
    ]

    # Note 001 ships three tables and two fenced measurement blocks.
    assert kinds.count("table") == 3
    assert kinds.count("code") == 2
    assert kinds.count("rule") == 4
    assert kinds.count("coda") == 1

    # And this note round-trips through parse_note/validate cleanly, which
    # is exactly what let render() proceed instead of refusing.
    note = parse_note(NOTE_001)
    assert note.title == json_payload["title"]


def test_note_001_html_output_unchanged_except_the_four_css_lines():
    """The regression proof: render note 001 through the current code,
    strip out Part 3's four deliberate CSS additions, and hash what's left
    against the byte-exact baseline captured from the unmodified renderer
    (see `_BASELINE_SHA256` above). Anything else moving — a stray space in
    a paragraph join, a wrong tag out of inline(), a reordered block — means
    the note_contract gate or the JSON-emitting refactor of to_html quietly
    altered the one artifact they were supposed to leave alone.
    """
    html_document, _ = render(NOTE_001)
    reconstructed_baseline = html_document
    for after, before in _BASELINE_CSS_LINES.items():
        assert before in reconstructed_baseline, f"expected CSS line missing: {before!r}"
        reconstructed_baseline = reconstructed_baseline.replace(before, after, 1)

    reconstructed_bytes = reconstructed_baseline.encode("utf-8")
    assert len(reconstructed_bytes) == _BASELINE_LENGTH, (
        f"length drifted: {len(reconstructed_bytes)} vs baseline {_BASELINE_LENGTH}"
    )
    digest = hashlib.sha256(reconstructed_bytes).hexdigest()
    assert digest == _BASELINE_SHA256, (
        f"HTML output (with Part 3's CSS lines reverted) no longer matches "
        f"the pre-change baseline: got {digest}, want {_BASELINE_SHA256}"
    )


# ---------------------------------------------------------------------------
# to_html — the shared walk stays a single pass; body and blocks agree.
# ---------------------------------------------------------------------------

def test_to_html_body_and_blocks_agree_on_construct_counts():
    note = parse_note(NOTE_001)
    body, blocks = to_html(note.raw)

    assert body.count("<h2>") == sum(1 for b in blocks if b["kind"] == "heading" and b["level"] == 2)
    assert body.count("<table><tr>") == sum(1 for b in blocks if b["kind"] == "table")
    assert body.count('<p class="coda">') == sum(1 for b in blocks if b["kind"] == "coda")


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

TESTS = [
    test_refuses_invalid_note,
    test_valid_note_renders_clean,
    test_every_block_kind_round_trips,
    test_code_block_is_escaped_not_inline_processed,
    test_json_is_byte_identical_across_two_generations,
    test_note_001_renders_expected_block_sequence,
    test_note_001_html_output_unchanged_except_the_four_css_lines,
    test_to_html_body_and_blocks_agree_on_construct_counts,
]


def main() -> int:
    # A suite with nothing registered would run zero checks and still print
    # green — guard against that instead of trusting the exit code alone.
    assert TESTS, "no tests registered"

    failures = []
    total_asserts = 0
    for test in TESTS:
        total_asserts += inspect.getsource(test).count("assert ")
        try:
            test()
        except AssertionError as exc:
            failures.append((test.__name__, str(exc)))
            print(f"FAIL  {test.__name__}: {exc}")
        else:
            print(f"PASS  {test.__name__}")

    assert total_asserts > 0, "no assert statements found in the suite"

    print()
    print(f"{len(TESTS) - len(failures)}/{len(TESTS)} tests passed, {total_asserts} assert statements ran")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
