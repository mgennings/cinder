# Field notes

Decision gates, written down after the fact, in enough detail that someone outside this repo can use them.

A field note is not a changelog entry. It exists when a choice was genuinely hard, when the measurement that settled it is worth showing, or when the honest answer cost something — because those are the ones that transfer.

## House format — not optional

Every field note has two halves, in this order, on the same page.

**1. In plain words.** Written for someone with no technical background at all. No jargon, no acronyms, no protocol names. It explains what was at stake for a person, what was chosen, and what it cost them. If a reader has to already know what a rate limit is, it has failed. This section comes first because the people most affected by a privacy decision are rarely the people who can read a config file.

**2. The technical record.** Everything measurable: exact numbers, mechanisms, configuration, and the commands that produced them. No hedging, no rounding in the flattering direction. Claims that turned out wrong are listed as wrong, in the same words that got them wrong.

Never invert the order, and never publish only one half. A note with only the plain half is marketing; a note with only the technical half is a changelog.

## Rules that keep them honest

- Numbers come from a measurement someone actually ran, and the note says against what.
- Every claim that did not survive review gets listed, including our own.
- The cost of the decision is stated as plainly as its benefit.
- Prose is one unbroken line per paragraph in the source; the renderer handles wrapping.

## Index

| # | Note | Gate | Verdict |
| --- | --- | --- | --- |
| 001 | [The Vote To Stay Blind](001-the-vote-to-stay-blind.md) | Abuse resistance | Stay request-blind; accept being knocked offline |

## Rendering

`build/` is generated and gitignored. Regenerate after editing a note:

```bash
python3 docs/field-notes/render.py 001-the-vote-to-stay-blind.md
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf=docs/field-notes/build/cinder-field-note-001.pdf \
  file://$PWD/docs/field-notes/build/001.html
```

The renderer is dependency-free on purpose. A field note is a durable artifact, and it should still build in five years without an install step.
