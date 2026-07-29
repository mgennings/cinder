<script lang="ts">
	// THE INDEX. Was note 001's own page until it moved to /field-notes/001 —
	// https://cinder.ink/field-notes is a live, externally linked URL
	// (uxuiai/src/data/products.js), so note 001 stays the first and most
	// prominent entry here: an old inbound link has to land on a page that
	// obviously contains what it came for.
	import BenchPage from '$lib/ui/templates/BenchPage.svelte';
	import Button from '$lib/ui/atoms/Button.svelte';
	import Card from '$lib/ui/atoms/Card.svelte';
	import Record from '$lib/ui/molecules/Record.svelte';
	import RecordRow from '$lib/ui/molecules/RecordRow.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Sourced verbatim from docs/field-notes/README.md's own opening two
	// sentences rather than hand-authored a second time. Keep these in sync
	// if that file's wording ever changes.
	const DESCRIPTION =
		'Decision gates, written down after the fact, in enough detail that someone outside this repo can use them.';
	const CONTEXT =
		'A field note is not a changelog entry — it exists when a choice was genuinely hard, when the measurement that settled it is worth showing, or when the honest answer cost something.';
</script>

<svelte:head>
	<title>Field notes · Cinder</title>
	<link rel="canonical" href="https://cinder.ink/field-notes" />
	<meta property="og:url" content="https://cinder.ink/field-notes" />
	<meta name="description" content={DESCRIPTION} />
	<meta property="og:description" content={DESCRIPTION} />
	<meta name="twitter:description" content={DESCRIPTION} />
</svelte:head>

<BenchPage>
	<h1 class="mt-8 text-2xl font-bold">Field notes</h1>
	<p class="mt-3 leading-relaxed text-mist">{DESCRIPTION} {CONTEXT}</p>

	<div class="mt-10 space-y-4">
		{#each data.notes as note (note.number)}
			<Card as="section" class="p-5">
				<p class="util">{note.gate}</p>
				<h2 class="mt-2 text-xl font-semibold text-body">{note.title}</h2>
				<Record class="mt-4">
					<RecordRow label="Date">{note.date}</RecordRow>
					<RecordRow label="Verdict" stacked class="text-mist">{note.verdict}</RecordRow>
				</Record>
				<Button href="/field-notes/{note.number}" class="mt-4 px-4 py-2 text-sm"
					>Read the note</Button
				>
			</Card>
		{/each}
	</div>
</BenchPage>
