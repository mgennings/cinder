# Changelog

All notable changes to Cinder are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] — 2026-07-01

The first working release: a zero-knowledge, self-destructing note service, live on AWS.

### Added

- **Zero-knowledge encryption.** Notes are encrypted in the browser with AES-256-GCM. The key lives only in the URL fragment and never reaches the server.
- **Atomic burn-on-read.** A single conditional DynamoDB `DeleteItem` guarantees exactly one successful server retrieval per note, with no race window. Expired notes are never served.
- **Two-factor passphrase mode.** An optional passphrase (PBKDF2-HMAC-SHA256, 600,000 iterations) layers on top of the link key, so a leaked link alone cannot open the note.
- **Bot-safe reveal.** The reader page fetches nothing until a human clicks, and the burn endpoint is POST-only, so link-preview crawlers cannot destroy a note.
- **Honest security page.** An in-app `/security` page and a companion doc state plainly what the tool protects and what it cannot.
- **AWS serverless stack.** API Gateway, two Lambdas, DynamoDB with TTL, and S3 + CloudFront, all defined in one AWS SAM template.
- **Custom domain.** Live at [cinder.ink](https://cinder.ink) over HTTPS.
- **Full documentation.** Architecture, crypto, security, API reference, local-development, and deployment guides.
- **25 tests** across unit, API, and end-to-end browser layers.

### Notes

- The product is branded **Cinder**; `blip` remains the repository slug and the parking subdomain for now.
