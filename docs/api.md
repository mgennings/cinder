# API reference

Cinder's API is two endpoints. This document is the exact contract. All request and response bodies are JSON. The base URL for the reference deployment is `https://tlfcdvq445.execute-api.us-east-1.amazonaws.com`; your own deployment's URL comes from the SAM stack output (see [Deployment](deployment.md)).

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
| `410 Gone` | `{ "error": "This note has already been read or has expired." }` | Already read, or expired. There is no way to recover it. |

## Guarantees

- **Exactly one reader.** The burn is a single atomic DynamoDB `DeleteItem` with a condition. If two requests race, exactly one gets `200` and the note; the other gets `410`. There is no window where both succeed.
- **Expired notes are never served.** The burn condition checks `expiresAt > now`, so an expired note returns `410` even if DynamoDB's TTL sweep has not yet removed it.
- **No note enumeration.** IDs are 128 bits of randomness (base64url). There is no list endpoint and no way to discover a note you were not given.

## CORS

The API sends permissive CORS headers (`Access-Control-Allow-Origin: *`) for `POST` and `OPTIONS`, so the static front end can call it cross-origin from CloudFront. If you fork and lock this down, restrict the origin to your own site.

## Related documents

- [Architecture](architecture.md) — how the endpoints fit into the system
- [Crypto](crypto.md) — what the `ciphertext`, `iv`, and `salt` fields contain
- [Deployment](deployment.md) — how to stand up your own API
