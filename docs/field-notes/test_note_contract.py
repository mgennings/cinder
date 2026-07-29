#!/usr/bin/env python3
"""Contract tests for note_contract.py.

Run directly:

    python3 docs/field-notes/test_note_contract.py

Plain asserts, no framework. A field note is a durable artifact and its
tooling should still run untouched in five years, and a test suite that
needs a pip install would break that same promise for its own checker.

Each test past the anchor builds a small, otherwise-valid note as an inline
string, mutates the one thing under test, and asserts the specific
violation shows up (or specifically does not). No fixture files on disk —
`_parse` writes to a temp directory and reads it back through the same
`parse_note(path)` entry point real callers use, then throws the file away.
"""

import dataclasses
import inspect
import json
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from note_contract import Section, parse_note, validate

HERE = pathlib.Path(__file__).parent
NOTE_001 = HERE / "001-the-vote-to-stay-blind.md"


def _parse(text: str, filename: str = "999-test-note.md"):
    """Write `text` to a throwaway temp file and parse it back."""
    with tempfile.TemporaryDirectory() as tmpdir:
        path = pathlib.Path(tmpdir) / filename
        path.write_text(text, encoding="utf-8")
        return parse_note(path)


# ---------------------------------------------------------------------------
# The anchor test. If this fails, the validator is wrong — not the note.
# ---------------------------------------------------------------------------

def test_001_parses_and_validates_clean():
    note = parse_note(NOTE_001)

    assert note.number == "001"
    assert note.title == "Field Note 001 — The Vote To Stay Blind"
    assert note.date == "2026-07-27"
    assert note.gate == "Cinder / abuse resistance"
    assert note.verdict == "Stay request-blind. Accept being knocked offline."
    assert note.vote == "12 of 12, unanimous."
    assert note.media == [], "note 001 ships no images"
    assert len(note.sections) == 11, note.sections
    assert note.sections[0] == Section(level=2, heading="In plain words")
    assert note.sections[1] == Section(level=2, heading="Why this document is also the test")
    assert note.sections[2] == Section(level=2, heading="The technical record")

    violations = validate(note)
    assert violations == [], f"note 001 must validate clean, got: {violations}"

    # And the whole thing round-trips through JSON, so a renderer can work
    # from this same parse instead of hand-maintaining a second copy of
    # the text.
    payload = json.dumps(dataclasses.asdict(note))
    assert json.loads(payload)["gate"] == "Cinder / abuse resistance"


# ---------------------------------------------------------------------------
# Rule 1 — both halves present, in order.
# ---------------------------------------------------------------------------

def test_missing_plain_half():
    text = (
        "# Field Note 999 — Missing Plain Half\n\n"
        "**Decision gate:** Test / fixture\n"
        "**Date:** 2026-01-01\n"
        "**Verdict:** Ship it.\n"
        "**Vote:** 3 of 3, unanimous.\n\n"
        "---\n\n"
        "## The technical record\n\n"
        "This note skips straight to the technical half, which the house format forbids.\n"
    )
    violations = validate(_parse(text))
    assert any("In plain words" in v for v in violations), violations


def test_missing_technical_half():
    text = (
        "# Field Note 999 — Missing Technical Half\n\n"
        "**Decision gate:** Test / fixture\n"
        "**Date:** 2026-01-01\n"
        "**Verdict:** Ship it.\n"
        "**Vote:** 3 of 3, unanimous.\n\n"
        "---\n\n"
        "## In plain words\n\n"
        "This note never reaches the technical record, which the house format also forbids.\n"
    )
    violations = validate(_parse(text))
    assert any("technical record" in v for v in violations), violations


def test_halves_out_of_order():
    text = (
        "# Field Note 999 — Halves Reversed\n\n"
        "**Decision gate:** Test / fixture\n"
        "**Date:** 2026-01-01\n"
        "**Verdict:** Ship it.\n"
        "**Vote:** 3 of 3, unanimous.\n\n"
        "---\n\n"
        "## The technical record\n\n"
        "The technical half is written first here, which inverts the required order.\n\n"
        "---\n\n"
        "## In plain words\n\n"
        "The plain half arrives second, which the README says is always backwards.\n"
    )
    violations = validate(_parse(text))
    assert any("appears before" in v for v in violations), violations


# ---------------------------------------------------------------------------
# Rule 2 — metadata completeness, scoped to the block before the first "---".
# ---------------------------------------------------------------------------

def test_metadata_incomplete():
    text = (
        "# Field Note 999 — Missing Vote\n\n"
        "**Decision gate:** Test / fixture\n"
        "**Date:** 2026-01-01\n"
        "**Verdict:** Ship it.\n\n"
        "---\n\n"
        "## In plain words\n\n"
        "A plain paragraph.\n\n"
        "---\n\n"
        "## The technical record\n\n"
        "A technical paragraph.\n"
    )
    violations = validate(_parse(text))
    assert any("'vote'" in v for v in violations), violations


def test_metadata_after_hr_does_not_count():
    """A key stated in the body rather than the metadata block does not
    satisfy completeness — position is part of the contract, not just
    presence anywhere in the file."""
    text = (
        "# Field Note 999 — Vote In The Wrong Place\n\n"
        "**Decision gate:** Test / fixture\n"
        "**Date:** 2026-01-01\n"
        "**Verdict:** Ship it.\n\n"
        "---\n\n"
        "## In plain words\n\n"
        "A plain paragraph.\n\n"
        "**Vote:** 3 of 3, unanimous.\n\n"
        "---\n\n"
        "## The technical record\n\n"
        "A technical paragraph.\n"
    )
    note = _parse(text)
    assert note.vote == "", "a Vote line after the first --- must not be captured as metadata"
    violations = validate(note)
    assert any("'vote'" in v for v in violations), violations


# ---------------------------------------------------------------------------
# Rule 3 — every image carries alt text.
# ---------------------------------------------------------------------------

def test_missing_alt_text():
    text = (
        "# Field Note 999 — Image Without Alt\n\n"
        "**Decision gate:** Test / fixture\n"
        "**Date:** 2026-01-01\n"
        "**Verdict:** Ship it.\n"
        "**Vote:** 3 of 3, unanimous.\n\n"
        "---\n\n"
        "## In plain words\n\n"
        "A plain paragraph.\n\n"
        "---\n\n"
        "## The technical record\n\n"
        "A technical paragraph.\n\n"
        "![](chart.png)\n\n"
        "![the load test graph, ten green bars and thirty red ones](graph.png)\n"
    )
    note = _parse(text)
    assert len(note.media) == 2, note.media

    violations = validate(note)
    assert any("chart.png" in v for v in violations), violations
    assert not any("graph.png" in v for v in violations), "real alt text must not be flagged"


# ---------------------------------------------------------------------------
# Rule 4 — no literal non-breaking space (U+00A0) anywhere in the source.
# There is no font-metric instrument at the source level to know where a
# rendered line will actually wrap, so this checker does not guess at
# orphan risk. It only rejects the one thing it can check honestly: an
# invisible byte that has no business being load-bearing in a markdown file.
# ---------------------------------------------------------------------------

def test_rejects_literal_nbsp():
    text = (
        "# Field Note 999 — Hidden Byte\n\n"
        "**Decision gate:** Test / fixture\n"
        "**Date:** 2026-01-01\n"
        "**Verdict:** Ship it.\n"
        "**Vote:** 3 of 3, unanimous.\n\n"
        "---\n\n"
        "## In plain words\n\n"
        "A plain paragraph.\n\n"
        "---\n\n"
        "## The technical record\n\n"
        "A technical paragraph with a hidden non-breaking space in it.\n"
    )
    violations = validate(_parse(text))
    assert any("non-breaking space" in v for v in violations), violations


# ---------------------------------------------------------------------------
# Rule 5 — prose is one unbroken line per paragraph in the source.
# ---------------------------------------------------------------------------

def test_hard_wrapped_paragraph():
    text = (
        "# Field Note 999 — Hard Wrapped\n\n"
        "**Decision gate:** Test / fixture\n"
        "**Date:** 2026-01-01\n"
        "**Verdict:** Ship it.\n"
        "**Vote:** 3 of 3, unanimous.\n\n"
        "---\n\n"
        "## In plain words\n\n"
        "This paragraph starts on one line\n"
        "and keeps going on a second physical line, which the house style forbids.\n\n"
        "---\n\n"
        "## The technical record\n\n"
        "A technical paragraph.\n"
    )
    violations = validate(_parse(text))
    assert any("hard-wrapped" in v for v in violations), violations


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

TESTS = [
    test_001_parses_and_validates_clean,
    test_missing_plain_half,
    test_missing_technical_half,
    test_halves_out_of_order,
    test_metadata_incomplete,
    test_metadata_after_hr_does_not_count,
    test_missing_alt_text,
    test_rejects_literal_nbsp,
    test_hard_wrapped_paragraph,
]


def main() -> int:
    # A suite with nothing registered would run zero checks and still
    # print green — guard against that instead of trusting the exit code
    # alone. Counting `assert ` occurrences in each test's own source is a
    # cheap, honest proxy for "did this file actually check anything."
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
