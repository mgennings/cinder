import { describe, expect, it } from 'vitest';
import readme from '../../README.md?raw';

const renderedSurfaces = import.meta.glob<string>(
	['../app.html', '../**/*.svelte', '../../static/**/*.{txt,webmanifest}'],
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
	/self-destructs? the moment (?:it(?:'s| is) )?read/i
];

describe('destruction claims', () => {
	it('rejects universal destruction promises across tracked public surfaces', () => {
		for (const [name, copy] of Object.entries(publicSurfaces)) {
			for (const claim of universalDestructionClaims) {
				expect(copy, `${name} must keep destruction inside Cinder’s server boundary`).not.toMatch(claim);
			}
		}
	});

	it('states the verified boundary and captured-copy limit', () => {
		const llms = publicSurfaces['../../static/llms.txt'];

		expect(readme).toMatch(/atomically removes Cinder['’]s stored copy/i);
		expect(readme).toMatch(/cannot erase copies someone already captured/i);
		expect(llms).toMatch(/fetches nothing until (?:a human|someone) clicks reveal/i);
	});
});
