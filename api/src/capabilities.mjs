// The capability gate. Deliberately knows nothing about Cinder, and structurally
// cannot know who is asking.
//
// A handler asks one question — "is the bearer of this grant entitled to this
// capability, and within what limits?" — and gets back a decision. It never asks
// who the caller is, what they bought, or which product they are using.
//
// The signature is the security property, not a style choice. `check` is handed
// a grant string and a capability name and NOTHING ELSE: no event, no headers,
// no source address. That matters here more than it would in most products,
// because api/src/entitlement.mjs deliberately puts identity on a SEPARATE HTTP
// API, and template.yaml's CorsConfiguration on the transfer API allows only
// `content-type` — a browser cannot attach an Authorization header to a
// /files request even by accident. An account is never linkable to a transfer.
// A gate handed the raw event could quietly undo all of that by reaching for a
// header, an IP, or a user agent. It is not handed the raw event.
//
// So the grant travels in the request BODY, is presented by the sender, and says
// what the bearer may do rather than who the bearer is. A grant is a bearer
// token for a capability, and it should carry no subject at all.
//
// Nothing in this file talks to Stripe, Cognito, a database, or a network. It
// defines the contract and the fail-closed default, and that is all it will ever
// do. The lane that owns payments and identity implements `check`.

/** Capability names are namespaced strings, never booleans named after a plan. */
export const CAPABILITY = {
	// Create a transfer made of more than one independently claimed envelope.
	MULTIPART_TRANSFER: 'transfer.multipart'
};

/**
 * @typedef {object} CapabilityDecision
 * @property {boolean} granted
 * @property {Record<string, number>} [limits] Numeric ceilings the grantor imposes,
 *   e.g. `{ maxParts: 64 }`. A handler MUST treat a missing limit as zero rather
 *   than as unlimited.
 */

/**
 * @typedef {object} CapabilityGate
 * @property {(req: { grant: string|null, capability: string }) => Promise<CapabilityDecision>} check
 */

// The default that ships until an entitlement provider is wired in, and the
// default any misconfiguration falls back to. Denying is the only safe answer:
// a gate that fails open is not a gate, it is a delay.
export const denyAll = {
	async check() {
		return { granted: false, limits: {} };
	}
};

// Reads a decision defensively. A provider is foreign code as far as this
// transport is concerned — it can return undefined, throw, or hand back a limit
// that is a string, and none of those may become an accidental grant.
export async function checkCapability(gate, grant, capability, limitName) {
	let decision;
	try {
		decision = await gate.check({
			// Normalized here so a provider never has to decide what a missing
			// grant looks like, and never receives a non-string to parse.
			grant: typeof grant === 'string' && grant.length > 0 ? grant : null,
			capability
		});
	} catch {
		// A provider that is down is not a provider that said yes.
		return { granted: false, limit: 0 };
	}
	if (!decision || decision.granted !== true) return { granted: false, limit: 0 };

	const raw = decision.limits?.[limitName];
	const limit = Number.isInteger(raw) && raw > 0 ? raw : 0;
	return { granted: true, limit };
}
