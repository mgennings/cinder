# Video API contract

The endpoint contract for ephemeral video, written before the code so every builder codes against one shape. The design and its promises live in [ephemeral-video-design.md](ephemeral-video-design.md); this document is the wire format. All request and response bodies are JSON unless stated. Every capability travels in a request **body**, never a path, query string, or header — same rule and same reason as the file API ([api.md](api.md)).

Video is a third artifact. Nothing here modifies the note promise, the file promise, or any endpoint in [api.md](api.md). The one deliberate departure from the file path — presigned `GET`s for segment ciphertext — is confined to video objects and stated in full below.

## The numbers

All on the powers-of-two ladder, fixed by the design doc and mirrored in `src/lib/video/types.ts`. In seconds where the server touches them: watch window ceiling **3840** (64 min from claim), finished countdown **480** (8 min), extension **480**, absolute session cap **7680** (128 min from claim), presigned GET validity **480**. Segments are at most 4 MiB, at most 128 of them, 512 MiB total. A send costs **2 credits**, an extension **1 credit**, prepaid extensions come as **0, 2, 4, or 8** — and every price is Matt's gate, recommended here, decided nowhere but by him.

## Capabilities and credits

Two new capability names, verified through the existing gate (`api/src/capabilities.mjs` / `api/src/capability-grant.mjs`) exactly as `transfer.multipart` is today:

| Capability | Minted where | Credits at mint | Limits carried |
| --- | --- | --- | --- |
| `video.send` | `POST /capability` on the **identity** API | 2 | `{ maxSegments: 128, prepaidExtensions?: 2\|4\|8 }` |
| `video.extend` | `POST /capability` on the identity API | 1 | `{ extensions: 1 }` |

The spend is **credits-at-mint**, unchanged in shape ([pro-payments.md](pro-payments.md)): atomic, before any bytes are stored, retry inside the grant window free, no refund for a declined or unwatched video — Cinder structurally cannot see which transfer succeeded. The grant carries `cap`, `limits`, `exp`, `nonce` and **no subject**; `prepaidExtensions` is omitted from limits when it is zero, because a missing limit already reads as zero (`checkCapability`) and the grant format refuses non-positive limit values. Extending never links a person to a transfer, for the same structural reason sending never does: the transfer API's CORS allows only `content-type`, and the gate never sees the event.

## Create

```
POST /videos
```

**Request body:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `segments` | array | Yes | 1–128 objects, each `{ ciphertextBytes, ciphertextSha256 }`, in order. Each validated against the same 4,198,400-byte per-object ceiling as a file part. One bad segment refuses the whole request. |
| `ttlSeconds` | number | Yes | Unclaimed lifetime, clamped server-side to 1–604800 (7 days). Governs only the pre-claim period; once claimed, the watch window takes over. |
| `capabilityGrant` | string | Yes | A `video.send` grant. Always required — every video send is a paid send, so unlike `/files` there is no free single-segment shape. |

**Responses:**

| Status | Body | Meaning |
| --- | --- | --- |
| `201 Created` | `{ "locator", "uploadCapability", "statusToken", "segments": [{ "index", "upload" }] }` | Reserved. Build the link as `/v/{locator}#{key}.{n}` and keep `statusToken` only in the sender browser. |
| `400 Bad Request` | `{ "error": "..." }` | Malformed segments, empty array, more than 128, or bad TTL. |
| `402 Payment Required` | `{ "error": "..." }` | No valid `video.send` grant. Out of credits, never bought any, or anonymous — indistinguishable on purpose. |
| `403 Forbidden` | `{ "error": "..." }` | Granted, but for fewer segments than requested. |

Each `upload` is a presigned `PUT` pinned to one random object key, that segment's exact length, and its exact SHA-256, via the same presigner and the same `unhoistableHeaders` discipline as file uploads (`api/src/lambda.mjs`). The upload window scales with segment count under the same reasoning as multipart. `prepaidExtensions` is read off the grant's limits, not the request body — it is what was paid for, so the grant is the authority.

**Segment addressing.** Segment *i*'s locator is derived, never issued:

```
segmentLocator(i) = base64url(sha256("<locator>:part:<i>"))
```

This is byte-for-byte the file part derivation, on purpose — the design doc forbids a third derivation. It exists as the named exports `deriveSegmentLocator` in `api/src/id.mjs` and `src/lib/link.ts`, both aliases of the part derivation, with the agreement pinned by `api/test/id.test.mjs` and `src/lib/link.test.ts`. No collision with file parts is possible: every locator is its own 256 random bits, and the rows differ by `kind`.

## Finalize

```
POST /videos/finalize
```

Body: `{ "locator", "uploadCapability" }`. Called once per segment with the **derived** segment locator, then once with the **transfer** locator to seal the whole video; the server tells the shapes apart by the row's `kind`.

- **Segment finalize** (derived locator): the server asks S3 for the stored object's size and checksum and compares against what it authorized, then moves that segment `uploading → ready` in one conditional write. Identical semantics to `/files/finalize`.
- **Video finalize** (transfer locator): the server verifies every segment row is `ready` and unexpired, then moves the session row `uploading → ready`. Until this succeeds the video cannot be claimed, so a half-uploaded video is never presented as whole — the same rule `claimFileGrant` enforces per object.

| Status | Body | Meaning |
| --- | --- | --- |
| `200 OK` | `{ "state": "ready" }` | Verified. Retrying with identical facts is idempotent — this is what makes the sender's upload resumable: after a dropped connection, re-finalize each segment; the confirmed ones answer `200` and the client resumes from the first that does not. |
| `410 Gone` | `{ "error": "This video is no longer available." }` | Unknown locator, wrong capability, missing or mismatched object, a segment not ready, expired — indistinguishably. |

## Claim

```
POST /videos/claim
```

Body: `{ "locator" }`. Opens the watch window — or resumes it, which is the deliberate difference from the file claim: closing the tab and reopening the link inside the window must cost nothing.

- **First claim:** one conditional update on the session row, `ready → open`, recording `claimedAt = now` and `deadlineEpoch = now + 3840`. This is the recipient's consent moment; the reveal gate has already said what it means.
- **Re-claim while `open` and `deadlineEpoch > now`:** returns the current session unchanged. Same response shape, so the client cannot tell first from resumed and does not need to.

| Status | Body | Meaning |
| --- | --- | --- |
| `200 OK` | `{ "deadlineEpoch", "segments", "finished", "prepaidRemaining", "extensionsUsed" }` | The window is open. Everything the countdown and extension UI render comes from here and from `/videos/extend` responses — the client never invents a deadline. |
| `410 Gone` | `{ "error": "This video is no longer available." }` | Never existed, still uploading, expired unclaimed, destroyed, or the window has ended — indistinguishably. |

## Segment URL issuance

```
POST /videos/segment-url
```

Body: `{ "locator", "index" }`. The server derives the segment locator, requires the session `open` with `deadlineEpoch > now` and the segment row `ready`, and returns a presigned `GET` for that segment's ciphertext.

| Status | Body | Meaning |
| --- | --- | --- |
| `200 OK` | `{ "url", "expiresIn" }` | `expiresIn` is `min(480, deadlineEpoch - now)` — an issued URL never outlives the deadline, so "past its deadline, no segment is ever served again" holds without an asterisk. Reissue freely while the session is open. |
| `410 Gone` | `{ "error": "This video is no longer available." }` | Session missing, unclaimed, past deadline, or index out of range — indistinguishably. |

**This is the one departure from the file path, and its boundary is structural, not behavioral.** The burn-mode file promise needs delivery and deletion to be one atomic act, so file bytes flow through the Lambda and no presigned GET exists for them — that stays exactly true. A video needs resumable ranged reads of up to 512 MiB, which a 6 MB buffered response cannot carry, so video ciphertext flows from S3 directly. To keep the file stance provable rather than promised, video segment objects live under their own key prefix — `v/{band}/{64 hex}`, same lifetime bands as `newObjectKey` — and the segment-url role's `s3:GetObject` is scoped to `v/*`. A role that cannot name a file object cannot sign a GET for one. What crosses the wire is ciphertext nobody but the link holder can open, same as everywhere in Cinder.

## Finished

```
POST /videos/finished
```

Body: `{ "locator" }`. The client's report that playback ended naturally. The server sets `deadlineEpoch = min(deadlineEpoch, now + 480)` — it only ever **shortens**, so a forged or repeated report cannot buy time, and a suppressed one is bounded by the window ceiling. The ceiling is the guarantee; the countdown is the experience.

| Status | Body | Meaning |
| --- | --- | --- |
| `200 OK` | `{ "deadlineEpoch" }` | The real deadline the countdown renders. Idempotent. |
| `410 Gone` | `{ "error": "..." }` | Session missing or already past deadline. |

## Extend

```
POST /videos/extend
```

Body: `{ "locator", "capabilityGrant"? }`. Either side may call it — sender and recipient both hold the locator, and holding it is the authorization, so extending identifies nobody. Funding resolves in order:

1. **Prepaid:** if `prepaidRemaining > 0`, one is spent (conditional decrement) and no grant is needed. One tap, no account, no card.
2. **A `video.extend` grant**, minted for 1 credit on the identity API, verified through `checkCapability` exactly as sending is.

The new deadline is `min(deadlineEpoch + 480, claimedAt + 7680)`, and `extensionsUsed` must be below 8. Both caps are conditions on the same conditional write that moves the deadline, so racing extensions cannot overshoot.

| Status | Body | Meaning |
| --- | --- | --- |
| `200 OK` | `{ "deadlineEpoch", "prepaidRemaining", "extensionsUsed" }` | Time added. Minutes already on the clock were never at risk. |
| `402 Payment Required` | `{ "error": "..." }` | No prepaid remaining and no valid grant. The UI's answer is the design doc's copy: the remaining time is yours, ask the sender, or add credits — never a checkout wall. |
| `403 Forbidden` | `{ "error": "..." }` | The extension count or the 128-minute session cap is reached. This video has all the time it can be given. |
| `410 Gone` | `{ "error": "..." }` | Session missing or already past deadline. |

## Sender status

```
POST /videos/status
```

Body: `{ "statusToken" }` — the same `status-token.mjs` mint/verify seam as files, kept only in the creating browser, never in the recipient link. Returns `{ "status": "waiting" }` only while the video is sealed, unclaimed, and unexpired; **everything else is `{ "status": "gone" }`, indistinguishably** — claimed, watched, declined, extended, expired, destroyed. Declining must carry no social penalty the sender can measure, so the moment a recipient acts, the sender's view collapses to one word. Infrastructure failure is non-2xx so the browser never fabricates a gone state.

## Decline and destroy

```
POST /videos/destroy
```

Body: `{ "locator" }` **or** `{ "statusToken" }` — the recipient declining at the gate, or the sender regretting the send from their status view. Both work only while the session is unclaimed (`ready`): once a watch window is open it is the recipient's promise, and nobody, including the sender, can slam it shut.

The destroy is a conditional delete of the session row (only from `ready`), then deletion of every segment row and object. The response is `200 {}` unconditionally — for a video already claimed, already destroyed, or never real, exactly alike, so the endpoint is never an oracle and a repeated tap is safe.

| Status | Body | Meaning |
| --- | --- | --- |
| `200 OK` | `{}` | If there was an unclaimed video, it is gone unwatched. Either way, this answer. |

## The DynamoDB rows

Same table, keyed by hashes so a dump replays nothing, every transition one conditional write (`api/src/store.mjs` is the idiom). Nothing readable is stored: no name, no type, no thumbnail, no recipient, no account.

**The session row** — one per video, `pk = sha256(locator)`:

| Attribute | Type | Notes |
| --- | --- | --- |
| `pk` | string | `sha256(locator)`, base64. |
| `kind` | string | `'video'`. |
| `state` | string | `'uploading' → 'ready' → 'open'`. Destroy deletes from `ready`; the burn deletes from `open` at deadline. |
| `segments` | number | 1–128. |
| `prepaidRemaining` | number | 0, 2, 4, or 8 at create, from the grant's limits. |
| `extensionsUsed` | number | 0–8. |
| `finished` | boolean | Set by `/videos/finished`. Advisory; the deadline is the authority. |
| `createdAt`, `expiresAt` | number | Epoch seconds. `expiresAt` is the DynamoDB TTL: the sender's expiry until claim, then rewritten to `claimedAt + 7680` plus slack so a crashed burn is still swept. |
| `claimedAt`, `deadlineEpoch` | number | Absent until claimed. `deadlineEpoch` is the at-read guard every segment-url, finished, and extend call checks — availability ends exactly on time whether or not deletion has run yet, same layered honesty as everywhere else. |

**The segment rows** — one per segment, `pk = sha256(deriveSegmentLocator(locator, i))`, and deliberately the file-grant shape plus a different `kind`:

| Attribute | Type | Notes |
| --- | --- | --- |
| `pk` | string | Derived, never issued. |
| `kind` | string | `'video-segment'`. `/files/claim` conditions on `kind = 'file'`, so a video segment is structurally unclaimable through the file path — no copy of the file promise is spent on it, and no code change to the file path is needed to guarantee that. |
| `state` | string | `'uploading' → 'ready'`. No claimed state: segments are read via presigned GET inside the window, not consumed. |
| `objectKey` | string | `v/{band}/{64 hex}` — the `v/` prefix is what scopes the GET-signing role; bands per `newObjectKey`. |
| `uploadCapabilityHash`, `ciphertextBytes`, `ciphertextSha256`, `createdAt`, `expiresAt` | | Exactly as file grants, with one video-only refinement: the claim lifts each segment's `expiresAt` to the session row's sweep horizon, because a window opened minutes before the sender's expiry runs long past it and the DynamoDB reaper must never eat a row inside an open window. |

**The burn.** At the deadline the at-read guard refuses immediately and unconditionally; a one-shot scheduled delete (EventBridge Scheduler, armed at claim and re-armed on extend) removes every object within about a minute; the standing S3 lifecycle rule on `v/d1` and `v/d8` collects anything a crash orphaned. Availability ends exactly on time; physical removal follows closely and is stated, not hidden.

## Which seam carries what

| This contract | Reuses | Unchanged |
| --- | --- | --- |
| Segment locators | `deriveSegmentLocator` in `api/src/id.mjs` + `src/lib/link.ts` (aliases of the part derivation) | Yes — pinned both sides |
| Send and extend gates | `checkCapability` / `denyAll` in `api/src/capabilities.mjs`; grant format in `capability-grant.mjs` | Yes — new capability names only |
| Credits | Credits-at-mint on the identity API's `POST /capability` ([identity.md](identity.md), [pro-payments.md](pro-payments.md)) | Yes — new capability names spend 2 and 1 |
| Sender status + sender destroy credential | `status-token.mjs` mint/verify | Yes |
| Upload presigning | `s3.presignPut` with `unhoistableHeaders` pinning key, length, SHA-256 | Yes |
| Object keys and lifecycle bands | `newObjectKey`'s band logic, under the new `v/` prefix | Extended, not changed |
| State transitions | `store.mjs`'s one-conditional-write-per-transition idiom | Pattern reused |
| The `410` posture | Every unavailable video answers identically | Same rule, new sentence: "This video is no longer available." |

**Deploy note, standing rule, not a footnote:** shipping this changes privacy-relevant strings and what leaves the device (the presigned-GET path), so the deploy that turns it on sits behind the existing privacy-deploy gate.
