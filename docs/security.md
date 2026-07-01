# Security & threat model

A privacy tool that oversells itself is worse than one that is honest. This document states plainly what Cinder protects, and — without hedging — what it cannot. The same account is presented in-app at [/security](https://cinder.ink/security).

## What Cinder protects

**Server-side exposure.** Encryption and decryption happen only in your browser. The server stores ciphertext, an IV, and (in passphrase mode) a salt — never the key, never the plaintext. See [Crypto](crypto.md) for the mechanism.

**Tampering.** AES-256-GCM is authenticated. If anyone alters the stored blob, decryption fails instead of returning altered content. A malicious server cannot forge a different message.

**A leaked stored blob.** Without the key from the link fragment, the stored ciphertext is useless. The key never reaches the server, so a database breach yields nothing readable.

## What Cinder cannot protect

These are real limits. Some are inherent to browser-delivered crypto and cannot be fixed by any amount of better engineering.

**A compromised server serving malicious JavaScript.** This is the fundamental limit. Because the same server that stores your note also ships the code that encrypts it, a compromised server could serve modified code that captures your note or key before encryption. "Zero-knowledge" holds only while the served code is honest, and no website can cryptographically prove that to you. Subresource Integrity and code review mitigate this; they do not eliminate it. Any tool that delivers crypto over the web shares this limitation, whether it admits it or not.

**Anyone who obtains the link.** The key lives in the link. Whoever holds the full link can read the note once. Send it over a channel you trust, and only to the person you mean.

**The link leaking through intermediaries.** A full link can land in browser history, browser sync, clipboard managers, chat backups, or any client-side script that reads `location.href`. Cinder runs no third-party analytics on the note routes for exactly this reason, but tools outside Cinder's control might still capture the URL.

**Metadata.** Cinder hides the contents of a note, not the fact that a note exists, its approximate size, or its timestamps.

**Weak passphrases.** Passphrase mode stretches your passphrase with 600,000 rounds of PBKDF2, which slows guessing — but a weak passphrase is still weak. An attacker with the ciphertext and salt can brute-force a low-entropy passphrase offline.

**A compromised device.** Malware, a malicious browser extension, or a shared machine can see the note the moment you decrypt it. No web app can defend against a compromised endpoint.

**A server that quietly keeps a copy.** "Self-destruct" is a promise the backend keeps by deleting the note, not a law of physics. Anyone who captured the ciphertext and the link before you opened it could still decrypt it. Cinder's backend deletes atomically and stores nothing else, but you are trusting that it does.

## The short version

Trust the link to a person, not to the internet. Cinder removes the operator's ability to read your note; it cannot remove your responsibility to share the link carefully.

## Reporting a vulnerability

If you find a security issue, please open a GitHub issue describing it, or contact the maintainer directly rather than disclosing publicly first. This is a personal project without a formal bounty, but genuine reports are genuinely appreciated.

## Related documents

- [Crypto](crypto.md) — the encryption scheme in detail
- [Architecture](architecture.md) — how the pieces fit together
