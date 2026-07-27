# Field notes

Decision gates, written down after the fact, in enough detail that someone outside this repo can use them.

A field note is not a changelog entry. It exists when a choice was genuinely hard, when the measurement that settled it is worth showing, or when the honest answer cost something — because those are the ones that transfer.

| # | Note | Gate | Verdict |
| --- | --- | --- | --- |
| 001 | [The Vote To Stay Blind](001-the-vote-to-stay-blind.md) | Abuse resistance | Stay request-blind; accept being knocked offline |

`build/` holds the rendered PDF. Regenerate it after editing the source:

```bash
python3 docs/field-notes/render.py           # markdown -> styled html
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf=docs/field-notes/build/cinder-field-note-001.pdf \
  file://$PWD/docs/field-notes/build/001.html
```
