<script lang="ts">
	import BenchPage from '$lib/ui/templates/BenchPage.svelte';
	import Button from '$lib/ui/atoms/Button.svelte';
	import Card from '$lib/ui/atoms/Card.svelte';
	import QuietLink from '$lib/ui/atoms/QuietLink.svelte';
	import RuleHead from '$lib/ui/atoms/RuleHead.svelte';
	import Record from '$lib/ui/molecules/Record.svelte';
	import RecordRow from '$lib/ui/molecules/RecordRow.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	// $derived, not a plain const: SvelteKit can reuse this component across
	// a client-side navigation between two different note slugs (true the
	// moment a second note ships), and a plain capture of `data.note` would
	// freeze on whichever note first mounted the page.
	const note = $derived(data.note);

	// ── blocks[] -> the design system ──────────────────────────────────────
	//
	// Every block already carries html.escape()'d, inline()-processed markup
	// (docs/field-notes/render.py) and is safe to bind with {@html}. `note`'s
	// six top-level fields (title, date, gate, verdict, vote, number) are the
	// opposite: RAW, unescaped text. They are bound below and in
	// <svelte:head> as {text} only — never {@html} a top-level field, per
	// render.py's module comment, which is the entire reason this boundary
	// exists.
	//
	// Where a block's html lands depends on the receiving prop's type. A
	// Snippet-typed child slot (RuleHead, RecordRow) can hold a bare {@html}
	// node. A plain-string prop cannot render markup at all — it prints the
	// tags as literal text — so anywhere a block's text has to sit in a
	// STRING prop (a RecordRow label, a claim's title) runs through
	// stripHtml first. Today's note carries no markup in any label or claim
	// title, but a future note's table header might, and this keeps that
	// case correct instead of showing raw <code> tags on the page.
	function stripHtml(value: string): string {
		return value.replace(/<[^>]+>/g, '');
	}

	// One line per rendered thing on the page, already grouped the way the
	// template below expects: consecutive `meta` blocks become one Record,
	// and every other block becomes exactly one group.
	type Group =
		| { type: 'title'; html: string }
		| { type: 'meta'; rows: { label: string; html: string }[] }
		| { type: 'section'; html: string }
		| { type: 'subsection'; html: string }
		| { type: 'paragraph'; html: string; dense: boolean }
		| { type: 'coda'; html: string }
		| { type: 'rule' }
		| { type: 'readout'; rows: { label: string; html: string }[] }
		| { type: 'claims'; rows: { title: string; html: string }[] }
		| { type: 'code'; text: string };

	// docs/field-notes/note_contract.py's TECHNICAL_HALF_HEADING is the
	// canonical marker for where the technical half begins. Matched here
	// against the same literal text — lowercased, tags stripped — because
	// this route has no way to import a Python constant; note_contract.py
	// remains the one place that string is defined.
	const TECHNICAL_HALF_HEADING = 'the technical record';

	const groups: Group[] = $derived.by(() => {
		const out: Group[] = [];
		let pendingMeta: { label: string; html: string }[] = [];
		let dense = false;

		const flushMeta = () => {
			if (pendingMeta.length) {
				out.push({ type: 'meta', rows: pendingMeta });
				pendingMeta = [];
			}
		};

		for (const block of note.blocks) {
			if (block.kind === 'meta') {
				pendingMeta.push({ label: stripHtml(block.key), html: block.value });
				continue;
			}
			flushMeta();

			switch (block.kind) {
				case 'heading':
					if (block.level === 1) {
						out.push({ type: 'title', html: block.html });
					} else if (block.level === 2) {
						if (stripHtml(block.html).trim().toLowerCase() === TECHNICAL_HALF_HEADING) dense = true;
						out.push({ type: 'section', html: block.html });
					} else {
						out.push({ type: 'subsection', html: block.html });
					}
					break;
				case 'paragraph':
					out.push({ type: 'paragraph', html: block.html, dense });
					break;
				case 'coda':
					out.push({ type: 'coda', html: block.html });
					break;
				case 'rule':
					out.push({ type: 'rule' });
					break;
				case 'code':
					out.push({ type: 'code', text: block.lines.join('\n') });
					break;
				case 'table': {
					// A "Claim / Reality" table is the field-notes house
					// convention for a claim that did not survive review
					// (docs/field-notes/README.md). Anything else is a plain
					// measured readout. Matched by header text — the only
					// signal a block carries — so a future note's tables
					// route the same way without a per-note special case.
					const isClaims =
						block.header.length === 2 &&
						stripHtml(block.header[0]).trim().toLowerCase() === 'claim' &&
						stripHtml(block.header[1]).trim().toLowerCase() === 'reality';
					if (isClaims) {
						out.push({
							type: 'claims',
							rows: block.rows.map((row) => ({ title: stripHtml(row[0]), html: row[1] }))
						});
					} else {
						out.push({
							type: 'readout',
							rows: block.rows.map((row) => ({ label: stripHtml(row[0]), html: row[1] }))
						});
					}
					break;
				}
			}
		}
		flushMeta();
		return out;
	});

	// No separate `description` field exists in the JSON contract — the
	// hand-authored page's curated summary sentence has no equivalent here.
	// Rather than invent new prose (which would reintroduce a second,
	// hand-written source for the note's argument), the gate and verdict —
	// both raw, both already true — stand in for it.
	const description = $derived(`${note.gate} — ${note.verdict}`);
	const url = $derived(`https://cinder.ink/field-notes/${note.number}`);
</script>

<svelte:head>
	<title>{note.title} · Cinder</title>
	<link rel="canonical" href={url} />
	<meta property="og:url" content={url} />
	<meta name="description" content={description} />
	<meta property="og:description" content={description} />
	<meta name="twitter:description" content={description} />
</svelte:head>

<BenchPage>
	<QuietLink href="/field-notes" class="mt-8">&larr; All field notes</QuietLink>

	{#each groups as group, i (i)}
		{#if group.type === 'title'}
			<h1 class="mt-4 text-3xl font-bold tracking-tight">{@html group.html}</h1>
		{:else if group.type === 'meta'}
			<Record class="mt-7">
				{#each group.rows as row (row.label)}
					<RecordRow label={row.label}>{@html row.html}</RecordRow>
				{/each}
			</Record>
		{:else if group.type === 'section'}
			<RuleHead class="mt-12">{@html group.html}</RuleHead>
		{:else if group.type === 'subsection'}
			<h3 class="mt-8 font-medium text-body">{@html group.html}</h3>
		{:else if group.type === 'paragraph'}
			<p
				class={group.dense
					? 'mt-3 text-sm leading-relaxed text-mist'
					: 'mt-4 text-[15px] leading-relaxed text-mist'}
			>
				{@html group.html}
			</p>
		{:else if group.type === 'coda'}
			<p class="mt-8 border-l-2 border-ember pl-4 text-sm leading-relaxed text-ghost">
				{@html group.html}
			</p>
		{:else if group.type === 'rule'}
			<hr class="mt-12 border-line" />
		{:else if group.type === 'readout'}
			<Record class="mt-3">
				{#each group.rows as row (row.label)}
					<RecordRow label={row.label} stacked class="text-mist">{@html row.html}</RecordRow>
				{/each}
			</Record>
		{:else if group.type === 'claims'}
			<div class="mt-3 space-y-3">
				{#each group.rows as row (row.title)}
					<Card class="p-4">
						<h4 class="text-sm font-medium text-body">{row.title}</h4>
						<p class="mt-1 text-sm leading-relaxed text-mist">{@html row.html}</p>
					</Card>
				{/each}
			</div>
		{:else if group.type === 'code'}
			<pre
				class="field mt-3 overflow-x-auto px-4 py-3 font-mono text-[12px] leading-relaxed text-ember-ink">{@html group.text}</pre>
		{/if}
	{/each}

	<div class="mt-10 flex flex-wrap gap-3">
		<Button href="/security" class="px-5 py-2.5 text-sm">How private is this, really?</Button>
		<Button href="/" class="px-5 py-2.5 text-sm">Send something</Button>
	</div>
</BenchPage>
