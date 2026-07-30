import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// Field notes carry no secrets — they exist to be read, indexed, and cited.
// Prerender them so they are fast and so a crawler that runs no JavaScript
// still sees the whole argument.
export const prerender = true;
export const ssr = true;

// docs/field-notes/render.py's module comment is the JSON contract this
// route consumes, and it IS the interface — this route never imports
// render.py or note_contract.py, only their committed output.
//
// The six top-level fields are RAW, unescaped text — bound as {text} in
// +page.svelte, never {@html}. Every block already carries html.escape()'d,
// inline()-processed markup and is safe for {@html}.
type NoteBlock =
	| { kind: 'heading'; level: 1 | 2 | 3; html: string }
	| { kind: 'paragraph'; html: string }
	| { kind: 'meta'; key: string; value: string }
	| { kind: 'coda'; html: string }
	| { kind: 'rule' }
	| { kind: 'table'; header: string[]; rows: string[][] }
	| { kind: 'code'; lines: string[] };

export type NoteJson = {
	number: string;
	title: string;
	date: string;
	gate: string;
	verdict: string;
	vote: string;
	blocks: NoteBlock[];
};

// Same JSON glob the index route runs, so both routes read the identical
// committed artifact and neither can drift from a second copy of "which
// notes exist."
const noteModules = import.meta.glob<{ default: NoteJson }>('../../../../docs/field-notes/*.json', {
	eager: true
});

// The committed JSON carries only `number` ("001") — the descriptive slug
// this route is addressed by lives in the markdown SOURCE filename
// (note_contract.py: "the sole place that slug convention is defined" is
// that filename's stem, numeric prefix stripped). This second glob reads
// only file NAMES, never markdown content, to recover it. `?raw` (the same
// treatment src/lib/claims.test.ts already uses for this directory) is
// required, not cosmetic: without it Vite treats the matched .md files as
// JS modules to parse, and prose is not JS.
const noteSourceFiles = import.meta.glob('../../../../docs/field-notes/[0-9]*.md', {
	query: '?raw',
	import: 'default'
});
const sourceStems = Object.keys(noteSourceFiles).map((path) => path.split('/').pop()!.replace(/\.md$/, ''));

const notesBySlug = new Map(
	Object.values(noteModules).map((mod) => {
		const note = mod.default;
		// Every published note has a matching markdown source by
		// construction — render.py refuses to emit a JSON artifact for one
		// that doesn't first pass note_contract.validate() — so this lookup
		// cannot come back empty.
		const stem = sourceStems.find((s) => s.startsWith(`${note.number}-`))!;
		const slug = stem.slice(stem.indexOf('-') + 1);
		return [slug, note] as const;
	})
);

// adapter-static cannot discover a dynamic route segment on its own — every
// slug the static build should prerender has to be enumerated here.
export const entries = () => Array.from(notesBySlug.keys()).map((slug) => ({ slug }));

export const load: PageLoad = ({ params }) => {
	const note = notesBySlug.get(params.slug);
	if (!note) error(404, 'no such field note');
	return { note, slug: params.slug };
};
