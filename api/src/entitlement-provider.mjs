// THE SEAM. This is the one file the entitlement lane owns on the server.
//
// Everything else in api/src/ asks a `CapabilityGate` whether the bearer of a
// grant may use a named capability. This file decides who answers that question
// in production. It ships denying, which is the correct behavior until something
// real is wired in: a gate that fails open is not a gate.
//
// The contract, which is deliberately smaller than it could be:
//
//   export const gate = {
//     async check({ grant, capability }) {
//       // `grant` is an opaque string the sender put in the request BODY, or
//       //   null. It is the ONLY input. There is no event, no header, and no
//       //   address, on purpose — see the note in capabilities.mjs.
//       // `capability` is a namespaced string from CAPABILITY.
//       return { granted: true, limits: { maxParts: 64 } };
//     }
//   };
//
// Why the grant is not an ID token, even though one exists:
//
// api/src/entitlement.mjs puts identity on a SEPARATE HTTP API, and
// template.yaml allows only `content-type` at CORS on the transfer API, so a
// browser cannot attach an Authorization header to /files even by accident.
// That is the structural half of "an account is never linkable to a transfer."
// Verifying an ID token here would throw it away: Cinder's own access log would
// then hold a token identifying the sender of a specific transfer.
//
// So the thing presented here must be a bearer capability, not a credential.
// The shape that satisfies both sides — gate it, and stay unlinkable — is a
// short-lived signed grant minted by the identity API after it has checked
// entitlement, carrying a capability, a limit, and an expiry, AND NO SUBJECT:
//
//   base64url({ cap, limits, exp, nonce }) . HMAC-SHA256(secret, that)
//
// Verifying it here is a signature check and an expiry check. Cinder learns
// "someone entitled to transfer.multipart sent this" and cannot learn who, which
// is exactly as much as it needs and exactly as little as it should have.
//
// Rules the transport relies on and will not re-check for you:
//
//   - `granted` must be exactly `true` to grant. Anything else denies.
//   - `limits` values must be positive integers. A missing limit is read as
//     zero, never as unlimited.
//   - Throwing is allowed and reads as a denial. Do not swallow errors into a
//     grant to keep a checkout flow smooth.
//   - The gate is asked on the CREATE path only, and only when more than one
//     part is requested. It is never consulted on finalize or claim, because a
//     recipient must never need an account to receive what a sender already paid
//     to send. The two promises say a paid path may not be less reachable, and
//     this is where that is true or false.
//   - A grant must not be single-use at this layer. A retried create after a
//     dropped connection would otherwise fail for the person who paid.
//
// Nothing here is Cinder-specific by design. A second mattOS product wires its
// own capability names and its own gate; none of the checking code changes.

import { denyAll } from './capabilities.mjs';

export const gate = denyAll;
