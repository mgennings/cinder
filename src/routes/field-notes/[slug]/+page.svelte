<script lang="ts">
	import FieldNoteReader from '$lib/field-notes/FieldNoteReader.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	// SvelteKit can reuse this shell when navigation moves between note slugs.
	const note = $derived(data.note);
	const slug = $derived(data.slug);
	// The source contract has no separate summary. Reuse its verified gate and
	// verdict instead of creating a second hand-written description to drift.
	const description = $derived(`${note.gate}. ${note.verdict}`);
	const url = $derived(`https://cinder.ink/field-notes/${slug}`);
</script>

<svelte:head>
	<title>{note.title} · Cinder</title>
	<link rel="canonical" href={url} />
	<meta property="og:url" content={url} />
	<meta name="description" content={description} />
	<meta property="og:description" content={description} />
	<meta name="twitter:description" content={description} />
</svelte:head>

<FieldNoteReader {note} />
