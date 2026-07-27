# Security & threat model

A privacy tool that oversells itself is worse than one that is honest. This document states plainly what Cinder protects, and — without hedging — what it cannot. The same account is presented in-app at [/security](https://cinder.ink/security).

## What Cinder protects

**Server-side exposure.** Encryption and decryption happen only in your browser. The server stores ciphertext, an IV, and (in passphrase mode) a salt — never the key, never the plaintext. See [Crypto](crypto.md) for the mechanism.

**Tampering.** AES-256-GCM is authenticated. If anyone alters the stored blob, decryption fails instead of returning altered content. A malicious server cannot forge a different message.

**A leaked stored blob.** Without the key from the link fragment, the stored ciphertext is useless. The key never reaches the server, so a database breach yields nothing readable.

## Sending a file

A file transfer makes a narrower promise than a note, and the difference is worth stating exactly.

**The promise is one server delivery attempt.** Not one recipient, not one download, not one reader. Cinder allows a single atomic claim on a transfer, and before any byte of the response exists it deletes its own stored encrypted copy and confirms with S3 that the object is gone. Because the response is fully buffered, receiving the bytes is itself proof that the deletion and the absence check both already succeeded — the guarantee is a property of the transport's shape rather than of careful sequencing. The mechanism is documented in [architecture](architecture.md#why-the-delete-before-delivery-guarantee-actually-holds).

**A failed delivery is permanent, by design.** If the connection drops after the claim — at byte zero or midstream — Cinder has already deleted its copy and will not recreate it. There is no retry, no resume, and no second attempt. This is the price of the guarantee above rather than a bug in it, and the reveal screen says so before anyone presses the button.

**The filename and MIME type are encrypted.** They live inside the same AES-256-GCM envelope as the bytes, not beside it. A stored object reveals its exact byte length and nothing else — and because ciphertext is the plaintext plus a fixed-size envelope, that length gives away the original file's size to within a few bytes. "severance-agreement.pdf" is frequently the whole secret, and a design that authenticated the filename while leaving it readable would be protecting the wrong half.

**The stored ciphertext is unreachable except through that one path.** The bucket is private, non-versioned, and blocks all public access; there is no presigned `GET`, no redirect, no Range request, and no public path. Each of the three functions holds only what it needs: create can write but not read, finalize can read but not delete or list, and only the claim function can delete. Only the claim function can list, and it holds that permission for one reason — without `s3:ListBucket`, S3 answers a request for a missing object with `403` instead of `404`, and the post-delete absence check would be unable to tell "the object is gone" from "I am not allowed to look."

An earlier draft of this document claimed the finalize function could not read the object it approves. That was wrong: AWS requires `s3:GetObject` alongside `s3:GetObjectAttributes`, so no S3 permission set can express "metadata but never the body." The claim is corrected here rather than quietly dropped. In practice it changes little — the stored object is ciphertext, and the key has never been on any server — but a privacy tool does not get to leave a flattering inaccuracy standing.

**Deliberately not versioned.** Object versioning would quietly retain a copy of the thing Cinder just promised to destroy.

**What it still cannot do.** Copies saved by the sender, the recipient, a browser, an operating system, or another service remain outside Cinder's control. Deleting its own stored copy is the only deletion any server can honestly promise, and everything below in this document applies to files exactly as it applies to notes.

**An unclaimed transfer's stored copy can outlive its expiry.** The expiry you choose governs *availability* exactly: past it, the server refuses to deliver, immediately and unconditionally. Actual removal of the stored bytes is a separate, slower process. The DynamoDB grant is swept by TTL within roughly two days, and the S3 object by a flat eight-day lifecycle rule counted from upload, not from your chosen expiry. So a one-hour transfer that is never claimed becomes unreadable in one hour and is physically deleted within eight days. A *claimed* transfer is different: its object is deleted synchronously, during the delivery, and that deletion is verified before any byte is sent.

**Size ceiling.** 4 MiB, derived from the transport rather than chosen: the buffered response is capped at 6 MB and travels base64, leaving about 11% headroom at that size. Raising it would mean changing the transport and re-proving the deletion guarantee.

## What Cinder cannot protect

These are real limits. Some are inherent to browser-delivered crypto and cannot be fixed by any amount of better engineering.

**A compromised server serving malicious JavaScript.** This is the fundamental limit. Because the same server that stores your note also ships the code that encrypts it, a compromised server could serve modified code that captures your note or key before encryption. "Zero-knowledge" holds only while the served code is honest, and no website can cryptographically prove that to you. Any tool that delivers crypto over the web shares this limitation, whether it admits it or not.

An earlier version of this paragraph offered Subresource Integrity as a mitigation. That was wrong twice over: SRI is not deployed here, and it would not help if it were. SRI protects you from a compromised *third-party* CDN by letting the first-party page pin what it expects. Cinder serves its own bundles, so an attacker who can change the JavaScript can change the `integrity` attribute in the same breath. What is actually deployed is a strict Content-Security-Policy that permits scripts only from Cinder's own origin and blocks inline injection, plus a published, auditable source tree — neither of which defends against Cinder itself. The honest summary is that this limit is real and unmitigated by anything technical: it rests on the operator, which is why the rest of this page exists.

This also means the risk is not only "compromised." A dishonest operator has exactly the same capability without anyone breaking in.

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
