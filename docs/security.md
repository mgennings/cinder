# Security & threat model

A privacy tool that oversells itself is worse than one that is honest. This document states plainly what Cinder protects, and — without hedging — what it cannot. The same account is presented in-app at [/security](https://cinder.ink/security).

## What Cinder protects

**Server-side exposure.** Encryption and decryption happen only in your browser. The server stores ciphertext, an IV, and (in passphrase mode) a salt — never the key, never the plaintext. See [Crypto](crypto.md) for the mechanism.

**Tampering.** AES-256-GCM is authenticated. If anyone alters the stored blob, decryption fails instead of returning altered content. A malicious server cannot forge a different message.

**A leaked stored blob.** Without the key from the link fragment, the stored ciphertext is useless. The key never reaches the server, so a database breach yields nothing readable.

## Sending a file

A file transfer makes a narrower promise than a note, and the difference is worth stating exactly.

**The promise is one server delivery attempt.** Not one recipient, not one download, not one reader. Cinder allows a single atomic claim on a transfer, and before any byte of the response exists it deletes its own stored encrypted copy and confirms with S3 that the object is gone. Because the response is fully buffered, receiving the bytes is itself proof that the deletion and the absence check both already succeeded — the guarantee is a property of the transport's shape rather than of careful sequencing. The mechanism is documented in [architecture](architecture.md#why-the-delete-before-delivery-guarantee-actually-holds).

**The sending browser may check current availability.** Creating a file returns a second, separately signed status capability that stays only in that browser's local storage and expires with the transfer. It is not part of the recipient link. When that same browser revisits the link, a read-only Lambda with only `dynamodb:GetItem` returns `available` or `gone`; it cannot claim, write, read S3, or learn an identity. No timestamp is stored or returned, but repeated checks can infer the interval in which availability changed. That is the deliberate observability cost of giving the sender a glanceable status.

**A failed delivery is permanent, by design.** If the connection drops after the claim — at byte zero or midstream — Cinder has already deleted its copy and will not recreate it. There is no retry, no resume, and no second attempt. This is the price of the guarantee above rather than a bug in it, and the reveal screen says so before anyone presses the button.

**The filename and MIME type are encrypted.** They live inside the same AES-256-GCM envelope as the bytes, not beside it. A stored object reveals its exact byte length and nothing else — and because ciphertext is the plaintext plus a fixed-size envelope, that length gives away the original file's size to within a few bytes. "severance-agreement.pdf" is frequently the whole secret, and a design that authenticated the filename while leaving it readable would be protecting the wrong half.

**The stored ciphertext is unreachable except through that one path.** The bucket is private, non-versioned, and blocks all public access; there is no presigned `GET`, no redirect, no Range request, and no public path. Each of the three functions holds only what it needs: create can write but not read, finalize can read but not delete or list, and only the claim function can delete. Only the claim function can list, and it holds that permission for one reason — without `s3:ListBucket`, S3 answers a request for a missing object with `403` instead of `404`, and the post-delete absence check would be unable to tell "the object is gone" from "I am not allowed to look."

An earlier draft of this document claimed the finalize function could not read the object it approves. That was wrong: AWS requires `s3:GetObject` alongside `s3:GetObjectAttributes`, so no S3 permission set can express "metadata but never the body." The claim is corrected here rather than quietly dropped. In practice it changes little — the stored object is ciphertext, and the key has never been on any server — but a privacy tool does not get to leave a flattering inaccuracy standing.

**Deliberately not versioned.** Object versioning would quietly retain a copy of the thing Cinder just promised to destroy.

**What it still cannot do.** Copies saved by the sender, the recipient, a browser, an operating system, or another service remain outside Cinder's control. Deleting its own stored copy is the only deletion any server can honestly promise, and everything below in this document applies to files exactly as it applies to notes.

**An unclaimed transfer's stored copy can outlive its expiry.** The expiry you choose governs *availability* exactly: past it, the server refuses to deliver, immediately and unconditionally. Actual removal of the stored bytes is a separate, slower process. The DynamoDB grant is swept by TTL within roughly two days. The encrypted object is swept by a lifecycle rule in one of two bands: transfers set to a day or less are removed the next day, longer ones within eight days. So a one-hour transfer that is never claimed becomes unreadable in one hour and is physically deleted within a day. A *claimed* transfer is different: its object is deleted synchronously, during the delivery, and that deletion is verified before any byte is sent.

**A ciphertext object can briefly outlive the grant that pointed at it.** Two ways. If a sender abandons an upload, or a short grant is swept before its object's band comes due, the encrypted bytes remain with nothing referencing them until the lifecycle rule collects them. And more surprisingly: the upload authorization Cinder issues is valid for five minutes on a clock, and S3 provides no way to revoke one early. If a sender re-used their own upload authorization inside that window *after* the transfer had already been claimed and destroyed, the original ciphertext would be written back and then sit until its band expired. The signature pins the exact length and checksum, so nothing other than those same bytes can be placed there, and the grant is gone so nothing can retrieve them — but it means Cinder's deletion is verified at the moment of delivery rather than guaranteed forever after. Only the sender can do this, and the sender already holds the plaintext.

**Under load, Cinder stops working rather than leaking.** Every function is capped at ten simultaneous executions. That bounds what a flood can cost, and it bounds it by refusing work rather than by inspecting who is asking — a shed request never reaches Cinder's code, so it reads nothing and writes nothing. The honest cost of that choice: a determined flood can hold those slots and make real people see "Cinder is busy" instead of their file. Measured, that takes roughly sixty requests a second from a single machine. Cinder accepts being knocked offline in exchange for never building a record of who its users are. Nothing is destroyed when this happens — a refused request never runs the delete — and the link keeps working once the flood stops.

**Size ceiling.** 4 MiB per object, derived from the transport rather than chosen: the buffered response is capped at 6 MB and travels base64, leaving about 11% headroom at that size. Raising it would mean changing the transport and re-proving the deletion guarantee, so it has not been raised.

**Larger files are more objects, not bigger ones.** Above 4 MiB a file is split into parts of at most 4 MiB, each its own encrypted envelope with its own single delivery attempt. The per-object promise is unchanged at any total size because it is the same code — `finalizeFile` and `claimFile` were not modified to support this. The ceiling on a whole transfer is 64 parts (256 MiB), and that number is memory-bound: a recipient holds every part in one tab while reassembling, and a tab killed mid-delivery is a permanently destroyed file.

**One failed part destroys the whole transfer.** Parts are claimed in order and each is deleted before it is handed over, so a failure at part 5 of 12 leaves five parts already destroyed and no way to assemble the file. There is no retry and no resume, because a resume would require a second delivery attempt for an object Cinder has deleted. Unclaimed parts are abandoned to the same lifecycle sweep that collects a cancelled upload's orphan. The reveal screen states the part count and this exact consequence before the recipient presses anything.

**Paying does not widen what Cinder can see.** The capability gate runs on the create path only, never on finalize or claim — a recipient never needs an account to receive what a sender already paid to send. And identity lives on a separate HTTP API: the transfer API's CORS configuration allows only `content-type`, so a browser cannot attach an account token to a transfer request even by accident. What a large send presents is an opaque grant carried in the request body that names a capability and no subject. `api/src/capabilities.mjs` enforces this in its signature rather than in a comment: the gate is handed a grant string and a capability name, and is never handed the request, so it cannot reach for a header or an address.

## Sending a video

A video makes a **different promise from a file, stated as its own thing and never blended with it**. The file promise — exactly one server delivery attempt, burn verified before the first response byte — does not transfer to a 500 MB video, because a real watch involves buffering, a dropped connection, and a rewatch of the part that mattered. A single atomic delivery would let a flaky connection permanently destroy the one chance to see it, which fails exactly the person the feature exists for. So video promises something else, and this section says precisely what.

**The promise is a watch window, not a copy.** The recipient claims the video by a human action, and the claim opens a window with a server-side deadline. Inside the window they can watch, lose connection, come back, and rewatch. Past the deadline, no segment is ever served again — the at-read refusal is immediate and unconditional, the same availability guarantee as everywhere else in Cinder — and a one-shot scheduled deletion removes every stored object within about a minute, with the standing lifecycle rule as the backstop for anything a crash orphaned. There is no download button, no keepable link, and no way to reopen the link after the window closes.

**The server still stores only ciphertext.** The sender's browser splits the video into segments of at most 4 MiB and encrypts each in its own AES-256-GCM envelope — the same shape as chunked file parts — with a key that lives only in the URL fragment. Up to 128 segments, 512 MiB. Cinder never sees the video, its name, or the key.

**Video ciphertext flows through presigned GETs, and this is a deliberate, confined departure.** The file path forbids presigned GETs because its promise needs delivery and deletion to be one atomic act inside the Lambda. A video needs resumable ranged reads of up to 512 MiB, which the 6 MB buffered Lambda response cannot carry. So while a watch session is open, the session endpoint issues short-lived (8-minute) presigned GETs for individual segments, and the recipient's browser reads the ciphertext from S3 directly. The departure is confined to video objects: they live under their own `v/` key prefix, the GET-signing role is scoped to that prefix alone, and the file bucket's no-presigned-GET stance is unchanged. What crosses the wire is the same thing in both designs — bytes nobody but the link holder can open.

**The enforced guarantee is the window's ceiling; the countdown is the experience.** "Watched fully" is something only the recipient's browser can see, because Cinder cannot observe playback of ciphertext it cannot read. The client's finished signal *shortens* the server deadline to eight more minutes; a recipient who suppresses that signal keeps the video only until the window's hard ceiling — 64 minutes from claim, extensible by 8 minutes per credit to an absolute cap of 128 minutes. The visible countdown always renders the server's real deadline, never a theatrical number.

**Declining is free and invisible.** Declining at the gate destroys the video unwatched. The sender's status view collapses claimed, watched, declined, extended, expired, and destroyed into one word — "gone" — with no timestamp, so declining carries no social penalty the sender can measure.

**Extending never identifies anyone.** An extension is funded by sender-prepaid taps (no account, no card) or by a capability grant minted on the separate identity API. The grant names a capability and no subject, exactly like a paid send, so neither sending nor extending links a person to a transfer.

**What video cannot promise, said here as it is said on the surface:** nothing on the web can stop a screen recording or a second phone pointed at the screen, and Cinder will not pretend otherwise. The decrypted local copy the recipient's browser holds during the window is discarded when the window ends or the tab closes, and that discard is best-effort client behavior, never claimed as a guarantee. What Cinder promises is that its own stored copy is destroyed on schedule and that no copy exists unless someone chooses to make one.

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
