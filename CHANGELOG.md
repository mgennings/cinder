# Changelog

All notable changes to Cinder are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] — 2026-07-27

Encrypted file transfer, with one promise Cinder can actually keep.

### Added

- **One-file transfer, up to 4 MiB.** Choose a file instead of a note. The bytes, the filename, and the MIME type are encrypted together in the browser as one AES-256-GCM envelope, so a stored object reveals its approximate size and nothing else.
- **Exactly one server delivery attempt.** A single atomic claim. Cinder deletes its own stored encrypted copy and verifies with S3 that the object is absent *before* any response byte exists — so receiving the bytes is itself proof the deletion already happened. Twenty simultaneous claims yield one body and nineteen byte-identical refusals.
- **An explicit, irreversible reveal.** The recipient sees exactly what pressing the button costs before they press it, including that a failed delivery is permanent and cannot be retried.
- **A transfer record on delivery.** A technical readout of what the server actually did. Every row is entailed by the response; none of it is decorative.
- **Constrained uploads.** Ciphertext goes straight to a private, non-versioned bucket through a five-minute presigned `PUT` signed against one random object key, an exact byte length, and an exact SHA-256. Finalize then inspects the stored object itself rather than trusting any client claim.
- **Separated least-privilege roles.** Create can write but not read, finalize can read but not delete or list, and only the claim function can delete.

### Changed

- **API CORS is now exact-origin** rather than `*`, and the stage throttles at 20 rps with a burst of 40.
- **The `/security` page and threat model** now cover the file promise, its permanent-loss cost, and what it still cannot control.

### Fixed

- **The delete-before-delivery proof was corrected before release.** Without `s3:ListBucket`, S3 answers a request for a missing object with `403` rather than `404`, which would have made the post-delete absence check unable to distinguish "the object is gone" from "I am not allowed to look."
- **A false privacy claim was removed.** Draft documentation said the finalize function could not read a stored object. AWS requires `s3:GetObject` alongside `s3:GetObjectAttributes`, so it can, and no S3 permission set can express otherwise. The claim was corrected rather than quietly dropped.

### Notes

- The 4 MiB ceiling is derived from the transport, not chosen: the buffered Lambda response is capped at 6 MB and travels base64, leaving about 11% headroom at that size. Response streaming would allow 200 MB but trades a structural guarantee for a behavioral one, so Cinder took the smaller number.

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
