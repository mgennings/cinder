# Crypto

This document describes exactly how Cinder encrypts your notes. Every parameter here is verified against current MDN and OWASP guidance. If you want the honest limits of this scheme rather than the mechanics, read [Security & threat model](security.md).

## The short version

Cinder uses **AES-256-GCM**, the browser's native authenticated encryption. A fresh random key and a fresh random IV are generated for every note. The key is base64url-encoded and placed in the URL fragment; it never reaches the server. Optionally, a passphrase adds a second factor via PBKDF2.

All of this runs in `src/lib/crypto/note-crypto.ts` using the standard [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) — there is no third-party crypto dependency.

## Default mode (random key)

| Parameter | Value | Why |
| --- | --- | --- |
| Algorithm | AES-GCM | Authenticated — a tampered ciphertext fails to decrypt rather than returning garbage |
| Key length | 256 bits | Strongest standard AES key |
| IV / nonce | 96 bits (12 bytes), random per note | GCM's recommended IV size; unique per encryption is mandatory |
| Auth tag | 128 bits (default) | Detects any modification to the ciphertext |
| Key transport | base64url in the URL fragment | The fragment never leaves the browser |

The flow:

1. `crypto.getRandomValues` produces a 256-bit key and a 96-bit IV.
2. `crypto.subtle.encrypt` encrypts the note. The 128-bit authentication tag is appended to the ciphertext automatically.
3. The key is exported raw, base64url-encoded (no padding), and becomes the fragment.
4. The server receives only `{ ciphertext, iv }`, both base64.

> **Note:** The IV is not secret — only unique. It travels alongside the ciphertext in plain form. What must stay secret is the key, and that stays in the fragment.

## Two-factor passphrase mode

When you add a passphrase, the note is protected by **both** the random key in the link **and** the passphrase. An attacker needs both to read it — a leaked link alone is not enough.

| Parameter | Value | Why |
| --- | --- | --- |
| KDF | PBKDF2-HMAC-SHA256 | OWASP's recommended password-based KDF for the browser |
| Iterations | 600,000 | OWASP-current cost factor for PBKDF2-HMAC-SHA256 |
| Salt | 128 bits (16 bytes), random per note | Prevents precomputation; stored alongside the ciphertext |

How the two factors combine: the passphrase is stretched with PBKDF2 into 256 bits, and those bits are XORed into the random key before encryption. Because both inputs are required to reconstruct the actual AES key, neither the link nor the passphrase is sufficient on its own.

> **Warning:** PBKDF2 slows down guessing; it does not make a weak passphrase safe. A short or common passphrase can still be brute-forced offline by anyone who holds the ciphertext and salt. Choose a passphrase with real entropy.

## Encoding

Binary data (keys, IVs, ciphertext, salt) has to survive JSON transport and a URL. Cinder uses the native `Uint8Array.toBase64()` / `fromBase64()` methods with the `base64url` alphabet for the fragment and standard base64 for the JSON body.

These methods are Baseline 2025 (available since September 2025). For older browsers, `src/lib/crypto/codec.ts` feature-detects and falls back to a `btoa`/`atob` bridge with manual base64url character substitution. Notes are short text, so the fallback's performance considerations do not apply in practice.

> **Note:** `btoa`/`atob` cannot handle raw binary above code point `0x7f`, which random key and ciphertext bytes routinely exceed. That is why the codec uses the byte-array methods first and only falls back deliberately — never `btoa(String.fromCharCode(...))` on unbounded binary.

## What integrity buys you

Because AES-GCM is authenticated, a malicious or buggy server cannot silently alter your note. If the stored ciphertext, IV, or salt is changed by even one bit, decryption throws instead of returning altered text. The reader sees an error, not a forged message. This is why GCM was chosen over an unauthenticated AES mode.

## Related documents

- [Architecture](architecture.md) — where crypto fits in the whole system
- [Security & threat model](security.md) — the honest limits of browser-delivered crypto
