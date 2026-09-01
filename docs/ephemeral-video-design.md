# Ephemeral video — design and user stories

Design doc, 2026-09-01. No code exists yet. This is the plan Matt reads before anything is built.

## What this is

A sender records a video for one specific person and sends a Cinder link. The recipient watches it, but never gets a keepable copy the way iMessage or Instagram hand one over. When they finish watching, a visible, warm countdown starts, and at zero Cinder destroys its stored copy and the link goes dark. Either side can add time by spending credits.

The archetypal story, and the reason this exists: a person in recovery records an honest, vulnerable check-in and sends it to a trusted mentor. They want the mentor to see it. They do not want it living forever in a chat log, backed up to two clouds, and resurfacing in a search box three years later. Dignity is the product. The video was for a moment, and Cinder lets it be for a moment.

## The promise, said exactly

Cinder's file promise is exactly one server delivery attempt, burn verified before the first response byte, 4 MiB per object ([security.md](security.md)). That model does not transfer to video and this doc does not pretend it does. A real phone video is 50 to 500 MB and a real watch involves buffering, a dropped connection, and a rewatch of the part that mattered. A single atomic delivery would make a flaky elevator connection permanently destroy a mentor's one chance to see the check-in, which fails the person the feature exists for.

So a video makes a **different promise, stated as its own thing, never blended with the file promise:**

**What Cinder promises for a video:**

- The video is encrypted in the sender's browser with a key that lives only in the URL fragment. Cinder stores ciphertext it cannot open, same as every note and file ([crypto.md](crypto.md)).
- The recipient gets a **watch window**, not a copy. Inside the window they can watch, lose connection, come back, and rewatch. The window is enforced by the server: past its deadline, no segment is ever served again, and the stored objects are destroyed.
- There is no download button, no keepable link, no way to reopen it after the window closes. The link is spent.
- Declining is always available, costs nothing, and looks identical to watching from the sender's side.

**What Cinder cannot promise, said on the surface rather than buried here:** the web cannot prevent a screen recording or a second phone pointed at the screen. Nothing can, including the apps that pretend to. "They can't save it" is a claim no code can fully keep, so Cinder's copy says what is actually true: no keepable link, no download, gone on schedule, and a determined recipient can always capture a screen. This is the same honesty posture as the README's comparison table and [security.md](security.md), applied to video.

**One more honest asymmetry:** "watched fully" is something only the recipient's browser can see, because Cinder cannot observe playback of ciphertext it cannot read. The enforced guarantee is therefore the watch window's server deadline. The finished-watching signal from the client *shortens* the deadline to start the 8-minute countdown; a recipient who suppresses that signal keeps the video only until the window's hard ceiling, which is bounded and stated below. The ceiling is the guarantee. The countdown is the experience.

## The lifecycle

```
SEND                          STORE                         WATCH
sender records/picks video    S3, encrypted segments        recipient claims → window opens
encrypt per 4 MiB segment     grant row in DynamoDB         segments via short-lived
presigned multipart PUTs      expiry chosen by sender       presigned GETs (ciphertext)
1 credit spent at mint        nothing readable server-side  decrypt locally, play locally

COUNTDOWN                     EXTEND                        BURN
client reports playback done  +8 min per credit             deadline passes → segments refused
deadline shortens to +8 min   recipient uses prefunded or   scheduled delete of all objects
warm visible countdown        own credits; sender can too   lifecycle sweep as backstop
```

**Send.** The sender's browser splits the video into segments of at most 4 MiB, encrypts each in its own AES-256-GCM envelope (the same shape as chunked file parts, [security.md](security.md), "Larger files are more objects"), and uploads each with a presigned multipart-style `PUT` pinned to length and checksum, exactly as file uploads are pinned today. Segment locators derive from the transfer locator the same way part locators do — and that derivation already lives in two places that must agree byte for byte (`api/src/id.mjs`, `src/lib/link.ts`; see GOTCHAS). Video reuses it rather than inventing a third. An interrupted upload resumes from the last confirmed segment: nothing has been promised to anyone yet, so resuming an upload is free of ethics.

**Store.** The grant row carries the segment count, the sender-chosen expiry, and nothing readable. If nobody ever claims it, availability ends at expiry exactly (at-read guard, same as notes) and physical deletion follows by lifecycle rule, same layered honesty as unclaimed transfers today.

**Claim and watch.** The recipient passes the human gate (below) and claims. The claim opens a watch session with a server deadline. While the session is open, the session Lambda issues short-lived presigned `GET`s for segments — ciphertext only, useless without the fragment key. This is a deliberate departure from the file path's "no presigned GET" stance and it is confined to video objects: the burn-mode file promise needs delivery and deletion to be one atomic act, so its bytes flow through the Lambda; a video needs resumable ranged reads of up to 512 MiB, which a 6 MB buffered Lambda response cannot carry ([security.md](security.md), "Size ceiling"), so its ciphertext flows from S3 directly. What crosses the wire is the same thing in both cases: bytes nobody but the link holder can open.

**Playback.** The recipient's browser decrypts segments as they arrive into OPFS (the browser's origin-private file system), and plays the assembled file through an object URL. Full seeking and rewatching work against the local decrypted copy, with zero further server reads. The honest cost: playback of the whole file starts when enough of it has landed, and for a large video on a slow connection that is a real wait, which the screen narrates truthfully instead of spinning. The local copy is discarded when the window ends or the tab closes; that discard is best-effort client behavior and is never claimed as a guarantee.

**Countdown.** When the player fires its natural end event, the client tells the server "finished," and the server shortens the session deadline to now plus 8 minutes. The visible countdown renders that real deadline. It is warm and gamified in tone — an ember burning down, not a bomb timer — and honest in mechanics: it counts the actual server deadline, never a theatrical number.

**Extend.** One credit adds 8 minutes, applied to the server deadline. A sender can prepay extensions at send time so the recipient needs no account and no card to add time. A recipient (or the sender) with an account mints an `extend` capability grant through the existing seam — the grant names a capability and no subject (`api/src/capabilities.mjs`), so extending never links a person to a transfer, same as sending.

**Burn.** At the deadline: segment requests are refused immediately and unconditionally (the at-read guard is the availability guarantee, as everywhere else in Cinder), a one-shot scheduled delete removes every object within about a minute, and the standing lifecycle rule is the backstop that collects anything a crash orphaned. Deletion honesty is layered exactly as [security.md](security.md) already states it for transfers: availability ends exactly on time, physical removal follows closely and is stated, not hidden.

## The playback decision: client-side crypto versus signed streaming

Two real options were evaluated. The recommendation is the first, and the tradeoff is stated plainly rather than balanced away.

**Option A — client-side encrypted segments, decrypt-and-play locally (recommended).** The server holds only ciphertext, ever. The key stays in the fragment. Every privacy sentence Cinder has already shipped stays true for video without an asterisk. Costs: playback waits for the download to get ahead of the playhead (no adaptive bitrate, no instant scrub-before-download), memory and OPFS hold up to 512 MiB in the recipient's browser, and Cinder ships no transcoding so the recipient plays whatever container the sender's phone produced (H.264/HEVC MP4 in practice, which every modern browser plays).

**Option B — signed streaming URLs (CloudFront signed cookies over HLS, MediaConvert transcode).** Instantly seekable, adaptive, native player behavior. And disqualifying: transcoding requires the server to hold plaintext, which means Cinder could watch the video. The entire brand is that the server cannot read what it stores; the north-star user is a person in recovery trusting exactly that. A smooth scrubber is not worth becoming the thing the README's comparison table warns about. Rejected.

The tradeoff in one sentence: **Option A trades scrubbing polish for the truth of the promise, and for this product that is not close.**

## The numbers

Every number on the powers-of-two ladder, chosen deliberately:

| Thing | Value |
| --- | --- |
| Segment size | 4 MiB |
| Max segments | 128 |
| Max video size | 512 MiB (roughly 5 to 8 minutes of 4K, or 30+ minutes of 1080p phone video) |
| Watch window ceiling from claim | 64 minutes |
| Countdown after watched fully | 8 minutes |
| Extension | 8 minutes per credit |
| Max extensions per video | 8 (64 added minutes; absolute session cap 128 minutes) |
| Presigned GET validity | 8 minutes, reissued while the session is open |
| Send cost | 2 credits (Matt's gate, below) |
| Prepaid extensions at send | 0, 2, 4, or 8 (Matt's gate, below) |

## Money

Credits are the existing Cinder Pro mechanic and video changes none of its shape: the spend happens at mint, atomically, before any bytes are stored, and a retry inside the grant window is free ([pro-payments.md](pro-payments.md)). A video send spends its credits the moment Cinder hands the sender the link, not when it is watched, and a destroyed or never-watched video does not refund — Cinder structurally cannot see which transfer succeeded, which is the same reason it cannot see who you sent it to. The send screen says this before encryption starts, in the same breath as the cost.

The extension is a **yes, and** by construction, never a paywall ambush: the recipient always keeps every minute already on the clock, the prompt to add time appears with time still remaining rather than at zero, and a recipient with no credits is pointed at two open doors (prefunded extensions, or asking the sender) instead of a checkout wall.

**Every Stripe-touching decision here is Matt's gate and none of it is assumed:** the 2-credit send price, the 1-credit extension price, whether prepaid extensions are bundled or priced, and whether the $4.94 / 10-credit bundle stays the only SKU or video earns its own. The numbers above are a recommendation shaped by the ladder, not a decision.

## The copy

Written here so the honesty is designed, not retrofitted. Sentence case, matching the reveal surfaces (`src/lib/ui/organisms/RevealGate.svelte`); each block is one unbroken line per paragraph because it will be pasted into components.

**The reveal gate, before anything is claimed:**

> Someone sent you a video, for you alone. When you press play, a watch window opens: you can watch it, lose your connection, come back, and rewatch it. When the window ends, Cinder destroys its stored copy and this link goes dark for good. There is no download and no keepable link. One honest limit: nothing on the web can stop a screen recording, and Cinder will not pretend otherwise. What Cinder promises is that no copy exists unless someone chooses to make one.

Buttons: **Start watching** / **Decline and destroy it unwatched**

**Under the decline button:**

> Declining destroys the video without playing it. The sender only ever sees that it is gone, never whether you watched or declined.

**When playback finishes and the countdown starts:**

> You watched all of it. Cinder keeps its copy for 8 more minutes, in case you want to see part of it again. Then it lets it go.

**At two minutes remaining:**

> Two minutes left on Cinder's copy. Add time if you need it. What you have already watched stays available until the clock runs out.

**Trying to extend with no credits and no prefund:**

> No credits here, and that is okay. Every minute still on the clock is yours. If you need longer, ask the person who sent it to add time from their side, or add credits to an account.

**At zero:**

> That is the whole thing. Cinder's copy is destroyed, and this page has let go of its copy too. What you saw stays with you.

**The send screen, before encryption starts:**

> Sending this video costs 2 credits, spent when Cinder hands you the link, not when it is watched. If nobody opens it, it is destroyed at the expiry you choose. Once your person finishes watching, they get 8 more minutes, and either of you can add time. Cinder never sees the video, its name, or your key, and it cannot stop the other side from recording their screen. Nobody can promise that; Cinder is just the one saying so.

## The journey, answered

The experience-craft questions, answered for the recipient, because the recipient is the person with no account, no context, and the most at stake.

**Where are they arriving from?** A text message, on a phone, mid-day, with a bare link and whatever the sender typed around it. No account, no install, no idea what Cinder is. The reveal gate is the first screen and it must work for someone who has never heard the word "encrypted": what this is, what pressing play does, what the two buttons mean, in plain words, under the 32-word-above-the-action budget.

**What is the single next action?** Start watching, or decline. Two buttons, no third thing competing. The full honest account (screen recording, window mechanics, decline privacy) is present but sits below the choice, not on top of it.

**What changes immediately after the action?** Pressing play opens the session and the screen narrates truthfully: which piece is downloading, when playback can start, that the wait is the download and not a fault. No dead spinner.

**Connection loss mid-watch?** The watch window is the promise, so this is a non-event by design: segments already decrypted keep playing from the local copy, missing ones resume when the connection returns, and the countdown that matters is the server deadline, which never moved. This is the exact scenario the single-delivery model would have turned into permanent loss, and it is the main reason video gets its own promise.

**Countdown hits zero mid-rewatch?** Playback stops, the local copy is discarded, and the zero-state copy closes warmly rather than slamming: what you saw stays with you. The extension prompt appeared at two minutes precisely so zero mid-rewatch is a chosen outcome, not an ambush. No closed door: the page still says what happened and that the sender can send again.

**Extending without credits?** Answered in the copy above: the remaining time is never confiscated, prefunded extensions apply with one tap and no account, and the fallback is human (ask the sender) rather than commercial (buy now). A zero balance is a state, not a fault, exactly as [pro-payments.md](pro-payments.md) already rules for sends.

**Can they reverse, dismiss, leave?** Decline is always one tap and destroys unwatched. Closing the tab mid-window does not destroy anything; reopening the link inside the window resumes it, which the gate's copy implies by promising "lose your connection, come back."

**Accessibility.** The countdown is not color-alone or motion-alone: it carries the numeral, a label, and a shape, and it respects `prefers-reduced-motion` by counting without animating. The video element is the platform's own, so captions ride along if the file carries them; the gate, countdown, and extension controls are ordinary labeled buttons that pass the same AA bar as every other Cinder surface, both schemes, smallest screen, measured.

## Sixteen user stories

1. A person in recovery records an honest, vulnerable check-in video and sends it to a trusted mentor, so the mentor sees it without it living forever in a chat log.
2. A sender picks a 300 MB phone video and, before anything encrypts or uploads, sees the credit cost, the size, the expiry, and exactly what "gone" means, so the commitment is informed rather than discovered.
3. A sender's upload drops at segment 90 of 128; on reconnect it resumes from the last confirmed segment instead of starting over, because nothing has been promised to a recipient yet.
4. A sender revisits the link from their own browser and sees only "still waiting" or "gone," with no timestamp and no way to tell watched from declined.
5. A sender attaches prepaid extensions at send time so their recipient can add time with one tap, no account, no card.
6. A sender regrets sending, destroys the video from their own status view before it is claimed, and the recipient's link answers "gone" without drama.
7. A recipient taps a link from a text on their phone, with no account and no install, and reaches a gate that says what will happen before anything is claimed or fetched.
8. A recipient on a slow connection watches the download narrated honestly, with playback starting as soon as it truthfully can, instead of staring at a spinner that admits nothing.
9. A recipient finishes the video, sees the warm 8-minute countdown, and rewatches the moment that mattered twice inside the window without touching the server again.
10. A recipient loses connection mid-watch in an elevator; already-delivered segments keep playing, the rest resume upstairs, and nothing was destroyed by the drop.
11. The countdown reaches zero mid-rewatch; playback stops, the page discards its local copy, and the screen closes warmly and truthfully rather than apologizing or pretending.
12. A recipient with no credits taps extend and finds open doors, prefunded time or a human ask, and never a paywall standing where the video used to be.
13. A recipient who does not want to watch declines at the gate; the video is destroyed unwatched, and because the sender sees only "gone," declining carries no social penalty the sender can measure.
14. A person receiving unwanted or pressuring videos destroys them unopened, one tap each, and nothing about the product nudges them to look first.
15. A link-preview bot in a group chat fetches the URL and nothing happens: no claim, no window, no burn, because claiming requires a human action and a POST, same as every Cinder surface.
16. A recipient points a second phone at the screen and captures the video; Cinder never claimed it could stop that, the gate said so before the watch, and the sender was told the same before the send.

## What is Matt's to decide

1. **Every price.** Credits per video send, credits per extension, whether prepaid extensions cost the sender extra, and whether the $4.94 / 10-credit bundle remains the only SKU. All of it touches Stripe and none of it ships on this doc's recommendation alone.
2. **Whether recipients can buy credits at all.** Sender-prefunded extensions need no recipient account. Letting a recipient create an account and buy their own credits opens a second customer relationship on the receiving side, with its own copy, support, and privacy surface. Ship prefund-only first, or both, is a product call, not an engineering one.
3. **The window semantics tradeoff.** The enforced guarantee is the 64-minute ceiling; "watched fully" is client-reported and shortens the deadline rather than creating it. That is the honest design under zero knowledge, and it means a recipient who games the report keeps the video for up to the ceiling. Accepting that plainly, versus wanting a tighter ceiling or a different shape, is a taste-and-honesty call that belongs to Matt.

Separately, and standing regardless: shipping this changes privacy-relevant strings and what leaves the device (the presigned-GET path for video ciphertext), so the deploy that turns it on sits behind the existing privacy-deploy gate. Not a fourth decision, just the standing rule applying here as it applies everywhere.

## What does not change

The note promise, the file promise, and every sentence currently shipped about them are untouched: burn-mode files keep exactly one server delivery attempt through the Lambda, notes keep the atomic conditional delete, the 4 MiB free ceiling and the chunked 256 MiB paid path stay exactly as documented. Video is a third artifact with its own name, its own promise, and its own reveal surface, and no copy anywhere blends the three. The capability seam (`api/src/capabilities.mjs`), the credits-at-mint spend, the unlinkability of accounts from transfers, and the CORS boundary between the two APIs all carry video without modification, which is what those seams were shaped for.
