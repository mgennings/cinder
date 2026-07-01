<div align="center">

# Cinder

**A note that's read once, then gone. Encrypted in your browser — the server can't read it.**

[![Live](https://img.shields.io/badge/live-cinder.ink-ff6b4a)](https://cinder.ink)
[![Tests](https://img.shields.io/badge/tests-25%20passing-brightgreen)](#testing)
[![Crypto](https://img.shields.io/badge/crypto-AES--256--GCM-blue)](docs/crypto.md)
[![License](https://img.shields.io/badge/license-MIT-black)](LICENSE)

</div>

---

Cinder is a zero-knowledge, self-destructing note service. You write a note, Cinder encrypts it in your browser, and hands you a single link. The first person to open that link reads the note once — then it's gone, permanently, from everywhere. The server that stores the note can never read it. That last property is the entire point: this is a genuine privacy tool, not a demo that merely feels private.

The bar was "the best one out there." Concretely that means clearing the bar the respected tools clear — client-side encryption with the key held only in the URL fragment — and doing it on real AWS infrastructure with an atomic, race-proof burn, wrapped in a UI that's a pleasure to use.

## Why Cinder is different

Most "private note" services encrypt on the server, which means the server holds the key and *can* read your note. Cinder never sees the key. Here is the honest comparison:

| Property | Typical "private note" site | Cinder |
| --- | --- | --- |
| Where encryption happens | On the server | In your browser |
| Who holds the decryption key | The server | Only the link (URL fragment) |
| Can the operator read your note? | Yes, technically | No — it's mathematically impossible |
| What "self-destruct" means | The server deletes it | Atomic delete-and-return: exactly one reader, ever |
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
│ read once — then it's gone   │                    │                           │
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

25 tests across three layers, all green:

```bash
pnpm vitest run                    # 13 unit tests: crypto, codec, links
cd api && node --test test/*.mjs   # 10 API tests: burn, race-safety, validation (needs DynamoDB Local)
pnpm exec playwright test          # 2 end-to-end tests in a real browser
```

The tests that matter most prove the security claims: a tampered ciphertext fails to decrypt, an expired note is never served, and three concurrent readers of the same note yield exactly one winner.

## A word on honesty

Cinder removes the operator's ability to read your note. It cannot remove your responsibility to share the link carefully, and it cannot defend against a server that has been compromised to serve malicious JavaScript. Those limits are inherent to browser-delivered crypto, and Cinder states them plainly rather than pretending otherwise. Read the full, unhedged account in [docs/security.md](docs/security.md).

## License

[MIT](LICENSE) — do what you like, no warranty.
