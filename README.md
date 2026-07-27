<div align="center">

# Cinder

**An encrypted note or file retrieved once from Cinder. The server can't read it.**

[![Live](https://img.shields.io/badge/live-cinder.ink-ff6b4a)](https://cinder.ink)
[![Tests](https://img.shields.io/badge/tests-102%20passing-brightgreen)](#testing)
[![Crypto](https://img.shields.io/badge/crypto-AES--256--GCM-blue)](docs/crypto.md)
[![License](https://img.shields.io/badge/license-MIT-black)](LICENSE)

</div>

---

Cinder is a zero-knowledge, self-destructing note and file service. You write a note or choose a file, Cinder encrypts it in your browser, and hands you a single link. The first successful reader atomically removes Cinder's stored copy and receives the encrypted content. Cinder cannot erase copies someone already captured. The server that stores it can never read it. That last property is the entire point: this is a genuine privacy tool, not a demo that merely feels private.

Files make one additional promise, and it is deliberately narrow: **exactly one server delivery attempt**, up to 4 MiB. Cinder deletes its own stored encrypted copy and verifies the object is gone before any response byte exists, so receiving the bytes is itself proof the deletion already happened. Any failure after that claim permanently consumes the transfer — there is no retry, and the reveal screen says so before anyone presses the button. The filename and MIME type are encrypted alongside the bytes.

The bar was "the best one out there." Concretely that means clearing the bar the respected tools clear — client-side encryption with the key held only in the URL fragment — and doing it on real AWS infrastructure with an atomic, race-proof burn, wrapped in a UI that's a pleasure to use.

## Why Cinder is different

Most "private note" services encrypt on the server, which means the server holds the key and *can* read your note. Cinder never sees the key. Here is the honest comparison:

| Property | Typical "private note" site | Cinder |
| --- | --- | --- |
| Where encryption happens | On the server | In your browser |
| Who holds the decryption key | The server | Only the link (URL fragment) |
| Can the operator read what's stored? | Yes, technically | No — the key never reaches us |
| What "self-destruct" means | The server deletes it | Atomic delete-and-return: one successful server retrieval |
| Survives link-preview bots | Often no | Yes — human-gated reveal |
| Honest about its limits | Rarely | [Yes, explicitly](docs/security.md) |

## How it works

The trick is the URL fragment — everything after the `#`. Browsers keep it strictly on the device and never send it in an HTTP request. So a Cinder link like `cinder.ink/n/abc123#SECRETKEY` sends `abc123` to the server (which note) but keeps `SECRETKEY` on the device (how to decrypt it). The server stores ciphertext it cannot open.

```
┌─ Sender's browser ───────────┐                    ┌─ AWS ─────────────────────┐
│ 1. write note                │                    │                           │
│ 2. generate AES-256 key      │                    │  CloudFront → S3 (app)    │
│ 3. encrypt in-browser        │                    │                           │
│ 4. POST ciphertext ──────────┼──► API Gateway ──► Lambda ──► DynamoDB          │
│ 5. build link: /n/{id}#{key} │                    │      (ciphertext only)    │
│    └ key never leaves client │                    │                           │
└──────────────────────────────┘                    │                           │
                                                     │                           │
┌─ Reader's browser ───────────┐                    │                           │
│ opens /n/{id}#{key}          │                    │                           │
│ human clicks "Reveal" ───────┼──► API Gateway ──► Lambda ──► DynamoDB          │
│ ◄── ciphertext (now burned) ─┼────                │   atomic conditional      │
│ decrypt with key from #      │                    │   DeleteItem + ALL_OLD    │
│ read once — gone from Cinder │                    │                           │
└──────────────────────────────┘                    └───────────────────────────┘
```

The burn is a single atomic DynamoDB operation — a conditional `DeleteItem` that returns the item it deleted. One reader wins the delete and gets the note; anyone racing gets "already read." No locks, no read-then-delete gap. See [docs/architecture.md](docs/architecture.md) for the full walk-through.

## Quick start

**Prerequisites:**

- [Node.js](https://nodejs.org) 22 or newer
- [pnpm](https://pnpm.io) 11 or newer
- [Java](https://adoptium.net) 17+ (only for the local backend — runs DynamoDB Local, no Docker needed)

Clone and run the front end:

```bash
git clone https://github.com/mgennings/cinder.git
cd cinder
pnpm install
pnpm dev
```

That serves the app at `http://localhost:5173`. To run the full stack locally (so notes actually create and burn), see [docs/local-development.md](docs/local-development.md).

## Documentation

Cinder's docs are task-oriented — pick the one that matches what you want to do.

| I want to… | Read |
| --- | --- |
| Understand the whole system | [Architecture](docs/architecture.md) |
| Understand the encryption | [Crypto](docs/crypto.md) |
| Know exactly what this protects (and what it can't) | [Security & threat model](docs/security.md) |
| Run it on my machine end-to-end | [Local development](docs/local-development.md) |
| Deploy my own copy to AWS | [Deployment](docs/deployment.md) |
| Call the API directly | [API reference](docs/api.md) |
| Understand or extend the look | [Theme & design system](docs/theme.md) |
| Contribute | [Contributing](CONTRIBUTING.md) |

## Tech stack

| Layer | Choice | Why |
| --- | --- | --- |
| Front end | [SvelteKit](https://svelte.dev) 2 (Svelte 5) | Compiles the framework away — the smallest bundle is the smallest attack surface |
| Styling | [Tailwind](https://tailwindcss.com) 4 | Fast, consistent, no CSS drift |
| Crypto | Native [Web Crypto](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) | No third-party crypto dependency to trust or audit |
| API | AWS Lambda + API Gateway (HTTP API) | Serverless, zero idle cost |
| Storage | Amazon DynamoDB | Its conditional `DeleteItem` *is* the atomic burn |
| Delivery | Amazon S3 + CloudFront | Static, global, cheap |
| Infra as code | AWS SAM | One template describes the whole stack |

## Testing

102 tests across three layers, all green:

```bash
pnpm vitest run                    # 43 unit tests: crypto, codec, links, shipped claims
node --test api/test/*.mjs         # 51 API tests: burn, claim, race-safety, S3 error reading (needs DynamoDB Local)
pnpm exec playwright test          # 8 end-to-end tests in a real browser
```

The tests that matter most prove the security claims rather than the happy path:

- A tampered ciphertext fails to decrypt, and so does a tampered filename — both live inside the same authenticated envelope.
- An expired note or transfer is never served, even before DynamoDB's TTL sweep reaps it.
- Twenty concurrent claims on one file yield exactly one body and nineteen byte-identical refusals.
- The destructive path is broken at every seam — S3 open, delete, and the absence check — and each time the assertion is the same: no response byte ever existed, and the transfer stays permanently consumed.
- A delete that silently succeeds without deleting is caught by the absence check, which is the entire reason that check exists.
- The absence check refuses to accept a `403` as proof of deletion. Without `s3:ListBucket`, S3 answers a request for a missing object with `403` rather than `404`, and "I am not allowed to look" is not evidence that something is gone. Two deliberately different readings of the same S3 error live in `api/src/s3-errors.mjs`, and a test asserts they still disagree.
- In a real browser: arriving at a file link claims nothing, the reveal cannot be double-activated, a file over the ceiling never reaches the server, and the fragment key appears in no request URL or body.

## A word on honesty

Cinder removes the operator's ability to read your note. It cannot remove your responsibility to share the link carefully, and it cannot defend against a server that has been compromised to serve malicious JavaScript. Those limits are inherent to browser-delivered crypto, and Cinder states them plainly rather than pretending otherwise. Read the full, unhedged account in [docs/security.md](docs/security.md).

## License

[MIT](LICENSE) — do what you like, no warranty.
