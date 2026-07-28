import { describe, expect, it } from 'vitest';
import readme from '../../README.md?raw';

// `docs/**` is in this glob because the docs ARE a public surface — they are
// linked from the README and from llms.txt, and an overclaim there is read by
// exactly the people most likely to rely on it.
//
// `docs/superpowers/**` is excluded: those are internal implementation plans,
// and they quote the forbidden phrasings verbatim in order to forbid them.
// Scanning them would fail the build for saying the right thing.
const renderedSurfaces = import.meta.glob<string>(
	[
		'../app.html',
		'../**/*.svelte',
		'../../static/**/*.{txt,webmanifest}',
		'../../docs/**/*.md',
		'!../../docs/superpowers/**'
	],
	{ eager: true, query: '?raw', import: 'default' }
);

const publicSurfaces: Record<string, string> = {
	...renderedSurfaces,
	'../../README.md': readme
};

const universalDestructionClaims = [
	/permanently, from everywhere/i,
	/gone forever/i,
	/impossible to recover/i,
	/read(?:s)? (?:it |the note )?once,? then (?:it(?:'s| is) )?gone/i,
	/fetching (?:a |the )?note link destroys the note/i,
	/opening (?:it|the note) destroys (?:it|the note)/i,
	/self-destructs? the moment (?:it(?:'s| is) )?read/i,

	// File-transfer vocabulary. Cinder controls one server delivery ATTEMPT: it
	// cannot know who holds a link, and it cannot know whether bytes it sent
	// ever arrived. Each pattern below promises something no server can observe.
	//
	// These match only AFFIRMATIVE promises. An earlier draft matched the bare
	// phrases and immediately failed on "Not one recipient, not one download" —
	// the honest disclaimer — because a phrase match cannot tell a claim from
	// its negation. Requiring a promising verb is what makes the guard usable:
	// it still catches "Cinder guarantees one recipient" and stays quiet when
	// the docs explain why that would be a lie.
	/\b(?:promises?|guarantees?|ensures?|means)\s+(?:exactly\s+|only\s+)?one\s+(?:recipient|download|reader)\b/i,
	/\bguarantees?\s+(?:a\s+)?successful\s+(?:download|delivery)\b/i,
	/\bcan be retried\b/i,
	/\b(?:deleted|erased|destroyed)\s+(?:from\s+)?everywhere\b/i
];

// The reveal screen's warning is approved copy: it is the last thing a person
// reads before an irreversible action, and every clause is enforced by the
// backend. Pinning it exactly means a well-meaning edit that softens it fails
// the build instead of shipping.
const APPROVED_REVEAL_WARNING =
	"Exactly one server delivery can begin. Cinder deletes its encrypted stored copy before " +
	"releasing bytes. If that delivery fails, the file is permanently unavailable. Copies " +
	"saved by the sender, recipient, browser, operating system, or another service remain " +
	"outside Cinder's control.";

// Markup wraps prose across lines; compare the words, not the indentation.
const flatten = (s: string) => s.replace(/\s+/g, ' ');

describe('destruction claims', () => {
	it('rejects universal destruction promises across tracked public surfaces', () => {
		for (const [name, copy] of Object.entries(publicSurfaces)) {
			for (const claim of universalDestructionClaims) {
				expect(copy, `${name} must keep destruction inside Cinder’s server boundary`).not.toMatch(claim);
			}
		}
	});

	it('keeps the approved irreversible-reveal warning exactly as approved', () => {
		// Pinned to the component that renders the gate rather than to the route,
		// because the warning now lives one level down. The guard is about the words
		// reaching a person, not about which file holds them — but it still names ONE
		// file, so deleting the warning cannot be hidden by moving it somewhere else.
		const gate = publicSurfaces['./ui/organisms/RevealGate.svelte'];
		expect(gate, 'the reveal gate must exist').toBeTruthy();
		expect(flatten(gate)).toContain(APPROVED_REVEAL_WARNING);
	});

	it('names the delivery promise as an attempt, on every file surface', () => {
		for (const name of ['../../static/llms.txt', '../routes/security/+page.svelte']) {
			expect(flatten(publicSurfaces[name]), `${name} must scope the file promise`).toMatch(
				/one server delivery attempt/i
			);
		}
	});

	it('states the verified boundary and captured-copy limit', () => {
		const llms = publicSurfaces['../../static/llms.txt'];

		expect(readme).toMatch(/atomically removes Cinder['’]s stored copy/i);
		expect(readme).toMatch(/cannot erase copies someone already captured/i);
		expect(llms).toMatch(/fetches nothing until (?:a human|someone) clicks reveal/i);
	});
});
