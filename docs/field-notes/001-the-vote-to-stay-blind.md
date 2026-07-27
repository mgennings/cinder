# Field Note 001 — The Vote To Stay Blind

**Decision gate:** Cinder / abuse resistance
**Date:** 2026-07-27
**Verdict:** Stay request-blind. Accept being knocked offline.
**Vote:** 12 of 12, unanimous.

---

## In plain words

Cinder does one thing. You give it a file, it locks the file in your own browser before anything leaves your computer, and it hands you a link. The first person to open that link gets the file, and Cinder erases its copy in the same breath. Cinder never holds the key, so it could not read your file even if someone made it try.

Someone asked a fair question: what happens if a stranger floods it with traffic? That costs money, and it can knock the service offline.

The normal way to stop that is to have the service watch where every request is coming from and turn away anyone asking too often. It is what nearly every website does. It is cheap and it works.

But watching where requests come from means keeping a note of who is asking. For a tool whose entire purpose is not knowing who you are, that is not a small thing. It is the thing.

So we measured instead of assuming, and found two facts that settled it.

The first: the defense would not have worked here anyway. Someone determined could take Cinder offline from a single laptop, and spreading the same traffic across twenty connections slips under any limit gentle enough not to hurt real people.

The second: that kind of limit hurts real people first. It works by address, and enormous numbers of people share one — everyone on a phone network, everyone at a school or a library, everyone using a VPN. Many of them use a VPN precisely because they need privacy. A privacy tool that shuts out the people who most need privacy has protected no one.

So Cinder chose to stay blind. Under a flood it slows down and turns people away, and it does that by simply running out of room rather than by recognizing anybody. Nothing is lost when this happens: a request that gets turned away never reaches the part that erases your file, so your link still works once the flood passes. The honest cost is that Cinder can be pushed offline. We decided we would rather be knocked down than start keeping track of people.

**One more thing, and it is the uncomfortable part.** While checking all this, we found that Cinder had been lying. When it was too busy to start, it told people their file had been permanently destroyed — while the file sat there, perfectly fine. Worse, the protection added that same morning made the false message happen more often. We had built something that generated a lie about the one promise the product exists to keep. That is fixed, and it is written down here rather than quietly patched, because a tool that asks you to trust it does not get to hide its own mistakes.

---

## Why this document is also the test

The PDF you are reading was sent through Cinder before it was published. Not a stand-in, not a test file: this exact document, through the live product, the same way a stranger would.

That practice has a name — **dogfooding**, using your own product for real work instead of only testing it. It matters because of something that happened here, and the lesson is worth more than the decision above.

Cinder's tests compared files before and after and confirmed they matched perfectly. Every one passed. But the files those tests used were made up — long runs of predictable filler, named to look like documents. A file like that can survive a round trip flawlessly and prove almost nothing, because it was never a real document to begin with. It has no structure to break.

The gap showed up the moment a real one was tried. A file arrived that would not open, and it looked like Cinder had corrupted it. It had not: the file had been empty filler all along, and Cinder returned it exactly as received, faithfully preserving something that was already broken. The tests were right and useless at the same time.

**Matching before and after is not the same as working.** A test that only asks "did the bytes survive" can pass forever while the product fails the person holding the file. The only reliable check is to send the real thing and then open it — which is why this document went through Cinder, and why the technical record below lists real files of each kind rather than generated stand-ins.

---

## The technical record

Everything below is measured against the live production system, not a local copy or a simulation.

### The promise being defended

Exactly one server delivery attempt per link, up to 4 MiB. Not one recipient and not a guaranteed download, because a server cannot observe either. Bytes, filename, and MIME type are encrypted in the browser with AES-256-GCM into one authenticated envelope; the key lives only in the URL fragment and is never transmitted. Before any response byte exists, the stored object is deleted and its absence verified — so receiving the bytes entails the deletion already happened. The transport is a fully buffered proxy integration with no streaming path, which makes that ordering structural rather than sequenced.

### The option that was rejected, and its real cost

A managed firewall with a rate-based rule. Four properties, none of them prominent in the documentation:

| Mechanism | What it retains |
| --- | --- |
| Request sampling | Client IP, full request path, and headers on a rolling 3-hour window. It is a **required** field defaulting to on, and is **not** governed by the logging configuration. The note-burn route carries the note's primary key in the path, so each sample is a `(who, what, when)` tuple. |
| Rate-based managed keys | Up to 10,000 client addresses currently being limited, retrievable through a public API whenever aggregation is by IP. |
| Firewall metrics | `Country` (GeoIP-derived) and `Device` (user-agent-derived) dimensions at 15-month retention. |
| Coverage gap | Uploads go browser-to-storage through a pre-signed authorization, structurally bypassing the edge on the only route that moves megabytes. |

### The measurements that decided it

Two reviewers ran load against production independently.

```
40 concurrent claims        → exactly 10 × 200, 30 × 503
warm service time           ≈ 165 ms
10 slots ÷ 0.165 s          ≈ 61 req/s sustains total denial, from one machine
request cost                < 200 bytes
```

And during the flood:

```
Throttles 286 · Invocations 27 · Errors 0
ConcurrentExecutions Maximum = 10.0 exactly
```

A shed request never enters the function. It reads no record, writes no log line, and never reaches the conditional delete — so a flood denies delivery but cannot consume a transfer. That is a provable negative. Per-IP counters inside a managed firewall are not: their emptiness is a claim about a third party's internals that neither a user nor the operator can verify.

Second measurement, which removed the last argument for the firewall: ~60 req/s distributed across ~20 addresses defeats any threshold humane enough to avoid blocking shared egress. **The control would have purchased the surveillance without the protection.**

### Four claims that did not survive audit

| Claim | Reality |
| --- | --- |
| The finalize role cannot read a stored object | `GetObjectAttributes` requires `s3:GetObject`. No permission set expresses "metadata but never the body". |
| Subresource Integrity mitigates the served-code risk | Not deployed, and useless on a first-party origin — whoever can alter the bundle can alter the integrity attribute beside it. |
| Stage throttling resists locator grinding | Measured: 600 requests admitted in 0.59 s against a configured burst of 40. Entropy defeats guessing; the throttle does not. |
| Reserved concurrency bounds the bill at ~$14/day | That figure is Lambda compute only. It bounds neither gateway requests, nor database writes, nor storage from abandoned uploads. |

### The defect the audit found in our own work

The client mapped every non-`410` refusal to a permanent-destruction state. A `429` or `503` is produced before the function is invoked, so the atomic claim never ran and the object was untouched. The interface asserted a destruction the code had not performed, and reserved concurrency — added hours earlier as a protection — increased its frequency.

Now: gateway-level refusals (`429`, `502`, `503`, `504`) render a recoverable *busy* state; a `500` still renders as spent, because the handler ran and may have thrown after the claim; and an ambiguous network failure resolves toward *busy* deliberately, since if the transfer really was consumed the retry returns `410` and corrects itself. The kinder wrong answer is the self-correcting one.

### What shipped instead

Per-function reserved concurrency of 10 (a boundary that sheds by exhaustion, never by identity); a CloudWatch alarm on shed deliveries so the outage is not silent; a monthly cost guard; object keys banded by lifetime so a one-hour transfer's ciphertext is swept the next day rather than the eighth; and log retention pinned in infrastructure code rather than left at the default of forever.

### Media validated end to end

Real files of each kind, through the live product, opened after arrival — not synthetic fixtures.

| Type | Fixture |
| --- | --- |
| PDF | This document |
| Image | PNG, 1200 × 630, 16-bit RGBA |
| Video | MP4, H.264, ISO Base Media |

### The transferable principle

**A refusal is not a destruction.** Any system with an irreversible operation must distinguish "we declined to start" from "we started and failed." Collapsing them is how software ends up lying about the one thing it promised.

**Prefer the guarantee whose shape makes the failure impossible.** Structural properties beat configured ones. A buffered response cannot leak early because there is no stream to write to. A concurrency cap cannot profile because it has nowhere to put a profile.

**A control's data appetite is part of its price**, and it is rarely on the label. Read what the mechanism retains, not what its logging toggle claims.

**Audit the protection you just shipped.** The most damaging finding here was not among the options being weighed. It was in the mitigation added hours earlier.

**Byte-identical is not the same as usable.** Verify with real artifacts, and open them afterward.

---

*Cinder is open source. The measurements, the corrections, and the code that makes these claims true are all public — including the four claims that were wrong before they were right.*
