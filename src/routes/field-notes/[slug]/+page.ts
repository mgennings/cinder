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

// Same glob the index route runs, so both routes read the identical
// committed artifact and neither can drift from a second copy of "which
// notes exist."
const noteModules = import.meta.glob<{ default: NoteJson }>('../../../../docs/field-notes/*.json', {
	eager: true
});

const notesByNumber = new Map(Object.values(noteModules).map((mod) => [mod.default.number, mod.default]));

// adapter-static cannot discover a dynamic route segment on its own — every
// slug the static build should prerender has to be enumerated here.
export const entries = () => Array.from(notesByNumber.keys()).map((slug) => ({ slug }));

export const load: PageLoad = ({ params }) => {
	const note = notesByNumber.get(params.slug);
	if (!note) error(404, 'no such field note');
	return { note };
};
