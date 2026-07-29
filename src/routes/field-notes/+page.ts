import type { PageLoad } from './$types';

// Field notes carry no secrets — they exist to be read, indexed, and cited.
// Prerender them so they are fast and so a crawler that runs no JavaScript
// still sees the whole argument.
export const prerender = true;
export const ssr = true;

// docs/field-notes/render.py's module comment is the JSON contract every
// note ships: six RAW, unescaped top-level fields (bound as {text} in
// +page.svelte, never {@html}) plus a `blocks[]` array of pre-rendered,
// html.escape()'d markup. This route only needs the six top-level fields —
// the argument itself is a [slug] concern.
type NoteSummary = {
	number: string;
	title: string;
	date: string;
	gate: string;
	verdict: string;
};

// One note's committed docs/field-notes/{number}.json is the SAME artifact
// [slug]/+page.ts reads to render the note itself. This index reads every
// one of them rather than hand-maintaining a second list of notes, so a
// future note earns a row here the moment render.py commits its JSON, with
// nothing in this file to update.
const noteModules = import.meta.glob<{ default: NoteSummary }>('../../../docs/field-notes/*.json', {
	eager: true
});

// The committed JSON carries only `number` ("001") — the descriptive slug
// each note's link is built from lives in the markdown SOURCE filename
// (note_contract.py: "the sole place that slug convention is defined" is
// that filename's stem, numeric prefix stripped). This second glob reads
// only file NAMES, never markdown content, to recover it. `?raw` (the same
// treatment src/lib/claims.test.ts already uses for this directory) is
// required, not cosmetic: without it Vite treats the matched .md files as
// JS modules to parse, and prose is not JS.
const noteSourceFiles = import.meta.glob('../../../docs/field-notes/[0-9]*.md', {
	query: '?raw',
	import: 'default'
});
const slugsByNumber = new Map<string, string>();
for (const path of Object.keys(noteSourceFiles)) {
	const stem = path.split('/').pop()!.replace(/\.md$/, '');
	const dash = stem.indexOf('-');
	slugsByNumber.set(stem.slice(0, dash), stem.slice(dash + 1));
}

export type NoteListing = NoteSummary & { slug: string };

// Oldest first. Notes are numbered in the order they were written, and note
// 001 — today's only note, and the exact page every existing inbound link
// still points at — belongs at the top of the list regardless of how many
// more ship later. `number` stays on the returned shape (the index still
// displays it, as part of each note's own title text); `slug` is what the
// "Read the note" link is built from.
const notes: NoteListing[] = Object.values(noteModules)
	.map((mod) => mod.default)
	.sort((a, b) => Number(a.number) - Number(b.number))
	.map((note) => ({
		...note,
		// See the comment above notesBySlug in [slug]/+page.ts — the same
		// invariant holds here.
		slug: slugsByNumber.get(note.number)!
	}));

export const load: PageLoad = () => {
	return { notes };
};
