# Field Note 001 — The Vote To Stay Blind

**Decision gate:** Cinder / abuse resistance
**Date:** 2026-07-27
**Verdict:** Stay request-blind. Accept being knocked offline.
**Vote:** 12 of 12, unanimous.

---

## The gate

A privacy tool was asked to defend itself, and the only defenses on offer required it to start looking at who its users were. Twelve independent reviews, each measuring a different surface, arrived at the same answer without conferring: **refuse the protection.**

This note records what was measured, what it cost, and why the answer generalizes past this one product.

---

## What was at stake

Cinder transfers one encrypted file, once. The browser encrypts the bytes, the filename, and the file type; the key lives only in the URL fragment and never touches a server. The promise is narrow on purpose: **exactly one server delivery attempt.** Not one recipient, not one download. Before any response byte exists, Cinder deletes its stored copy and confirms with the storage layer that the object is gone — so holding the bytes is itself the proof that the deletion already happened.

Two promises sit underneath every product here. Nothing a user does is collected or tied to them, ever. And every surface works for the person using assistive technology, at the size and pace their body needs. They are one commitment: the user's dignity.

The question that forced the gate: **a flood of traffic costs money and takes the product down. What do we do about it?**

---

## The options, and the hidden price

The standard answer is a web application firewall with a rate limit — count requests per address, refuse the ones over the line. It is the default recommendation everywhere, and it is nearly free.

Reading it closely produced four facts that are not in the marketing:

**The counter is a registry.** A rate-based rule keyed on client address exposes an API that returns the list of addresses currently being limited — up to ten thousand of them.

**"Turn logging off" does not turn the recording off.** Request sampling is a separate, *required* setting that defaults to on. It retains client address, full request path, and headers on a rolling three-hour window, independent of whether logging is configured. Cinder's note-burn route carries the note's primary key in the path. Every sample would have been a `(who, what, when)` tuple — the exact record the product exists to not have.

**Metrics are a population profile.** Firewall metrics carry country, derived from address, and device, derived from user agent, at fifteen-month retention. Nothing resembling that exists today.

**And it would not have covered the expensive path anyway.** Uploads go from the browser directly to storage through a pre-signed authorization. The edge is bypassed structurally on the one route that moves megabytes.

---

## The measurement that decided it

Two seats ran load against production independently.

Forty simultaneous delivery requests returned **exactly ten served and thirty shed**. Warm service time was about 165 milliseconds. That arithmetic is unforgiving: ten slots divided by 0.165 seconds means roughly **sixty requests per second from a single machine holds every slot and denies delivery to everyone**, at under two hundred bytes per request. Effectively free. No botnet.

So the cost cap that had been shipped that morning to *protect* the product was also a lever to take it down.

The instinct is to reach for the rate limit. The second measurement killed that: sixty requests per second split across twenty addresses defeats any humane threshold against a ten-slot pool. **The firewall would have bought the surveillance and not the protection.**

That is the whole decision. The choice was never "protected or unprotected." It was **"vulnerable and blind" versus "vulnerable and watching."**

---

## The redeeming property, and why it is provable

One measurement changed the character of the answer.

During the flood: `Throttles 286, Invocations 27, Errors 0`. A shed request **never enters the function**. It reads no record, writes no log line, and — critically — never reaches the atomic claim that destroys a transfer. The flood denies delivery. It cannot consume anyone's file.

This is the part worth carrying elsewhere. A concurrency cap sheds by *"no worker is free."* A rate limit sheds by *"I recognize you."* Both refuse requests. Only one of them can be proven to have learned nothing, because the mechanism has no place to put the knowledge.

"We turned the logging off" is a claim about someone else's internals that no user can check and the operator cannot fully verify either. "The request never ran" is a structural fact with a counter attached. **For a product whose entire value is a promise, prefer the guarantee whose shape makes the failure impossible over the one that depends on a setting staying flipped.**

---

## What we found on the way in

The review did not only evaluate the options. It audited what was already shipped, and the worst finding was ours.

Every refusal that was not a clean "already gone" rendered to the user as: *"The delivery began but could not finish. Cinder's stored copy was already deleted. This cannot be retried."*

But a shed request never reaches the code. The file was sitting untouched in storage. **The product was telling people their file had been permanently destroyed when it demonstrably had not been** — and the cost cap shipped that morning made that message *more* frequent, not less. A protection had manufactured a lie.

The fix is now the only recoverable state in the product: a refusal says *nothing was used up, this link still works, try again.* Ambiguous failures resolve toward "busy" deliberately, because if the transfer really was spent, the retry returns "gone" and tells the truth by itself. **The kinder wrong answer is also the self-correcting one.**

Three other claims did not survive the same audit: that a function could not read what it approved (the cloud provider requires the broader permission — no configuration can express the narrower one); that Subresource Integrity mitigated the served-code risk (not deployed, and useless on a first-party origin, since whoever can change the script can change the hash beside it); and that the gateway's rate limit resisted anything (measured: six hundred requests admitted in 0.59 seconds against a configured burst of forty).

Each was confidently written and wrong. Each is now corrected in public, in the same words that got it wrong.

---

## What it cost

This is not a free choice and should not be presented as one.

A determined flood can hold every slot and make real people see *"Cinder is busy"* instead of their file. Roughly sixty requests per second does it. Cinder has no account, no appeal, and no support channel — so there is nobody to complain to.

Cinder accepts being knocked offline in exchange for never building a record of who its users are. That is the trade, stated where users can read it. The alternative was a rate limit that falls hardest on shared addresses — carrier networks, universities, libraries, Tor, and the VPNs that at-risk people use precisely because they need them. **A privacy tool that locks out the people who need privacy most has not protected anyone.**

What shipped instead collects nothing: a cap that sheds without looking, an alarm that counts refusals so the outage is not silent, a cost guard, storage keys banded by lifetime so a one-hour transfer's bytes are swept the next day instead of the eighth, and log retention pinned in code rather than left at "forever."

---

## The transferable principle

Four things, in the order they were learned:

**A refusal is not a destruction.** Any system with an irreversible operation must distinguish *"we declined to start"* from *"we started and it failed."* Collapsing them is how software ends up lying about the one thing it promised. Check every error path that renders a permanent consequence and ask what actually reached the code.

**Prefer the guarantee whose shape makes the failure impossible.** Structural properties beat configured ones. A buffered response cannot leak early because there is no stream to write to. A concurrency cap cannot profile because it has nowhere to store a profile.

**A security control's data appetite is part of its price.** It is rarely on the label. Read what the mechanism *retains*, not what its logging toggle claims, and ask whether the thing it protects is worth the thing it now knows.

**Audit the protection you just shipped.** The most damaging finding here was not in the options under consideration. It was in the mitigation added hours earlier, which had quietly turned the product into something that told people their files were gone when they were not.

---

*Cinder is open source. The measurements, the corrections, and the code that makes these claims true are all public — including the three claims that were wrong before they were right.*
