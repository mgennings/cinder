<script lang="ts">
	// A claim and its explanation. Used wherever the product argues in public —
	// the security page, the account page, the field notes. Heading level is a
	// prop because the same card sits under an h2 on one page and an h3 on
	// another, and a skipped level is a real navigation defect for a screen
	// reader.
	import Card from '../atoms/Card.svelte';

	let {
		title,
		body,
		bodyIsHtml = false,
		level = 3,
		class: extra = 'p-4'
	}: {
		title: string;
		body: string;
		/** Opt in ONLY when `body` is already escaped/sanitized markup — a
		 * field note's blocks[] content qualifies by construction
		 * (docs/field-notes/render.py's inline() escapes first, then applies
		 * markup). Plain prose, including any of a note's raw top-level
		 * fields, never does. Defaults off so both existing callers
		 * (TruthList, security/+page.svelte) render exactly as before. */
		bodyIsHtml?: boolean;
		level?: 3 | 4;
		class?: string;
	} = $props();
</script>

<Card class={extra}>
	<svelte:element this={`h${level}`} class={level === 3 ? 'font-medium text-body' : 'text-sm font-medium text-body'}>
		{title}
	</svelte:element>
	{#if bodyIsHtml}
		<p class="mt-1 text-sm leading-relaxed text-mist">{@html body}</p>
	{:else}
		<p class="mt-1 text-sm leading-relaxed text-mist">{body}</p>
	{/if}
</Card>
