# API reference

Cinder's API is five endpoints — two for notes, three for files. This document is the exact contract. All request and response bodies are JSON. The base URL for the reference deployment is `https://tlfcdvq445.execute-api.us-east-1.amazonaws.com`; your own deployment's URL comes from the SAM stack output (see [Deployment](deployment.md)).

> **Note:** The API only ever sees ciphertext. It never receives the decryption key — that stays in the URL fragment on the client. Everything here operates on already-encrypted data.

## Create a note

```
POST /notes
```

Stores an encrypted note and returns an opaque ID.

**Request body:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ciphertext` | string (base64) | Yes | The encrypted note. Max 100,000 characters. |
| `iv` | string (base64) | Yes | The 96-bit AES-GCM initialization vector. |
| `salt` | string (base64) | No | PBKDF2 salt, present only for passphrase-protected notes. |
| `ttlSeconds` | number | Yes | Desired lifetime in seconds. Clamped server-side to the range 1–604800 (7 days). |

**Example:**

```bash
curl -X POST https://tlfcdvq445.execute-api.us-east-1.amazonaws.com/notes \
  -H 'content-type: application/json' \
  -d '{"ciphertext":"<base64>","iv":"<base64>","ttlSeconds":3600}'
```

**Responses:**

| Status | Body | Meaning |
| --- | --- | --- |
| `201 Created` | `{ "id": "<opaque-id>" }` | Note stored. Build the link as `/n/{id}#{key}`. |
| `400 Bad Request` | `{ "error": "..." }` | Malformed JSON, missing `ciphertext`/`iv`, or ciphertext over the size limit. |

## Burn (read) a note

```
POST /notes/{id}/burn
```

Atomically destroys the note and returns it. This is a one-shot operation — the first successful call is the only call that ever returns the note.

> **Note:** This endpoint is intentionally `POST`, not `GET`. Link-preview bots issue `GET` requests, so they cannot trigger a burn. See [bot defense](architecture.md#bot-defense).

**Path parameters:**

| Parameter | Type | Description |
| --- | --- | --- |
| `id` | string | The note ID returned by `POST /notes`. |

**Example:**

```bash
curl -X POST https://tlfcdvq445.execute-api.us-east-1.amazonaws.com/notes/<id>/burn
```

**Responses:**

| Status | Body | Meaning |
| --- | --- | --- |
| `200 OK` | `{ "ciphertext": "...", "iv": "...", "salt"?: "..." }` | You are the one reader. The note is now deleted. |
| `410 Gone` | `{ "error": "This note has already been read or has expired." }` | Already read, or expired. Cinder cannot return a stored copy. |

## Guarantees

- **Exactly one successful server retrieval.** The burn is a single atomic DynamoDB `DeleteItem` with a condition. If two requests race, exactly one gets `200` and the note; the other gets `410`. There is no window where both succeed.
- **Expired notes are never served.** The burn condition checks `expiresAt > now`, so an expired note returns `410` even if DynamoDB's TTL sweep has not yet removed it.
- **No note enumeration.** IDs are 128 bits of randomness (base64url). There is no list endpoint and no way to discover a note you were not given.

## File transfer

Three endpoints, and they are deliberately shaped so that no single one of them is enough to do harm. All capabilities travel in request **bodies**, never in a path or query string, so nothing sensitive can end up in an access log if logging is ever switched on. The one exception is the presigned upload URL, which necessarily carries its signature in an S3 query string; it is scoped to a single key, a single length, and a single checksum, and it expires in five minutes.

### Reserve a transfer

```
POST /files
```

**Request body:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ciphertextBytes` | number | Yes | Exact length of the encrypted envelope. Max 4,198,400. |
| `ciphertextSha256` | string (base64) | Yes | SHA-256 of the envelope, in the form S3's `x-amz-checksum-sha256` expects. |
| `ttlSeconds` | number | Yes | Clamped server-side to 1–604800 (7 days). |

**Responses:**

| Status | Body | Meaning |
| --- | --- | --- |
| `201 Created` | `{ "locator", "uploadCapability", "upload": { "url", "headers" } }` | Transfer reserved. Build the link as `/f/{locator}#{key}`. |
| `400 Bad Request` | `{ "error": "..." }` | Missing or malformed size/checksum, or over the size limit. |

The `locator` and `uploadCapability` are independent 256-bit secrets; the server stores only their SHA-256 hashes. `upload.url` is a presigned `PUT` valid for five minutes, signed against one random object key, that exact byte length, and that exact checksum — S3 itself refuses anything else.

### Finalize

```
POST /files/finalize
```

Body: `{ "locator", "uploadCapability" }`.

The server asks S3 what it actually stored and compares size and checksum against what it authorized, then moves the grant from `uploading` to `ready` in a single conditional write. A client's claim that it finished uploading counts for nothing here.

| Status | Body | Meaning |
| --- | --- | --- |
| `200 OK` | `{ "state": "ready" }` | The stored object was verified. Retrying with identical facts is idempotent. |
| `410 Gone` | `{ "error": "This transfer is no longer available." }` | Unknown locator, wrong capability, missing object, wrong size, wrong checksum, expired, or already claimed. |

### Claim

```
POST /files/claim
```

Body: `{ "locator" }`. This is the one delivery attempt.

| Status | Body | Meaning |
| --- | --- | --- |
| `200 OK` | the raw encrypted envelope (`application/octet-stream`) | You are the one delivery. Cinder's stored copy was deleted and its absence verified before this body existed. |
| `410 Gone` | `{ "error": "This transfer is no longer available." }` | Everything else, indistinguishably. |

The `410` is byte-identical whether the link never existed, was malformed, is still uploading, expired, or was already claimed. Distinguishing them would turn this endpoint into an oracle confirming that a link once existed.

## Guarantees for files

- **Exactly one server delivery attempt.** The claim is a conditional DynamoDB `DeleteItem`. Twenty simultaneous claims produce one body and nineteen identical refusals.
- **Deletion precedes delivery, structurally.** The order is claim, open, delete, verify absence, respond. Because this is a buffered Lambda proxy integration, the response object does not exist until every prior step has returned — API Gateway cannot send a byte of a response it has not received. See [architecture](architecture.md#why-the-delete-before-delivery-guarantee-actually-holds).
- **Any post-claim failure is permanent.** A crash, timeout, S3 error, or dropped connection consumes the transfer. The grant is never restored and the object is never recreated.
- **No presigned GET, Range, retry, resume, or preview.** The only way ciphertext leaves the bucket is through the claim path above.
- **Orphans expire.** Abandoned uploads and unclaimed expired grants are removed by a DynamoDB TTL and an eight-day S3 lifecycle rule. That cleanup is asynchronous and best-effort; it is a backstop, not the guarantee.

## CORS

The API sends CORS headers for `POST` and `OPTIONS` restricted to Cinder's exact origins (`cinder.ink`, `www.cinder.ink`, `cinder.uxuiai.org`, `blip.uxuiai.org`) rather than `*`. The media bucket allows `PUT` from the same four origins and nothing else. If you fork this, replace those origins with your own.

## Rate limiting

The API stage throttles at 20 requests per second with a burst of 40, across all routes. A self-destructing-transfer service has no legitimate burst shape, and locator guessing should be expensive.

## Related documents

- [Architecture](architecture.md) — how the endpoints fit into the system
- [Crypto](crypto.md) — what the `ciphertext`, `iv`, and `salt` fields contain
- [Deployment](deployment.md) — how to stand up your own API
