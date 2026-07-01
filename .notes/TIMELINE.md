# blip — timeline

- **2026-07-01** — Brainstormed and locked the design: zero-knowledge, atomic burn-on-read, AWS SAM, SvelteKit static, two-factor passphrase. Spec + plan written and approved by Matt (yolo + "bypass rules this once" grants full autonomy incl. live deploy).
- **2026-07-01** — GitHub repo `mgennings/blip` created (private), Notion "🔥 blip — Project Hub" created under Master Hub.
- **2026-07-01** — Built Tasks 0–9: scaffold, codec, crypto (AES-GCM + PBKDF2 two-factor), DynamoDB store (atomic burn verified against DynamoDB Local), Lambda handlers, SAM template (validated + built), SvelteKit UI (create / human-gated reveal / burn), security page (prerendered, honest threat model). 25 tests green (13 unit + 10 api + 2 e2e).
- **Next** — live AWS deploy (backend via `sam deploy`, then S3 + CloudFront front end).
